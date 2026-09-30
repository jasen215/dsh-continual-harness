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
import { bridgeAbortSignal, PhaseAbortError, PhaseTimeoutError, raceWithTimeout } from './async-safe.ts'
import type { BenchmarkCase, BenchmarkCriterion, CellScore, ExecutorEvidence, HarnessSnapshot } from './benchmark.ts'
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

/** Hard caps on executor evidence size (spec 项 7): bounds run memory and runs.jsonl growth. */
export const MAX_EVIDENCE_ARTIFACTS = 20
export const MAX_EVIDENCE_TOTAL_BYTES = 256 * 1024
/** Cap on the retained executor-reply tail kept for failure diagnosis. */
export const MAX_FAILURE_DETAIL_TAIL = 300
/** Cap on the whole failure diagnostic, so a record can never grow unbounded. */
export const MAX_FAILURE_DETAIL = 600

/** Marker error: executor evidence exceeded the hard caps. */
export class EvidenceOverflowError extends Error {
  override name = 'EvidenceOverflowError'
}

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
  | 'invalid-reviewer-verdicts'
  | 'empty-reviewer-feedback'
  | 'evidence-overflow'

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
 * A criteria-based reviewer reply: one boolean per declared dimension plus
 * prose. The reviewer never produces the number — `scoreFromVerdicts` does.
 */
export interface ReviewerVerdicts extends ReviewerScore {
  verdicts: Array<{ id: string; met: boolean }>
}

/**
 * Weighted total of per-dimension verdicts, rounded to an integer:
 * `Σ weight·met / Σ weight · 100`. The store boundary validates the criteria as
 * non-empty with positive weights, so the divisor cannot be zero.
 */
export function scoreFromVerdicts(
  criteria: BenchmarkCriterion[],
  verdicts: Array<{ id: string; met: boolean }>,
): number {
  const met = new Set(verdicts.filter(verdict => verdict.met).map(verdict => verdict.id))
  let earned = 0
  let total = 0
  for (const criterion of criteria) {
    total += criterion.weight
    if (met.has(criterion.id)) earned += criterion.weight
  }
  return Math.round((earned / total) * 100)
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
export const REVIEWER_SYSTEM_PROMPT = `You are the reviewer of one benchmark cell. Judge the executor's evidence against the case's declared criteria and give one concrete piece of actionable feedback.

Never award a dimension the evidence does not show: require the evidence itself to prove it, not the executor's claim that it happened.

Respond with ONLY the JSON object described under "Required reply" — no prose and no code fences.`

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

/**
 * Build the reviewer prompt: the statement, then either the case's declared
 * criteria (authoritative, binary-scored) or its legacy free-form rubric, and
 * this cell's executor evidence ONLY. The required reply shape travels with the
 * criteria so the two cannot drift apart.
 */
export function buildReviewerPrompt(benchmarkCase: BenchmarkCase, evidence: ExecutorEvidence): string {
  const lines = ['# Benchmark case', benchmarkCase.statement, '']
  if (benchmarkCase.criteria === undefined) {
    lines.push(
      '# Rubric',
      benchmarkCase.rubric,
      '',
      '# Required reply',
      '{"score":82,"feedback":"specific improvement"}',
    )
  } else {
    lines.push(
      '# Criteria',
      'Answer every criterion with a boolean; the score is computed from your verdicts, so never produce a total yourself.',
      '',
    )
    for (const criterion of benchmarkCase.criteria) {
      lines.push(`## ${criterion.id} (weight ${criterion.weight})`, criterion.check, '')
    }
    lines.push(
      '# Required reply',
      '{"verdicts":[{"id":"<criterion id>","met":true|false}],"feedback":"specific improvement"}',
    )
  }
  lines.push('', '# Executor evidence', JSON.stringify(evidence, null, 2))
  return lines.join('\n')
}

/**
 * Parse a criteria-based reviewer reply. Every declared criterion must be
 * answered exactly once with a boolean: an unanswered dimension would otherwise
 * read as "not met" and depress the score invisibly, so it fails loudly instead
 * (never a silent default).
 */
export function parseReviewerVerdicts(text: string, criteria: BenchmarkCriterion[]): ReviewerVerdicts {
  const object = parseJsonObject(text)
  const raw = object.verdicts
  if (!Array.isArray(raw)) {
    throw new ReviewerParseError('invalid-reviewer-verdicts', 'reviewer verdicts must be an array')
  }
  const verdicts: Array<{ id: string; met: boolean }> = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ReviewerParseError('invalid-reviewer-verdicts', 'each verdict must be an object')
    }
    const { id, met } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof met !== 'boolean') {
      throw new ReviewerParseError('invalid-reviewer-verdicts', 'each verdict needs a string id and a boolean met')
    }
    if (seen.has(id)) {
      throw new ReviewerParseError('invalid-reviewer-verdicts', `duplicate verdict id: ${id}`)
    }
    seen.add(id)
    verdicts.push({ id, met })
  }
  for (const criterion of criteria) {
    if (!seen.has(criterion.id)) {
      throw new ReviewerParseError('invalid-reviewer-verdicts', `missing verdict for criterion: ${criterion.id}`)
    }
  }
  for (const verdict of verdicts) {
    if (!criteria.some(criterion => criterion.id === verdict.id)) {
      throw new ReviewerParseError('invalid-reviewer-verdicts', `unknown criterion id: ${verdict.id}`)
    }
  }
  if (typeof object.feedback !== 'string' || object.feedback.trim() === '') {
    throw new ReviewerParseError('empty-reviewer-feedback', 'reviewer feedback must be a non-empty string')
  }
  return {
    score: scoreFromVerdicts(criteria, verdicts),
    feedback: object.feedback.trim(),
    verdicts,
  }
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
  const artifacts = object.artifacts ?? []
  if (artifacts.length > MAX_EVIDENCE_ARTIFACTS) {
    throw new EvidenceOverflowError(`executor evidence artifacts exceed ${MAX_EVIDENCE_ARTIFACTS}`)
  }
  const totalBytes = artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.content, 'utf8'), 0)
  if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
    throw new EvidenceOverflowError(`executor evidence exceeds ${MAX_EVIDENCE_TOTAL_BYTES} bytes`)
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
 * An empty executor reply is retried once before it is recorded as a failure:
 * it is a lost observation rather than a judgement about the refinement, and
 * the acceptance-side sign test (n≥6 consistent pairs) pays for every lost
 * pair. A reply that is merely malformed is never retried.
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
  const unbridge = callerSignal === undefined ? undefined : bridgeAbortSignal(callerSignal, controller)
  const callSignal = controller.signal

  try {
    let executorText: string
    try {
      const runExecutor = () => raceWithTimeout(
        complete(EXECUTOR_SYSTEM_PROMPT, buildExecutorPrompt(input.benchmarkCase, input.snapshot), callSignal),
        timeoutMs,
        callerSignal,
        () => controller.abort(),
      )
      executorText = await runExecutor()
      // A provider can finish successfully yet yield nothing. Retry that once:
      // an empty reply is a lost observation, not evidence about the candidate,
      // and a lost pair is exactly the power the sign test cannot spare. Only
      // emptiness is retried — a malformed reply is a real parser verdict.
      if (executorText.trim() === '') executorText = await runExecutor()
    } catch (error) {
      return failedCell(base, null, failureReasonFor(error, callerSignal), startedAt)
    }

    let evidence: ExecutorEvidence
    try {
      evidence = parseExecutorEvidence(executorText)
    } catch (error) {
      // EvidenceOverflowError carries its own structured reason; every other
      // parser throw is malformed executor output. The detail below is what
      // makes the failure diagnosable after the run.
      return error instanceof EvidenceOverflowError
        ? failedCell(base, null, 'evidence-overflow', startedAt)
        : failedCell(base, null, 'malformed-executor-json', startedAt, describeMalformedReply(executorText, error))
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
      // Criteria-scored cases get their number from code, not from the
      // reviewer; cases without criteria keep the legacy single-score reply.
      verdict = input.benchmarkCase.criteria === undefined
        ? parseReviewerScore(reviewerText)
        : parseReviewerVerdicts(reviewerText, input.benchmarkCase.criteria)
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
  } finally {
    // The caller's signal outlives the cell: drop the forward listener.
    unbridge?.()
  }
}

