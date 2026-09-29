/**
 * Implementations of the `harness_benchmark` actions, split out of
 * `tool-benchmark.ts` (2026-09-29): the tool surface declares and dispatches,
 * this module owns the per-action work.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSnapshot,
  createBenchmarkCase,
  freezeBenchmarkCase,
  MAX_BENCH_CASES,
  scopeLayerPair,
  validateCandidateDelta,
} from './benchmark.ts'
import {
  appendBenchmarkRun,
  captureReferenceSnapshot,
  loadBenchmark,
  loadReferenceSnapshot,
  saveBenchmarkCases,
} from './benchmark-store.ts'
import type { BenchmarkCase, CellScore, ExecutorEvidence, HarnessSnapshot } from './benchmark.ts'
import { BENCHMARK_DIR_NAME, BENCHMARK_RUNS_FILE_NAME, BENCHMARK_SNAPSHOTS_DIR_NAME } from './domain.ts'
import { runCellEvaluation } from './evaluate.ts'
import type { CellEvaluation } from './evaluate.ts'
import { decideBenchmark } from './score.ts'
import { mergeHarnessStates } from './storage.ts'
import type { HarnessStore } from './store.ts'
import type { BenchmarkToolOptions } from './tool-benchmark.ts'
import type { HarnessState, RefinementResult } from './types.ts'


/** Initialize the benchmark store directory. */
export function actionNew(store: HarnessStore): { action: string; ok: boolean; benchmark_dir: string } {
  mkdirSync(join(store.home, BENCHMARK_DIR_NAME), { recursive: true })
  return { action: 'new', ok: true, benchmark_dir: join(store.home, BENCHMARK_DIR_NAME) }
}

/** Add a draft case and persist the cases file atomically. */
export function actionAddCase(store: HarnessStore, args: Record<string, unknown>): { action: string; ok: boolean; case: CaseOutput } {
  const caseId = stringArg(args.case_id)
  const title = stringArg(args.title)
  const statement = stringArg(args.statement)
  const rubric = stringArg(args.rubric)
  const capability = stringArg(args.capability)
  if (caseId === undefined || title === undefined || statement === undefined || rubric === undefined) {
    throw benchmarkError('add-case:missing-argument', 'add-case requires case_id, title, statement, and rubric')
  }
  const existing = loadBenchmark(store.home)
  if (existing.length >= MAX_BENCH_CASES) {
    throw benchmarkError('add-case:case-limit', `benchmark case limit reached (${MAX_BENCH_CASES}); delete or prune cases first`)
  }
  if (existing.some(benchmarkCase => benchmarkCase.id === caseId)) {
    throw benchmarkError('add-case:duplicate-id', `benchmark case id already exists: ${caseId}`)
  }
  const draft = createBenchmarkCase({
    id: caseId,
    title,
    statement,
    rubric,
    ...(capability === undefined ? {} : { capability }),
  }, new Set(existing.map(benchmarkCase => benchmarkCase.id)))
  saveBenchmarkCases(store.home, [...existing, draft])
  return { action: 'add-case', ok: true, case: caseToOutput(draft) }
}

/** Freeze a draft case in place. */
export function actionFreeze(store: HarnessStore, args: Record<string, unknown>): { action: string; ok: boolean; case: CaseOutput } {
  const caseId = stringArg(args.case_id)
  if (caseId === undefined) throw benchmarkError('freeze:missing-argument', 'freeze requires case_id')
  const existing = loadBenchmark(store.home)
  const index = existing.findIndex(benchmarkCase => benchmarkCase.id === caseId)
  if (index < 0) throw benchmarkError('freeze:not-found', `no benchmark case with id: ${caseId}`)
  const target = existing[index]!
  if (target.state !== 'draft') throw benchmarkError('freeze:not-draft', `benchmark case is not in draft state: ${caseId}`)
  const frozen = freezeBenchmarkCase(target)
  const next = [...existing]
  next[index] = frozen
  saveBenchmarkCases(store.home, next)
  return { action: 'freeze', ok: true, case: caseToOutput(frozen) }
}

/** The execution slice the benchmark actions need: the live agent and the abort signal. */
interface BenchmarkExecution {
  agent?: Agent
  signal?: AbortSignal
}

