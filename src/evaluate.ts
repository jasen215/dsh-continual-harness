/**
 * Isolated benchmark evaluation: per-cell executor and reviewer LLM calls over
 * an injected completion seam (defaulting to `ctx.llm.stream` routing with the
 * input provider/model), strict evidence/score parsing, and failure conversion
 * into failed cells. The evaluator never touches the harness store, projection,
 * usage telemetry, skill files, or the audit gate — it reads only the captured
 * snapshot it is given and writes nothing.
 *
 * `CellEvaluation` (this module) is the evaluation-stage outcome: everything
 * `src/score.ts` needs to build a persisted `CellScore` (kept in `src/benchmark.ts`
 * as the domain record) plus the executor evidence the run record must store.
 * It lives here, next to the evaluator that produces it, rather than in
 * `benchmark.ts`, which owns the persisted record shapes.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BenchmarkCase, CellScore, ExecutorEvidence, HarnessSnapshot } from './benchmark.ts'
import { hashBenchmarkCase } from './benchmark.ts'
import { completeViaModel } from './complete.ts'
import type { Complete } from './planner.ts'
import { extractJsonObject } from './planner.ts'
import { overviewForPrompt } from './render.ts'

/** Default output budget for one evaluator call. */
export const DEFAULT_EVALUATION_MAX_TOKENS = 8_000
/** Default per-phase timeout for one evaluator call. */
export const DEFAULT_EVALUATION_TIMEOUT_MS = 60_000

/** The documented executor evidence fields; anything else is rejected. */
const EXECUTOR_EVIDENCE_FIELDS: readonly string[] = ['completed', 'summary', 'actions', 'observations', 'artifacts']

/**
 * Stable evaluation failure vocabulary. These describe failures that happen
 * while producing or parsing a cell — distinct from the domain
 * `CellScoreFailureReason` in `src/benchmark.ts`, which validates an
 * already-built `CellScore` record. `CellScore.failureReason` is a plain
 * string, so these values flow through unchanged into the persisted record.
 */
export type EvaluationFailureReason =
  | 'provider-error'
  | 'aborted'
  | 'timeout'
  | 'malformed-executor-json'
  | 'malformed-reviewer-json'
  | 'invalid-reviewer-score'
  | 'empty-reviewer-feedback'

/** Per-cell evaluation input: the run identity plus one frozen case/snapshot pair. */
export interface CellEvaluationInput {
  runId: string
  side: 'reference' | 'candidate'
  iteration: number
  /** Must be a frozen case; its material hash is stamped into the cell. */
  benchmarkCase: BenchmarkCase
  /** The read-only snapshot this side evaluates against. */
  snapshot: HarnessSnapshot
  provider: string
  model: string
}

/** Evaluation call options; tests inject `complete` to stay hermetic. */
export interface CellEvaluationOptions {
  /** Completion seam; defaults to `ctx.llm.stream` routing with the input provider/model. */
  complete?: Complete
  /** Abort signal honored by both phases. */
  signal?: AbortSignal
  /** Per-phase timeout in milliseconds. */
  timeoutMs?: number
}

/** The reviewer's structured verdict. */
export interface ReviewerScore {
  score: number
  feedback: string
}

/**
 * The evaluation-stage outcome of one cell: the persisted `CellScore` fields
 * (see `src/benchmark.ts`) plus the executor evidence the run record must
 * store. A failed cell carries `score: null` (never 0) and a stable
 * `failureReason`. It lives here, next to the evaluator that produces it,
 * rather than in `benchmark.ts`, which owns the persisted record shapes.
 */
export interface CellEvaluation extends CellScore {
  /** Executor evidence; `null` when the executor phase itself failed. */
  evidence: ExecutorEvidence | null
}

/** System prompt for the executor phase; deliberately contains no rubric. */
export const EXECUTOR_SYSTEM_PROMPT = `You are the executor of a benchmark cell. Complete the statement against the harness state overview, then report structured evidence of what you did.

You only see the statement and the harness state — no scoring rubric.

Respond with ONLY a JSON object:
{"completed":true|false,"summary":"one line","actions":["..."],"observations":["..."],"artifacts":[{"name":"...","content":"..."}]}`