/** Reviewer output problem carrying its stable failure reason. */
class ReviewerParseError extends Error {
  constructor(
    readonly reason: 'invalid-reviewer-score' | 'invalid-reviewer-verdicts' | 'empty-reviewer-feedback',
    message: string,
  ) {
    super(message)
  }
}

/** Map any completion-phase error onto the stable failure vocabulary. The
 * error type wins over the signal state: a phase timeout aborts the internal
 * controller (so `signal.aborted` is set) yet must still read as `timeout`. */
function failureReasonFor(error: unknown, signal: AbortSignal | undefined): EvaluationFailureReason {
  if (error instanceof EvidenceOverflowError) return 'evidence-overflow'
  if (error instanceof PhaseTimeoutError) return 'timeout'
  if (error instanceof PhaseAbortError) return 'aborted'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  if (signal?.aborted) return 'aborted'
  return 'provider-error'
}

/** Build a failed cell: score null, stable reason, timing stamped. */
function failedCell(
  base: Omit<CellEvaluation, 'status' | 'score' | 'evidence' | 'failureReason' | 'failureDetail' | 'feedback' | 'durationMs'>,
  evidence: ExecutorEvidence | null,
  failureReason: EvaluationFailureReason,
  startedAt: number,
  failureDetail?: string,
): CellEvaluation {
  return {
    ...base,
    status: 'failed',
    score: null,
    failureReason,
    ...(failureDetail === undefined ? {} : { failureDetail }),
    evidence,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Describe an unparseable executor reply for later diagnosis. The parser's own
 * message separates a wrong shape (`unexpected executor evidence field: x`)
 * from a truncated reply, and the length plus tail preserves the evidence that
 * the reply was cut off mid-JSON — without which the two are indistinguishable.
 */
function describeMalformedReply(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const tail = text.slice(-MAX_FAILURE_DETAIL_TAIL)
  return `${message} | reply ${text.length} chars | tail: ${tail}`.slice(0, MAX_FAILURE_DETAIL)
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