/** Capture the merged local/global state BEFORE a refinement is applied and persist it. */
export function actionCaptureReference(
  store: HarnessStore,
  args: Record<string, unknown>,
  exec: BenchmarkExecution,
): { action: string; ok: boolean; snapshot_id: string; state_hash: string; captured_at: string } {
  const agent = exec.agent
  if (!agent) throw benchmarkError('capture-reference:no-agent', 'harness_benchmark capture-reference requires a live agent')
  const snapshotId = stringArg(args.snapshot_id)
  if (snapshotId === undefined) throw benchmarkError('capture-reference:missing-argument', 'capture-reference requires snapshot_id')
  const snapshot = store.captureSnapshot(agent, snapshotId)
  captureReferenceSnapshot(store.home, snapshot)
  return {
    action: 'capture-reference',
    ok: true,
    snapshot_id: snapshot.snapshotId,
    state_hash: snapshot.stateHash,
    captured_at: snapshot.capturedAt,
  }
}

/** List cases, persisted snapshots, and recent run records. */
export function actionStatus(store: HarnessStore): {
  action: string
  ok: boolean
  cases: Array<{ id: string; title: string; state: 'draft' | 'frozen' }>
  snapshots: SnapshotSummary[]
  recent_runs: RunSummary[]
} {
  const cases = loadBenchmark(store.home)
  return {
    action: 'status',
    ok: true,
    cases: cases.map(benchmarkCase => ({ id: benchmarkCase.id, title: benchmarkCase.title, state: benchmarkCase.state })),
    snapshots: listSnapshots(store.home),
    recent_runs: listRecentRuns(store.home),
  }
}

/**
 * Run the A/B benchmark for one named refinement against a captured reference.
 * The candidate is derived from the reference state plus the refinement's
 * recorded applied edits (never from the possibly-drifted live store), and
 * `validateCandidateDelta` must prove the candidate is reference plus exactly
 * that refinement — otherwise the run refuses with a structured error before
 * any evaluation. Both sides evaluate the same frozen cases in stored order
 * with the same iterations/provider/model, the decision is code-aggregated via
 * `src/score.ts`, and the full record (cells with executor evidence + decision)
 * is appended to `benchmark/runs.jsonl`.
 */
