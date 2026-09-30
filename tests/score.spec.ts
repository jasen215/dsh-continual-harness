import { describe, expect, it } from 'vitest'
import type { BenchmarkDecision, CellScore } from '../src/benchmark.ts'
import { aggregateCells, decideBenchmark, signTestPValue } from '../src/score.ts'
import type { AggregateOptions } from '../src/score.ts'

/** Build a minimal valid cell; defaults to run-1 / case-a / iteration 1. */
function cell(partial: Partial<CellScore> & Pick<CellScore, 'side' | 'score' | 'status'>): CellScore {
  return {
    runId: 'run-1',
    caseId: 'case-a',
    iteration: 1,
    snapshotId: 'snap-1',
    stateHash: '0'.repeat(64),
    caseHash: '0'.repeat(64),
    recordedAt: '2026-08-19T00:00:00.000Z',
    ...partial,
  }
}

const NOW = () => new Date('2026-08-19T12:00:00.000Z')

/** Decide a full run over the given cells with a fixed clock. */
function decide(cells: CellScore[], options?: AggregateOptions): BenchmarkDecision {
  return decideBenchmark({ runId: 'run-1', refinementId: 'refine-1', cells, options, now: NOW })
}

/**
 * `n` paired iterations whose candidate scores `delta` above the reference on
 * every one of them. Six is the smallest count the acceptance-side sign test
 * can call significant (p = 2·(1/2)⁶ = 0.031), so a fixture that expects
 * ACCEPTED needs at least six agreeing pairs.
 */
function improvingPairs(n: number, delta: number, options: { caseId?: string; reference?: number } = {}): CellScore[] {
  const caseId = options.caseId ?? 'case-a'
  const reference = options.reference ?? 80
  return Array.from({ length: n }, (_, index) => index + 1).flatMap(iteration => [
    cell({ side: 'reference', caseId, score: reference, status: 'ok', iteration }),
    cell({ side: 'candidate', caseId, score: reference + delta, status: 'ok', iteration }),
  ])
}

describe('aggregateCells', () => {
  it('validates every input cell before aggregating', () => {
    expect(() => aggregateCells([cell({ side: 'candidate', score: 150, status: 'ok' })])).toThrow('score-out-of-range')
    expect(() => aggregateCells([cell({ side: 'candidate', score: 42, status: 'failed' })])).toThrow('failed-cell-score-not-null')
    expect(() => aggregateCells([cell({ side: 'candidate', score: null, status: 'ok' })])).toThrow('ok-cell-score-required')
    expect(() => aggregateCells([cell({ side: 'candidate', score: Number.NaN, status: 'ok' })])).toThrow('score-non-finite')
  })

  it('rejects invalid option values loudly', () => {
    expect(() => aggregateCells([cell({ side: 'candidate', score: 80, status: 'ok' })], { passThreshold: 101, regressionTolerance: 0, maxFailedCells: 0 }))
      .toThrow('passThreshold')
    expect(() => aggregateCells([cell({ side: 'candidate', score: 80, status: 'ok' })], { passThreshold: 60, regressionTolerance: -1, maxFailedCells: 0 }))
      .toThrow('regressionTolerance')
    expect(() => aggregateCells([cell({ side: 'candidate', score: 80, status: 'ok' })], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: -1 }))
      .toThrow('maxFailedCells')
  })

  it('excludes failed cells from means and counts them separately', () => {
    const result = aggregateCells([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', score: null, status: 'failed', iteration: 3 }),
      cell({ side: 'candidate', score: 70, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 76, status: 'ok', iteration: 2 }),
    ])
    expect(result.referenceOverall).toBe(85)
    expect(result.candidateOverall).toBe(73)
    expect(result.usableReference).toBe(2)
    expect(result.usableCandidate).toBe(2)
    expect(result.failedReference).toBe(1)
    expect(result.failedCandidate).toBe(0)
    expect(result.failedCells).toBe(1)
  })

  it('pairs each case by iteration and takes candidate − reference', () => {
    // Same case, same iteration: the difference is what the decision uses, and
    // an iteration scored on only one side drops the pair instead of moving a
    // mean toward that side.
    const result = aggregateCells([
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-a', score: 80, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', caseId: 'case-b', score: 60, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-a', score: 90, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', caseId: 'case-b', score: 66, status: 'ok' }),
    ])
    expect(result.perCase['case-a']).toEqual({ diffs: [-10], missing: 1 })
    expect(result.perCase['case-b']).toEqual({ diffs: [6], missing: 0 })
    expect(result.pairs).toBe(2)
    expect(result.pairedDelta).toBe(-2)
    // Two pairs total support an interval so wide (≈102 for σ≈11) that no
    // effect of this scale could clear it: weak evidence states its own weakness.
    expect(result.noiseFloor).toBeCloseTo(101.65, 1)
  })

  it('drops a case whose other side never scored', () => {
    const result = aggregateCells([
      cell({ side: 'candidate', caseId: 'case-a', score: 70, status: 'ok' }),
    ])
    expect(result.perCase['case-a']).toEqual({ diffs: [], missing: 1 })
    expect(result.pairs).toBe(0)
    expect(result.pairedDelta).toBeNull()
    // The per-side means still report what was measured.
    expect(result.referenceOverall).toBeNull()
    expect(result.candidateOverall).toBe(70)
  })

  it('returns null overall when a side has only failed cells', () => {
    const result = aggregateCells([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: null, status: 'failed' }),
    ])
    expect(result.referenceOverall).toBe(80)
    expect(result.candidateOverall).toBeNull()
    expect(result.perCase['case-a']).toEqual({ diffs: [], missing: 1 })
    expect(result.usableCandidate).toBe(0)
    expect(result.failedCells).toBe(1)
  })

  it('applies default options when none are given', () => {
    const result = aggregateCells([cell({ side: 'reference', score: 80, status: 'ok' })])
    expect(result.referenceOverall).toBe(80)
  })
})

