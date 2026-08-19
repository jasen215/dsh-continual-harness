/**
 * Code-owned benchmark aggregation and acceptance decisions. `aggregateCells`
 * reduces validated `CellScore[]` records into per-side overall/per-case means
 * (ok cells only; failed cells excluded from means but counted) and
 * `decideBenchmark` applies the spec §4.5 non-regression rules to produce the
 * binding `BenchmarkDecision`. Both are pure: no I/O, no LLM, and the decision
 * never invokes the rollback engine — `autoRollback` is the literal `false` in
 * every MVP decision.
 * @module dsh-continual-harness
 */

import type { BenchmarkDecision, CellScore } from './benchmark.ts'
import { validateCellScore } from './benchmark.ts'

/** Aggregation and decision knobs with spec §4.5 defaults. */
export interface AggregateOptions {
  /** Report-only pass line in 0..100; never gates acceptance (spec §4.5). */
  passThreshold: number
  /** How far the candidate may fall below the reference before regressing. */
  regressionTolerance: number
  /** Maximum failed candidate cells a run may still accept. */
  maxFailedCells: number
}

/** Per-case means for both sides; `null` when that side had no ok cells. */
export interface PerCaseAggregate {
  reference: number | null
  candidate: number | null
}

/** Aggregation output over one run's cells. */
export interface AggregateResult {
  /** Mean over all ok reference cells; `null` when none are usable. */
  referenceOverall: number | null
  /** Mean over all ok candidate cells; `null` when none are usable. */
  candidateOverall: number | null
  /** Per-case means keyed by case id (every case seen on either side). */
  perCase: Record<string, PerCaseAggregate>
  /** Total failed cells across both sides. */
  failedCells: number
  /** Failed reference cells. */
  failedReference: number
  /** Failed candidate cells. */
  failedCandidate: number
  /** Count of ok reference cells. */
  usableReference: number
  /** Count of ok candidate cells. */
  usableCandidate: number
}

/** Everything `decideBenchmark` needs beyond the cells: run identity and seams. */
export interface BenchmarkDecisionInput {
  runId: string
  refinementId: string
  cells: CellScore[]
  options?: AggregateOptions
  /** Clock seam so decisions are deterministic in tests. */
  now?: () => Date
}

/** Spec §4.5 defaults: passThreshold 60, regressionTolerance 0, maxFailedCells 0. */
export const DEFAULT_AGGREGATE_OPTIONS: AggregateOptions = {
  passThreshold: 60,
  regressionTolerance: 0,
  maxFailedCells: 0,
}

/**
 * Aggregate one run's cells: validate every input score first, partition by
 * side, then compute the overall mean over all ok cells and per-case means
 * (failed cells excluded from every mean, counted separately per side). An
 * overall of `null` means that side had no usable (ok) cells.
 */
export function aggregateCells(cells: CellScore[], options: AggregateOptions = DEFAULT_AGGREGATE_OPTIONS): AggregateResult {
  validateAggregateOptions(options)
  for (const cell of cells) {
    const validation = validateCellScore(cell)
    if (!validation.ok) {
      throw new Error(`invalid cell score: ${validation.reason}`)
    }
  }
  const { reference, candidate } = partitionBySide(cells)
  const referenceMeans = perCaseMeans(reference)
  const candidateMeans = perCaseMeans(candidate)
  const perCase: Record<string, PerCaseAggregate> = {}
  for (const caseId of new Set([...referenceMeans.keys(), ...candidateMeans.keys()])) {
    perCase[caseId] = {
      reference: referenceMeans.get(caseId) ?? null,
      candidate: candidateMeans.get(caseId) ?? null,
    }
  }
  const failedReference = countStatus(reference, 'failed')
  const failedCandidate = countStatus(candidate, 'failed')
  return {
    referenceOverall: meanOfOk(reference),
    candidateOverall: meanOfOk(candidate),
    perCase,
    failedCells: failedReference + failedCandidate,
    failedReference,
    failedCandidate,
    usableReference: countStatus(reference, 'ok'),
    usableCandidate: countStatus(candidate, 'ok'),
  }
}

/**
 * Decide a benchmark run from its aggregated cells (spec §4.5). REJECTED when
 * (a) either side has no usable cells, (b) candidate failed cells exceed
 * `maxFailedCells`, (c) candidate overall falls below reference overall minus
 * `regressionTolerance`, or (d) any case's candidate mean falls below its
 * reference mean minus `regressionTolerance`. ACCEPTED only when every rule
 * passes. Collects non-empty cell feedback in input order and always records
 * `autoRollback: false` — the rollback engine is never invoked.
 */