export async function actionRun(
  ctx: Context,
  store: HarnessStore,
  args: Record<string, unknown>,
  exec: BenchmarkExecution,
  options: BenchmarkToolOptions,
): Promise<{
  action: string
  ok: boolean
  run_id: string
  refinement_id: string
  status: 'ACCEPTED' | 'REJECTED'
  reference_overall: number | null
  candidate_overall: number | null
  regression_cases: string[]
  failed_cells: number
  feedback: string[]
  auto_rollback: boolean
  runs: number
  cells: number
}> {
  const agent = exec.agent
  if (!agent) throw benchmarkError('run:no-agent', 'harness_benchmark run requires a live agent')
  const referenceId = stringArg(args.reference_snapshot_id)
  if (referenceId === undefined) {
    throw benchmarkError('run:missing-argument', 'run requires reference_snapshot_id')
  }
  const refinementId = stringArg(args.refinement_id)
  if (refinementId === undefined) {
    throw benchmarkError('run:missing-argument', 'run requires refinement_id')
  }
  const runs = resolveRuns(args.runs, options)

  const frozenCases = loadBenchmark(store.home).filter(benchmarkCase => benchmarkCase.state === 'frozen')
  if (frozenCases.length === 0) {
    throw benchmarkError('run:no-frozen-cases', 'run requires at least one frozen benchmark case')
  }
  const reference = loadReferenceSnapshot(store.home, referenceId)
  if (reference === undefined) {
    throw benchmarkError('run:no-reference', `reference snapshot not found: ${referenceId}`)
  }
  const refinement = store.history(agent).find(result => result.id === refinementId)
  if (refinement === undefined) {
    throw benchmarkError('run:refinement-not-found', `no refinement with id ${refinementId} in the store history`)
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const candidate = deriveCandidateSnapshot(reference, refinement, `candidate-${runId}`)
  const delta = validateCandidateDelta(reference, candidate, refinementId)
  if (!delta.ok) {
    throw benchmarkError('run:candidate-delta', `candidate is not reference plus the single refinement ${refinementId}: ${delta.reason}`)
  }

  const provider = resolveModelOption(args.provider, agent.options.provider)
  const model = resolveModelOption(args.model, agent.options.model)
  if (provider === undefined || model === undefined) {
    throw benchmarkError('run:model-options', 'run requires a provider and model: pass provider/model or configure the agent')
  }

  if (exec.signal?.aborted) {
    throw benchmarkError('run:aborted', 'run aborted; no cells were evaluated and no decision was recorded')
  }
  const evaluations: CellEvaluation[] = []
  const cellOptions = exec.signal === undefined ? {} : { signal: exec.signal }
  for (const benchmarkCase of frozenCases) {
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      if (exec.signal?.aborted) break
      const [refCell, candCell] = await Promise.all([
        runCellEvaluation(ctx, {
          runId,
          side: 'reference',
          iteration,
          benchmarkCase,
          snapshot: reference,
          provider,
          model,
        }, cellOptions),
        runCellEvaluation(ctx, {
          runId,
          side: 'candidate',
          iteration,
          benchmarkCase,
          snapshot: candidate,
          provider,
          model,
        }, cellOptions),
      ])
      evaluations.push(refCell, candCell)
    }
  }

  if (exec.signal?.aborted) {
    throw benchmarkError('run:aborted', 'run aborted; no decision was recorded')
  }
  const cells: Array<CellScore & { evidence: ExecutorEvidence | null }> = evaluations.map(cellFromEvaluation)
  const decision = decideBenchmark({
    runId,
    refinementId,
    cells,
    options: {
      passThreshold: options.passThreshold,
      regressionTolerance: options.regressionTolerance,
      maxFailedCells: options.maxFailedCells,
    },
  })
  appendBenchmarkRun(store.home, { runId, cells, decision, createdAt: decision.createdAt })

  return {
    action: 'run',
    ok: true,
    run_id: runId,
    refinement_id: refinementId,
    status: decision.status,
    reference_overall: decision.referenceOverall,
    candidate_overall: decision.candidateOverall,
    regression_cases: decision.regressionCases,
    failed_cells: decision.failedCells,
    feedback: decision.feedback,
    auto_rollback: decision.autoRollback,
    runs,
    cells: cells.length,
  }
}

/**
 * Derive the candidate snapshot: reference plus exactly the named
 * refinement's applied edits, with the refinement appended to the history. The
 * caller must then prove the delta with `validateCandidateDelta`. When the
 * reference carries `layers`, the edits are applied to the refinement's own
 * layer (by `scope`) and the merged state is re-derived, so a shadowed global
 * entry (`local:<id>` in the merged view) is never overwritten by a global
 * refinement; snapshots without layers (persisted before the layering change)
 * use the legacy single-layer path.
 */
function deriveCandidateSnapshot(reference: HarnessSnapshot, refinement: RefinementResult, snapshotId: string): HarnessSnapshot {
  if (reference.layers !== undefined) {
    const { scope, other } = scopeLayerPair(refinement.scope)
    const layer = structuredClone(reference.layers[scope])
    applyEditsToEntries(layer.entries, refinement)
    layer.refinements.push(structuredClone(refinement))
    // the untouched other layer is passed through; buildSnapshot clones it
    const layers = scope === 'global' ? { global: layer, local: reference.layers[other] } : { global: reference.layers[other], local: layer }
    return buildSnapshot(mergeHarnessStates(layers.global, layers.local), snapshotId, refinement.id, layers)
  }
  const state = structuredClone(reference.state)
  applyEditsToEntries(state.entries, refinement)
  state.refinements.push(structuredClone(refinement))
  return buildSnapshot(state, snapshotId, refinement.id)
}

/** Apply a refinement's applied edits to one entries map (shared by both derivation paths). */
function applyEditsToEntries(entries: HarnessState['entries'], refinement: RefinementResult): void {
  for (const edit of refinement.appliedEdits) {
    if (!edit.applied) continue
    // No else: a conclusion-only record carries no replayable content, and
    // history() always serves the full journal record, so this is unreachable.
    if (edit.action === 'delete') {
      delete entries[edit.kind][edit.id]
    } else if (edit.afterEntry !== undefined) {
      entries[edit.kind][edit.id] = structuredClone(edit.afterEntry)
    }
  }
}