/** System prompt for the reviewer phase. */
export const REVIEWER_SYSTEM_PROMPT = `You are the reviewer of one benchmark cell. Given the statement, the rubric, and the executor's evidence, score the executor's completion on a 0..100 scale and give one concrete piece of actionable feedback.

Respond with ONLY a JSON object:
{"score":82,"feedback":"specific improvement"}`

/** Build the executor prompt: the case statement plus a snapshot-derived overview ONLY. */
export function buildExecutorPrompt(benchmarkCase: BenchmarkCase, snapshot: HarnessSnapshot): string {
  return [
    '# Benchmark case',
    benchmarkCase.statement,
    '',
    '# Harness state overview (captured snapshot)',
    overviewForPrompt(snapshot.state),
  ].join('\n')
}

/** Build the reviewer prompt: the statement, the rubric, and this cell's executor evidence ONLY. */
export function buildReviewerPrompt(benchmarkCase: BenchmarkCase, evidence: ExecutorEvidence): string {
  return [
    '# Benchmark case',
    benchmarkCase.statement,
    '',
    '# Rubric',
    benchmarkCase.rubric,
    '',
    '# Executor evidence',
    JSON.stringify(evidence, null, 2),
  ].join('\n')
}

/** Parse the reviewer verdict: a finite score in 0..100 and non-empty feedback. */
export function parseReviewerScore(text: string): ReviewerScore {
  const object = parseJsonObject(text)
  const score = object.score
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new ReviewerParseError('invalid-reviewer-score', 'reviewer score must be a finite number')
  }
  if (score < 0 || score > 100) {
    throw new ReviewerParseError('invalid-reviewer-score', `reviewer score out of range: ${score}`)
  }
  if (typeof object.feedback !== 'string' || object.feedback.trim() === '') {
    throw new ReviewerParseError('empty-reviewer-feedback', 'reviewer feedback must be a non-empty string')
  }
  return { score, feedback: object.feedback.trim() }
}

/** Parse executor output strictly: exactly the documented evidence fields, unknown fields rejected. */
export function parseExecutorEvidence(text: string): ExecutorEvidence {
  const object = parseJsonObject(text)
  for (const key of Object.keys(object)) {
    if (!EXECUTOR_EVIDENCE_FIELDS.includes(key)) {
      throw new Error(`unexpected executor evidence field: ${key}`)
    }
  }
  if (typeof object.completed !== 'boolean') throw new Error('executor evidence completed must be a boolean')
  if (typeof object.summary !== 'string') throw new Error('executor evidence summary must be a string')
  if (!isStringArray(object.actions)) throw new Error('executor evidence actions must be a string array')
  if (!isStringArray(object.observations)) throw new Error('executor evidence observations must be a string array')
  if (object.artifacts !== undefined) {
    if (!Array.isArray(object.artifacts) || !object.artifacts.every(isArtifact)) {
      throw new Error('executor evidence artifacts must be an array of {name, content}')
    }
  }
  return {
    completed: object.completed,
    summary: object.summary,
    actions: object.actions,
    observations: object.observations,
    ...(object.artifacts !== undefined ? { artifacts: object.artifacts } : {}),
  }
}

/**
 * Evaluate one cell: the executor completes the case against the snapshot and
 * produces evidence, then the reviewer scores that evidence against the rubric.
 * Provider errors, aborts, malformed JSON, and timeouts all convert into
 * `status: 'failed'`, `score: null` cells with stable failure reasons.
 *
 * Precondition: `input.benchmarkCase` must be frozen — its material hash is
 * stamped into the cell via `hashBenchmarkCase`, which rejects drafts. Callers
 * validate frozen state before evaluation (the `run` action in `src/tool.ts`).
 */
