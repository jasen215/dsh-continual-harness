/**
 * Code-owned benchmark aggregation and acceptance decisions. `aggregateCells`
 * reduces validated `CellScore[]` records into per-side means (for reporting)
 * plus the per-case **paired** differences that the decision is built on
 * (failed cells drop their pair rather than entering any mean), and
 * `decideBenchmark` applies the spec §4.5 non-regression rules to produce the
 * binding `BenchmarkDecision`. Both are pure: no I/O, no LLM, and the decision
 * never invokes the rollback engine — `autoRollback` is the literal `false` in
 * every MVP decision.
 * @module dsh-continual-harness
 */

import type { BenchmarkDecision, CellScore, InconclusiveReason } from './benchmark.ts'
import { validateCellScore } from './benchmark.ts'

/** Aggregation and decision knobs with spec §4.5 defaults. */
export interface AggregateOptions {
  /** Intended by spec §4.5 as a report-only pass line in 0..100; it never gates
   *  acceptance and is currently not emitted in the run output either. */
  passThreshold: number
  /** How far the candidate may fall below the reference before regressing. */
  regressionTolerance: number
  /**
   * @deprecated No longer gates the verdict. A failed cell is missing
   * measurement, and under the paired comparison it only drops that iteration's
   * pair; the sample size is reported as `pairs` instead. Kept so existing
   * configs keep validating; scheduled for removal.
   */
  maxFailedCells: number
}

/** Per-case paired comparison: the differences, plus the pairs that dropped out. */
export interface PerCasePair {
  /** Paired differences (candidate − reference) for iterations scored on both sides. */
  diffs: number[]
  /** Iterations where at least one side produced no score, so the pair dropped. */
  missing: number
}

/** Aggregation output over one run's cells. */
export interface AggregateResult {
  /** Mean over all ok reference cells; `null` when none are usable. */
  referenceOverall: number | null
  /** Mean over all ok candidate cells; `null` when none are usable. */
  candidateOverall: number | null
  /** Per-case paired differences keyed by case id (every case seen on either side). */
  perCase: Record<string, PerCasePair>
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
  /**
   * Run-to-run noise the candidate must exceed: the half-width of the 95%
   * t-interval of the paired differences pooled over cases. `null` when fewer
   * than two paired iterations exist, i.e. when no interval can be formed.
   */
  noiseFloor: number | null
  /** Mean paired difference (candidate − reference) over every paired iteration. */
  pairedDelta: number | null
  /** Iterations scored on both sides — the decision's real sample size. */
  pairs: number
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
 * side, then compute the overall mean over all ok cells plus the pooled and
 * per-case **paired differences** the decision is built on (a failed cell drops
 * its pair instead of entering any mean, and is counted separately per side). An
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
  const paired = pairDiffs(cells)
  const perCase: Record<string, PerCasePair> = {}
  for (const caseId of [...paired.keys()].sort()) {
    const { diffs, missing } = paired.get(caseId)!
    perCase[caseId] = { diffs, missing }
  }
  const allDiffs = pooledDiffs(perCase)
  const pairs = allDiffs.length
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
    noiseFloor: tIntervalHalfWidth(allDiffs),
    pairedDelta: pairs === 0 ? null : allDiffs.reduce((sum, diff) => sum + diff, 0) / pairs,
    pairs,
  }
}

/**
 * Decide a benchmark run from its aggregated cells (spec §4.5, tightened).
 *
 * The comparison is **paired**: each iteration contributes candidate − reference
 * for the same case, so case difficulty cancels and a cell that failed drops one
 * pair instead of unbalancing a mean toward either side.
 *
 * REJECTED when the run measured something bad: (a) either side has no usable
 * cells, (b) no iteration scored on both sides, or (c) some case's paired mean
 * difference falls below both `regressionTolerance` and that case's observed
 * noise (a drop inside the noise is no more evidence than a gain inside it).
 *
 * INCONCLUSIVE when the evidence cannot separate the two sides: fewer than two
 * paired iterations in some case (the noise is unestimable — `no-noise-estimate`
 * with no dropouts, `insufficient-paired-observations` with them), a difference
 * that does not exceed the observed noise, or an improvement that clears the
 * noise but is not consistent across iterations (`improvement-not-consistent`).
 *
 * ACCEPTED only when the paired improvement exceeds the observed spread *and*
 * survives the sign test — "no regression" alone is never an accept.
 *
 * A failed cell is an absence of measurement, never evidence against: an
 * unparseable executor reply must not veto a refinement as if it had regressed.
 * Collects non-empty cell feedback in input order and always records
 * `autoRollback: false` — the rollback engine is never invoked.
 */