describe('signTestPValue', () => {
  it('returns null when every difference is a tie', () => {
    expect(signTestPValue([])).toBeNull()
    expect(signTestPValue([0, 0, 0])).toBeNull()
  })

  it('is the exact two-sided binomial tail over the non-tied pairs', () => {
    expect(signTestPValue([1, 1])).toBeCloseTo(0.5, 10)
    expect(signTestPValue([1, 1, 1, 1])).toBeCloseTo(0.125, 10)
    expect(signTestPValue([1, 1, 1, 1, 1])).toBeCloseTo(0.0625, 10)
    expect(signTestPValue([1, 1, 1, 1, 1, 1])).toBeCloseTo(0.03125, 10)
    expect(signTestPValue([1, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(0.0078125, 10)
  })

  it('drops ties instead of counting them as agreement', () => {
    expect(signTestPValue([5, 5, 5, -5, 0, 0, 0, 0])).toBeCloseTo(0.625, 10)
  })

  it('never reports a probability above one', () => {
    expect(signTestPValue([1, -1])).toBe(1)
    expect(signTestPValue([1, 1, -1, -1])).toBe(1)
  })
})

describe('decideBenchmark', () => {
  it('accepts a candidate improvement that exceeds the observed spread', () => {
    const decision = decide(improvingPairs(6, 5))
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.referenceOverall).toBe(80)
    expect(decision.candidateOverall).toBe(85)
    expect(decision.noiseFloor).toBe(0)
    expect(decision.regressionCases).toEqual([])
    expect(decision.failedCells).toBe(0)
    expect(decision.pairs).toBe(6)
  })

  it('refuses to accept identical pairs: a zero-width interval is not confidence', () => {
    // Every pair differs by exactly +5, so the sample spread is 0 and the t
    // interval collapses to zero width. That is a small-sample artifact, not
    // infinite confidence: four agreeing pairs give a sign-test p of 0.125, so
    // the improvement is not established and the run must not accept.
    const decision = decide(improvingPairs(4, 5))
    expect(decision.noiseFloor).toBe(0)
    expect(decision.pairedDelta).toBe(5)
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('improvement-not-consistent')
  })

  it('accepts six agreeing pairs, where the sign test turns significant', () => {
    // The counterpart to the test above: the guard must not block a genuine,
    // reproducible improvement, only a small-n coincidence.
    const decision = decide(improvingPairs(6, 5))
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.inconclusiveReason).toBeUndefined()
  })

  it('cannot accept a single iteration per side: the noise is unestimable', () => {
    // A one-shot comparison reports a delta but no spread, so it has no way to
    // tell an improvement from run-to-run variation. It must not accept.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 95, status: 'ok' }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.noiseFloor).toBeNull()
  })

  it('treats an improvement inside the observed spread as inconclusive', () => {
    // Paired differences are +5 then 0: a mean gain of 2.5 from two pairs,
    // which the 95% t-interval of those differences (≈32 at n=2) cannot be
    // told apart from noise. The interval is built from the *differences*, not
    // from either side, because a shift common to both sides cancels out.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 85, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('difference-not-beyond-noise')
    expect(decision.pairedDelta).toBe(2.5)
    expect(decision.noiseFloor).toBeGreaterThan(decision.pairedDelta!)
  })

  it('accepts when the improvement clears the interval the pairs support', () => {
    // The same +16/+6 difference pattern as the case above, repeated over four
    // iterations per pattern: the interval narrows as pairs accumulate, so an
    // 11-point gain that two pairs could not establish becomes decisive. This
    // is exactly the property a raw range (max−min) got backwards, because the
    // range grows with n while the standard error shrinks.
    const cells = [1, 2, 3, 4].flatMap((iteration) => [
      cell({ side: 'reference', score: 80, status: 'ok', iteration }),
      cell({ side: 'candidate', score: 96, status: 'ok', iteration }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: iteration + 4 }),
      cell({ side: 'candidate', score: 96, status: 'ok', iteration: iteration + 4 }),
    ])
    const decision = decide(cells)
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.pairs).toBe(8)
    expect(decision.pairedDelta).toBe(11)
    expect(decision.noiseFloor).toBeCloseTo(4.47, 1)
  })

  it('treats a drop inside the observed noise as inconclusive, not as a regression', () => {
    // Live evidence (2026-09-30): for the same frozen case and the same
    // reference/refinement pair, two runs produced paired differences of
    // [12, 0] and [0, −13]. A −6.5 mean drop against a 13-point swing is not
    // evidence of a regression, and judging it by the tolerance alone reported
    // the same magnitude of noise as a REJECTION when negative while calling it
    // "no evidence" when positive.
    const decision = decide([
      cell({ side: 'reference', score: 62, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 87, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 62, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 74, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('difference-not-beyond-noise')
    expect(decision.pairedDelta).toBe(-6.5)
    // Two pairs give an interval (≈83) far wider than the 6.5 drop.
    expect(decision.noiseFloor).toBeGreaterThan(Math.abs(decision.pairedDelta!))
    expect(decision.regressionCases).toEqual([])
  })

  it('still rejects a drop that exceeds the interval when the pairs support one', () => {
    // The −20/−30 pattern repeated over four iterations narrows the interval to
    // ≈4.5, and a 25-point paired drop clears it: a regression the run actually
    // measured, as opposed to the drop inside the noise above.
    const cells = [1, 2, 3, 4].flatMap((iteration) => [
      cell({ side: 'reference', score: 80, status: 'ok', iteration }),
      cell({ side: 'candidate', score: 60, status: 'ok', iteration }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: iteration + 4 }),
      cell({ side: 'candidate', score: 60, status: 'ok', iteration: iteration + 4 }),
    ])
    const decision = decide(cells)
    expect(decision.status).toBe('REJECTED')
    expect(decision.pairs).toBe(8)
    expect(decision.pairedDelta).toBe(-25)
    expect(decision.noiseFloor).toBeCloseTo(4.47, 1)
    expect(decision.regressionCases).toEqual(['case-a'])
  })

  it('cannot accept on a partial reference baseline', () => {
    // The failing reference cell drops out of the mean, which would silently
    // flatter the candidate; a partial baseline yields no verdict.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: null, status: 'failed', iteration: 2 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
  })

  it('treats equal scores as inconclusive, not accepted', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 80, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
  })

  it('rejects a regressing case even when another case improves hugely', () => {
    // case-a gains 100 points per pair, case-b loses 20. The pooled paired mean
    // is a comfortable +40, so a rule that only looked at the pooled number
    // would wave this through; the per-case rule rejects it.
    const decision = decide([
      cell({ side: 'reference', caseId: 'case-a', score: 0, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-a', score: 0, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', caseId: 'case-b', score: 60, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-b', score: 60, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', caseId: 'case-a', score: 100, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', caseId: 'case-a', score: 100, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', caseId: 'case-b', score: 40, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', caseId: 'case-b', score: 40, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('REJECTED')
    expect(decision.pairedDelta).toBeCloseTo(40, 2)
    expect(decision.regressionCases).toEqual(['case-b'])
  })

  it('rejects per-case regression even when overall is unchanged', () => {
    // Reference: case-a 2x100, case-b 1x0  -> overall 66.67.
    // Candidate: case-a 2x60, case-b 1x80  -> overall 66.67 (unchanged), but
    // case-a regressed 60 < 100.
    const decision = decide([
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', caseId: 'case-b', score: 0, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-a', score: 60, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', caseId: 'case-a', score: 60, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', caseId: 'case-b', score: 80, status: 'ok' }),
    ])
    expect(decision.status).toBe('REJECTED')
    expect(decision.referenceOverall).toBeCloseTo(66.67, 2)
    expect(decision.candidateOverall).toBeCloseTo(66.67, 2)
    expect(decision.regressionCases).toEqual(['case-a'])
  })

  it('decides on the paired iterations and reports the ones that dropped out', () => {
    // One candidate cell produced no score. Under pairing it removes that
    // iteration's pair rather than dragging a mean down, so the run still
    // decides on what it did measure — and it must report the dropout instead
    // of hiding it.
    const decision = decide([
      ...improvingPairs(6, 5),
      cell({ side: 'candidate', score: null, status: 'failed', iteration: 7 }),
    ], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.pairs).toBe(6)
    expect(decision.failedCells).toBe(1)
  })

  it('does not let an unparseable candidate reply veto a real improvement', () => {
    // A malformed executor reply is an infrastructure failure, not evidence
    // against the refinement. It used to reject the run outright; now it only
    // drops its own pair, and the measured improvement still stands.
    const decision = decide([
      ...improvingPairs(6, 15),
      cell({ side: 'candidate', score: null, status: 'failed', iteration: 7 }),
    ], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.pairedDelta).toBe(15)
    expect(decision.failedCells).toBe(1)
  })

  it('still rejects a measured regression when other cells failed', () => {
    // A regression the run actually measured outranks the incompleteness of
    // the cells that failed: the rejection must not be masked.
    const decision = decide([
      cell({ side: 'reference', score: 90, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 70, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 70, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: null, status: 'failed', iteration: 3 }),
    ], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 1 })
    expect(decision.status).toBe('REJECTED')
    expect(decision.regressionCases).toEqual(['case-a'])
  })

  it('treats a within-tolerance regression as inconclusive', () => {
    // Staying inside the tolerance avoids a REJECTION; it is not a gain, so it
    // must not be reported as one.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 78, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 78, status: 'ok', iteration: 2 }),
    ], { passThreshold: 60, regressionTolerance: 5, maxFailedCells: 0 })
    expect(decision.status).toBe('INCONCLUSIVE')
  })

  it('rejects a candidate regression beyond tolerance', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 74, status: 'ok' }),
    ], { passThreshold: 60, regressionTolerance: 5, maxFailedCells: 0 })
    expect(decision.status).toBe('REJECTED')
    expect(decision.regressionCases).toEqual(['case-a'])
  })

  it('is inconclusive when a side has no usable cells (missing measurement, not evidence)', () => {
    // Every candidate cell failed. That is a measurement the run never made, so it
    // must not veto the refinement as if the candidate had regressed: the reason
    // names the empty side — here the candidate — which the operator has to fix
    // before anything can be concluded.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: null, status: 'failed' }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('empty-measurement-side')
    expect(decision.referenceOverall).toBe(80)
    expect(decision.candidateOverall).toBeNull()
    expect(decision.regressionCases).toEqual([])
  })

  it('is inconclusive with the same reason when the reference side is empty', () => {
    // Symmetric: an unmeasured baseline is no more evidence than an unmeasured
    // candidate side.
    const decision = decide([
      cell({ side: 'reference', score: null, status: 'failed' }),
      cell({ side: 'candidate', score: 80, status: 'ok' }),
    ])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('empty-measurement-side')
  })

  it('is inconclusive with the same reason for a run with no cells at all', () => {
    const decision = decide([])
    expect(decision.status).toBe('INCONCLUSIVE')
    expect(decision.inconclusiveReason).toBe('empty-measurement-side')
    expect(decision.referenceOverall).toBeNull()
    expect(decision.candidateOverall).toBeNull()
    expect(decision.failedCells).toBe(0)
  })

  it('still rejects a run that measured both sides yet shares no iteration', () => {
    // Both sides produced cells, but no iteration scored on both. Unlike an empty
    // side, this is a measured outcome with nothing to pair, so rule (b) keeps its
    // own verdict rather than inheriting the empty-side reason.
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('REJECTED')
    expect(decision.inconclusiveReason).toBeUndefined()
    expect(decision.pairs).toBe(0)
  })

  it('accepts only when every rule passes', () => {
    const decision = decide([
      ...improvingPairs(3, 2, { caseId: 'case-a', reference: 90 }),
      ...improvingPairs(3, 1, { caseId: 'case-b', reference: 70 }),
    ])
    expect(decision.pairs).toBe(6)
    expect(decision.status).toBe('ACCEPTED')
  })

  it('preserves non-empty cell feedback in input order', () => {
    const pairs = improvingPairs(6, 5)
    pairs[0]!.feedback = 'tighten the loop'
    pairs[1]!.feedback = 'improve error handling'
    const decision = decide(pairs)
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.feedback).toEqual(['tighten the loop', 'improve error handling'])
  })

  it('records autoRollback false, run identity, and a deterministic createdAt', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 85, status: 'ok' }),
    ])
    expect(decision.autoRollback).toBe(false)
    expect(decision.runId).toBe('run-1')
    expect(decision.refinementId).toBe('refine-1')
    expect(decision.createdAt).toBe('2026-08-19T12:00:00.000Z')
  })

  it('does not gate acceptance on passThreshold (report-only)', () => {
    // Both sides sit far below passThreshold and the candidate still improves
    // beyond the spread: passThreshold stays a reporting line, never a gate.
    const decision = decide(improvingPairs(6, 10, { reference: 10 }),
      { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.candidateOverall).toBeLessThan(60)
  })

  it('names the blocker so an inconclusive run is actionable', () => {
    const opts = { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 }
    // One iteration per side: the noise cannot be estimated.
    expect(decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 85, status: 'ok' }),
    ], opts).inconclusiveReason).toBe('no-noise-estimate')
    // A real improvement that stays inside the observed spread.
    expect(decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: 90, status: 'ok', iteration: 2 }),
      cell({ side: 'candidate', score: 85, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 2 }),
    ], opts).inconclusiveReason).toBe('difference-not-beyond-noise')
    // A dropped pair leaves only one paired iteration.
    expect(decide([
      cell({ side: 'reference', score: 80, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', score: null, status: 'failed', iteration: 2 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', score: 90, status: 'ok', iteration: 2 }),
    ], opts).inconclusiveReason).toBe('insufficient-paired-observations')
    // An improvement that clears the noise but is not consistent across pairs.
    expect(decide(improvingPairs(4, 5), opts).inconclusiveReason).toBe('improvement-not-consistent')
  })

  it('records no inconclusive reason when the run is accepted', () => {
    const decision = decide(improvingPairs(6, 15),
      { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.inconclusiveReason).toBeUndefined()
  })

  it('validates input cells through the decision path too', () => {
    expect(() => decide([cell({ side: 'candidate', score: 150, status: 'ok' })])).toThrow('score-out-of-range')
  })
})