export async function runCellEvaluation(
  ctx: Context,
  input: CellEvaluationInput,
  options: CellEvaluationOptions = {},
): Promise<CellEvaluation> {
  const complete = options.complete ?? completeViaModel(ctx, input.provider, input.model, DEFAULT_EVALUATION_MAX_TOKENS)
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS
  const startedAt = Date.now()
  const recordedAt = new Date().toISOString()
  const base = {
    runId: input.runId,
    side: input.side,
    caseId: input.benchmarkCase.id,
    iteration: input.iteration,
    snapshotId: input.snapshot.snapshotId,
    stateHash: input.snapshot.stateHash,
    caseHash: hashBenchmarkCase(input.benchmarkCase),
    executorProvider: input.provider,
    executorModel: input.model,
    reviewerProvider: input.provider,
    reviewerModel: input.model,
    recordedAt,
  }

  // A phase timeout must cancel the underlying completion call, not just stop
  // waiting on it — otherwise an orphaned `llm.stream` keeps running. The
  // internal controller forwards the caller's signal and is aborted on timeout.
  const controller = new AbortController()
  const callerSignal = options.signal
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const callSignal = controller.signal

  let executorText: string
  try {
    executorText = await raceWithTimeout(
      complete(EXECUTOR_SYSTEM_PROMPT, buildExecutorPrompt(input.benchmarkCase, input.snapshot), callSignal),
      timeoutMs,
      callerSignal,
      () => controller.abort(),
    )
  } catch (error) {
    return failedCell(base, null, failureReasonFor(error, callerSignal), startedAt)
  }

  let evidence: ExecutorEvidence
  try {
    evidence = parseExecutorEvidence(executorText)
  } catch {
    return failedCell(base, null, 'malformed-executor-json', startedAt)
  }

  let reviewerText: string
  try {
    reviewerText = await raceWithTimeout(
      complete(REVIEWER_SYSTEM_PROMPT, buildReviewerPrompt(input.benchmarkCase, evidence), callSignal),
      timeoutMs,
      callerSignal,
      () => controller.abort(),
    )
  } catch (error) {
    return failedCell(base, evidence, failureReasonFor(error, callerSignal), startedAt)
  }

  let verdict: ReviewerScore
  try {
    verdict = parseReviewerScore(reviewerText)
  } catch (error) {
    const reason = error instanceof ReviewerParseError ? error.reason : 'malformed-reviewer-json'
    return failedCell(base, evidence, reason, startedAt)
  }

  return {
    ...base,
    status: 'ok',
    score: verdict.score,
    feedback: verdict.feedback,
    evidence,
    durationMs: Date.now() - startedAt,
  }
}

/** Marker error for a phase that exceeded its timeout budget. */
class EvaluationTimeoutError extends Error {
  override name = 'EvaluationTimeoutError'
}

/** Marker error for a phase cancelled by the caller's abort signal. */
class EvaluationAbortError extends Error {
  override name = 'EvaluationAbortError'
}

/** Reviewer output problem carrying its stable failure reason. */
class ReviewerParseError extends Error {
  constructor(
    readonly reason: 'invalid-reviewer-score' | 'empty-reviewer-feedback',
    message: string,
  ) {
    super(message)
  }
}

/** Map any completion-phase error onto the stable failure vocabulary. The
 * error type wins over the signal state: a phase timeout aborts the internal
 * controller (so `signal.aborted` is set) yet must still read as `timeout`. */
function failureReasonFor(error: unknown, signal: AbortSignal | undefined): EvaluationFailureReason {
  if (error instanceof EvaluationTimeoutError) return 'timeout'
  if (error instanceof EvaluationAbortError) return 'aborted'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  if (signal?.aborted) return 'aborted'
  return 'provider-error'
}

/** Race a promise against a per-phase timeout and the caller's abort signal.
 * When the timeout wins, `onTimeout` (if given) fires first so the caller can
 * cancel the underlying work before the rejection is observed. */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => settle(() => reject(new EvaluationAbortError()))
    const fireTimeout = (): void => {
      onTimeout?.()
      settle(() => reject(new EvaluationTimeoutError()))
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fail: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fail()
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(fireTimeout, timeoutMs)
    promise.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

/** Build a failed cell: score null, stable reason, timing stamped. */
function failedCell(
  base: Omit<CellEvaluation, 'status' | 'score' | 'evidence' | 'failureReason' | 'feedback' | 'durationMs'>,
  evidence: ExecutorEvidence | null,
  failureReason: EvaluationFailureReason,
  startedAt: number,
): CellEvaluation {
  return {
    ...base,
    status: 'failed',
    score: null,
    failureReason,
    evidence,
    durationMs: Date.now() - startedAt,
  }
}

/** Parse a JSON object reply, tolerating prose and code fences via the shared span extractor. */
function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(extractJsonObject(text))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the model reply is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isArtifact(value: unknown): value is { name: string; content: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  // spec §4.4 rejects unknown fields: an artifact allows exactly name + content
  const keys = Object.keys(artifact)
  if (keys.length !== 2 || !keys.includes('name') || !keys.includes('content')) return false
  return typeof artifact.name === 'string' && typeof artifact.content === 'string'
}