/** Project a CellEvaluation (a `CellScore` plus evidence) onto the persisted shape. */
function cellFromEvaluation(evaluation: CellEvaluation): CellScore & { evidence: ExecutorEvidence | null } {
  const { evidence, ...score } = evaluation
  return { ...score, evidence }
}

/** Resolve the iterations count: explicit positive integer capped by maxRuns. */
function resolveRuns(runs: unknown, options: BenchmarkToolOptions): number {
  if (runs === undefined) return Math.min(Math.max(options.defaultRuns, 1), options.maxRuns)
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    throw benchmarkError('run:runs-invalid', 'runs must be a positive integer')
  }
  if (runs > options.maxRuns) {
    throw benchmarkError('run:runs-exceeds-max', `runs (${runs}) exceeds maxRuns (${options.maxRuns})`)
  }
  return runs
}

/** Resolve a provider/model option: explicit non-empty string, else the given fallback. */
function resolveModelOption(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  return value === undefined ? fallback : undefined
}

/** One status-listing entry for a persisted snapshot. */
interface SnapshotSummary {
  snapshot_id: string
  refinement_id?: string
  captured_at: string
  state_hash: string
}

/** One status-listing entry for a recent run record. */
interface RunSummary {
  run_id: string
  refinement_id: string
  status: 'ACCEPTED' | 'REJECTED'
  reference_overall: number | null
  candidate_overall: number | null
  created_at: string
}

/** List persisted snapshots (best effort per file). */
function listSnapshots(home: string): SnapshotSummary[] {
  const dir = join(home, BENCHMARK_DIR_NAME, BENCHMARK_SNAPSHOTS_DIR_NAME)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const snapshots: SnapshotSummary[] = []
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue
    try {
      const snapshot = loadReferenceSnapshot(home, file.slice(0, -'.json'.length))
      if (snapshot === undefined) continue
      snapshots.push({
        snapshot_id: snapshot.snapshotId,
        ...(snapshot.refinementId === undefined ? {} : { refinement_id: snapshot.refinementId }),
        captured_at: snapshot.capturedAt,
        state_hash: snapshot.stateHash,
      })
    } catch {
      // a broken snapshot file never hides the rest of the listing
    }
  }
  return snapshots
}

/** List the most recent run records (best effort per line). */
function listRecentRuns(home: string): RunSummary[] {
  const file = join(home, BENCHMARK_DIR_NAME, BENCHMARK_RUNS_FILE_NAME)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const runs: RunSummary[] = []
  for (const line of text.trim().split('\n').reverse()) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as {
        runId: string
        decision: { refinementId: string; status: 'ACCEPTED' | 'REJECTED'; referenceOverall: number | null; candidateOverall: number | null; createdAt: string }
      }
      runs.push({
        run_id: record.runId,
        refinement_id: record.decision.refinementId,
        status: record.decision.status,
        reference_overall: record.decision.referenceOverall,
        candidate_overall: record.decision.candidateOverall,
        created_at: record.decision.createdAt,
      })
    } catch {
      // a torn line never hides the rest of the listing
    }
    if (runs.length >= 10) break
  }
  return runs
}

/** The output projection of a case: snake_case keys with optional fields omitted. */
interface CaseOutput {
  id: string
  title: string
  statement: string
  rubric: string
  capability?: string
  state: 'draft' | 'frozen'
  created_at: string
  frozen_at?: string
}

function caseToOutput(benchmarkCase: BenchmarkCase): CaseOutput {
  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    statement: benchmarkCase.statement,
    rubric: benchmarkCase.rubric,
    ...(benchmarkCase.capability === undefined ? {} : { capability: benchmarkCase.capability }),
    state: benchmarkCase.state,
    created_at: benchmarkCase.createdAt,
    ...(benchmarkCase.frozenAt === undefined ? {} : { frozen_at: benchmarkCase.frozenAt }),
  }
}

/** A non-empty string argument, or undefined when absent or blank. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Structured tool error: `benchmark:<action>:<code>: <message>`. */
export function benchmarkError(code: string, message: string): Error {
  return new Error(`benchmark:${code}: ${message}`)
}