export function decideBenchmark(input: BenchmarkDecisionInput): BenchmarkDecision {
  const options = input.options ?? DEFAULT_AGGREGATE_OPTIONS
  const aggregated = aggregateCells(input.cells, options)
  const regressionCases = findRegressionCases(aggregated.perCase, options.regressionTolerance)
  const status = decideStatus(aggregated, options, regressionCases)
  return {
    runId: input.runId,
    refinementId: input.refinementId,
    status,
    referenceOverall: aggregated.referenceOverall,
    candidateOverall: aggregated.candidateOverall,
    regressionCases,
    failedCells: aggregated.failedCells,
    feedback: collectFeedback(input.cells),
    autoRollback: false,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  }
}

/** Split cells by side; `side` is a closed union so the else branch is candidate. */
function partitionBySide(cells: CellScore[]): { reference: CellScore[]; candidate: CellScore[] } {
  const reference: CellScore[] = []
  const candidate: CellScore[] = []
  for (const cell of cells) {
    if (cell.side === 'reference') reference.push(cell)
    else candidate.push(cell)
  }
  return { reference, candidate }
}

/** Mean over ok cells only; `null` when none exist. Scores are pre-validated. */
function meanOfOk(cells: CellScore[]): number | null {
  const ok = cells.filter(cell => cell.status === 'ok')
  if (ok.length === 0) return null
  let sum = 0
  for (const cell of ok) sum += cell.score!
  return sum / ok.length
}

/** Per-case mean over ok cells only, keyed by case id. */
function perCaseMeans(cells: CellScore[]): Map<string, number> {
  const sums = new Map<string, { sum: number; count: number }>()
  for (const cell of cells) {
    if (cell.status !== 'ok') continue
    const acc = sums.get(cell.caseId) ?? { sum: 0, count: 0 }
    acc.sum += cell.score!
    acc.count += 1
    sums.set(cell.caseId, acc)
  }
  const means = new Map<string, number>()
  for (const [caseId, acc] of sums) means.set(caseId, acc.sum / acc.count)
  return means
}

function countStatus(cells: CellScore[], status: CellScore['status']): number {
  return cells.filter(cell => cell.status === status).length
}

/** Case ids whose candidate mean regressed beyond tolerance; sorted for determinism. */
function findRegressionCases(perCase: Record<string, PerCaseAggregate>, tolerance: number): string[] {
  const regressed: string[] = []
  for (const caseId of Object.keys(perCase).sort()) {
    const aggregate = perCase[caseId]!
    if (aggregate.reference === null || aggregate.candidate === null) continue
    if (aggregate.candidate < aggregate.reference - tolerance) regressed.push(caseId)
  }
  return regressed
}

/** The spec §4.5 decision rules; ACCEPTED only when every rule passes. */
function decideStatus(
  aggregated: AggregateResult,
  options: AggregateOptions,
  regressionCases: string[],
): BenchmarkDecision['status'] {
  // (a) insufficient evidence: either side has no usable cells.
  if (aggregated.usableReference === 0 || aggregated.usableCandidate === 0) return 'REJECTED'
  // (b) candidate failed-cell overflow.
  if (aggregated.failedCandidate > options.maxFailedCells) return 'REJECTED'
  const referenceOverall = aggregated.referenceOverall
  const candidateOverall = aggregated.candidateOverall
  if (referenceOverall === null || candidateOverall === null) return 'REJECTED'
  // (c) overall regression beyond tolerance.
  if (candidateOverall < referenceOverall - options.regressionTolerance) return 'REJECTED'
  // (d) any per-case regression beyond tolerance.
  if (regressionCases.length > 0) return 'REJECTED'
  return 'ACCEPTED'
}

/** Non-empty cell feedback in input order (deterministic for a given input). */
function collectFeedback(cells: CellScore[]): string[] {
  const feedback: string[] = []
  for (const cell of cells) {
    if (cell.feedback !== undefined && cell.feedback.trim() !== '') feedback.push(cell.feedback)
  }
  return feedback
}

/** Reject nonsense option values loudly rather than silently mis-deciding. */
function validateAggregateOptions(options: AggregateOptions): void {
  if (!Number.isFinite(options.passThreshold) || options.passThreshold < 0 || options.passThreshold > 100) {
    throw new Error('passThreshold must be a finite number in 0..100')
  }
  if (!Number.isFinite(options.regressionTolerance) || options.regressionTolerance < 0) {
    throw new Error('regressionTolerance must be a finite non-negative number')
  }
  if (!Number.isInteger(options.maxFailedCells) || options.maxFailedCells < 0) {
    throw new Error('maxFailedCells must be a non-negative integer')
  }
}