export function decideBenchmark(input: BenchmarkDecisionInput): BenchmarkDecision {
  const options = input.options ?? DEFAULT_AGGREGATE_OPTIONS
  const aggregated = aggregateCells(input.cells, options)
  const regressionCases = findRegressionCases(aggregated.perCase, options.regressionTolerance)
  const { status, inconclusiveReason } = decideStatus(aggregated, regressionCases)
  return {
    runId: input.runId,
    refinementId: input.refinementId,
    status,
    ...(inconclusiveReason === undefined ? {} : { inconclusiveReason }),
    referenceOverall: aggregated.referenceOverall,
    candidateOverall: aggregated.candidateOverall,
    noiseFloor: aggregated.noiseFloor,
    pairedDelta: aggregated.pairedDelta,
    pairs: aggregated.pairs,
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

/** Two-sided 95% t critical values by degrees of freedom (1..30), then the normal limit. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
]

/**
 * Half-width of the two-sided 95% t-interval for the mean of `values` — the bar
 * a paired difference must clear to be distinguishable from noise; `null` when
 * fewer than two values support no interval at all.
 *
 * A raw range (max−min) was the first estimator here and it is wrong in a way
 * that matters: the expected range *grows* with the sample size, so gathering
 * more evidence raised the bar instead of lowering it (measured live on one
 * case: the range bar went 12 → 25 as pairs went 2 → 4, while the standard
 * error went 6.0 → 5.1). The half-width is also enormous at two pairs (t=12.7)
 * — which is the honest statement that two pairs decide nothing.
 */
function tIntervalHalfWidth(values: number[]): number | null {
  const n = values.length
  if (n < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  return (T95[n - 2] ?? 1.96) * Math.sqrt(variance) / Math.sqrt(n)
}

/**
 * Pair the two sides by (case, iteration) and take candidate − reference per
 * pair; an iteration where either side produced no score is counted as missing
 * and drops the whole pair. Pairing is what makes the comparison sound: a case
 * that is intrinsically hard shifts both sides equally, and a failure removes
 * one observation instead of unbalancing a mean toward the candidate.
 */
function pairDiffs(cells: CellScore[]): Map<string, { diffs: number[]; missing: number }> {
  const byCase = new Map<string, Map<number, { reference?: number; candidate?: number }>>()
  for (const cell of cells) {
    let iterations = byCase.get(cell.caseId)
    if (iterations === undefined) {
      iterations = new Map()
      byCase.set(cell.caseId, iterations)
    }
    const entry = iterations.get(cell.iteration) ?? {}
    if (cell.status === 'ok') {
      if (cell.side === 'reference') entry.reference = cell.score!
      else entry.candidate = cell.score!
    }
    iterations.set(cell.iteration, entry)
  }
  const paired = new Map<string, { diffs: number[]; missing: number }>()
  for (const [caseId, iterations] of byCase) {
    const diffs: number[] = []
    let missing = 0
    for (const iteration of [...iterations.keys()].sort((a, b) => a - b)) {
      const entry = iterations.get(iteration)!
      if (entry.reference === undefined || entry.candidate === undefined) missing += 1
      else diffs.push(entry.candidate - entry.reference)
    }
    paired.set(caseId, { diffs, missing })
  }
  return paired
}

/**
 * The paired differences pooled over every case, in case-id order. One helper so
 * the noise bar and the acceptance-side sign test are guaranteed to read the
 * same sample.
 */
function pooledDiffs(perCase: Record<string, PerCasePair>): number[] {
  return Object.values(perCase).flatMap(entry => entry.diffs)
}

function countStatus(cells: CellScore[], status: CellScore['status']): number {
  return cells.filter(cell => cell.status === status).length
}

/**
 * How far a case's paired mean must fall before the drop counts as a measured
 * regression: past the pre-declared tolerance **and** past the noise interval
 * observed for that case. A drop inside the noise is not evidence of anything,
 * exactly like a gain inside the noise — judging only against the tolerance
 * made the same magnitude of noise a REJECTION when negative and "no evidence"
 * when positive (observed live: the same reference/refinement pair produced
 * paired differences of +12 and −13 across two runs).
 */
function regressionThreshold(diffs: number[], tolerance: number): number {
  // Two or more pairs support an interval for this case; a single pair cannot,
  // so the pre-declared tolerance is the only bar available for it.
  const halfWidth = tIntervalHalfWidth(diffs)
  return halfWidth === null ? tolerance : Math.max(tolerance, halfWidth)
}

/** Cases whose paired mean difference regressed beyond that bar; sorted for determinism. */
function findRegressionCases(perCase: Record<string, PerCasePair>, tolerance: number): string[] {
  const regressed: string[] = []
  for (const caseId of Object.keys(perCase).sort()) {
    const { diffs } = perCase[caseId]!
    if (diffs.length === 0) continue
    const delta = diffs.reduce((sum, diff) => sum + diff, 0) / diffs.length
    if (delta < -regressionThreshold(diffs, tolerance)) regressed.push(caseId)
  }
  return regressed
}

/**
 * Significance level for the acceptance-side sign test. Hard-coded like the
 * 0.975 t quantile above: this is a fixed statistical convention, not a knob.
 */
const SIGN_TEST_ALPHA = 0.05

/** Exact binomial coefficient, sufficient for the small pair counts here. */
function binomial(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i
  return result
}

/**
 * Exact two-sided sign test over the paired differences: ties are dropped and,
 * under the null, each remaining difference is equally likely to fall either
 * way. Returns null when every difference is a tie, so there is no direction to
 * test.
 *
 * Why this exists next to the t interval: when every pair differs by the same
 * amount the sample spread is 0 and the interval collapses to zero width, which
 * would read a small-n fluke as infinite confidence. Four same-direction pairs
 * give p = 0.125 here — not significant — so acceptance needs more agreement
 * than the interval alone demands.
 */
export function signTestPValue(diffs: number[]): number | null {
  const decided = diffs.filter(diff => diff !== 0)
  const n = decided.length
  if (n === 0) return null
  const wins = Math.max(
    decided.filter(diff => diff > 0).length,
    decided.filter(diff => diff < 0).length,
  )
  let tail = 0
  for (let k = wins; k <= n; k += 1) tail += binomial(n, k)
  return Math.min(1, (2 * tail) / 2 ** n)
}

/**
 * The spec §4.5 decision rules, evaluated in order. Regressions are checked
 * before the incompleteness rules so a measured regression is never masked by
 * a cell that failed to produce a score.
 */
function decideStatus(
  aggregated: AggregateResult,
  regressionCases: string[],
): { status: BenchmarkDecision['status']; inconclusiveReason?: InconclusiveReason } {
  // (a) fail closed when a side measured nothing at all.
  if (aggregated.usableReference === 0 || aggregated.usableCandidate === 0) return { status: 'REJECTED' }
  // (b) no iteration scored on both sides: there is nothing to compare.
  const delta = aggregated.pairedDelta
  if (aggregated.pairs === 0 || delta === null) return { status: 'REJECTED' }
  // (c) any per-case regression beyond tolerance *and* beyond that case's
  // observed noise. This subsumes a separate "overall" rule: the pooled paired
  // mean is the pair-weighted mean of the per-case deltas, so it cannot fall
  // below the bar unless some case did. Regressions are checked before the
  // incompleteness rule so a measured regression is never masked by a cell that
  // failed to produce a score.
  if (regressionCases.length > 0) return { status: 'REJECTED' }
  // (d) fewer than two paired iterations leaves the noise unestimable. A failed
  // cell only drops its pair, so failures reduce the sample size rather than
  // vetoing the refinement — the verdict says the measurement is incomplete.
  if (aggregated.noiseFloor === null) {
    return {
      status: 'INCONCLUSIVE',
      inconclusiveReason: aggregated.failedCells > 0 ? 'insufficient-paired-observations' : 'no-noise-estimate',
    }
  }
  // (e) acceptance requires the paired improvement to exceed the observed noise.
  // A negative delta that got this far is inside its case's noise, so the same
  // reason names both directions and the sign of `pairedDelta` carries which.
  if (delta <= aggregated.noiseFloor) {
    return { status: 'INCONCLUSIVE', inconclusiveReason: 'difference-not-beyond-noise' }
  }
  // (f) clearing the noise bar is not enough: the improvement must also be
  // consistent across iterations. Without this, a zero-width interval at a small
  // n would accept a difference that the sign test calls a coin flip. The
  // regression side keeps its own bar on purpose — wrongly rejecting a change is
  // the cheap error, wrongly accepting one is not.
  const signP = signTestPValue(pooledDiffs(aggregated.perCase))
  if (signP === null || signP >= SIGN_TEST_ALPHA) {
    return { status: 'INCONCLUSIVE', inconclusiveReason: 'improvement-not-consistent' }
  }
  return { status: 'ACCEPTED' }
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
