import { describe, expect, it } from 'vitest'
import type { BenchmarkDecision, CellScore } from '../src/benchmark.ts'
import { aggregateCells, decideBenchmark } from '../src/score.ts'
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

  it('computes per-case means for both sides', () => {
    const result = aggregateCells([
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-a', score: 80, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', caseId: 'case-b', score: 60, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-a', score: 90, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-b', score: 66, status: 'ok' }),
    ])
    expect(result.perCase['case-a']).toEqual({ reference: 90, candidate: 90 })
    expect(result.perCase['case-b']).toEqual({ reference: 60, candidate: 66 })
  })

  it('records a null side mean for a case seen on only one side', () => {
    const result = aggregateCells([
      cell({ side: 'candidate', caseId: 'case-a', score: 70, status: 'ok' }),
    ])
    expect(result.perCase['case-a']).toEqual({ reference: null, candidate: 70 })
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
    expect(result.perCase['case-a']).toEqual({ reference: 80, candidate: null })
    expect(result.usableCandidate).toBe(0)
    expect(result.failedCells).toBe(1)
  })

  it('applies default options when none are given', () => {
    const result = aggregateCells([cell({ side: 'reference', score: 80, status: 'ok' })])
    expect(result.referenceOverall).toBe(80)
  })
})

describe('decideBenchmark', () => {
  it('accepts candidate improvement', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 85, status: 'ok' }),
    ])
    expect(decision.status).toBe('ACCEPTED')
    expect(decision.referenceOverall).toBe(80)
    expect(decision.candidateOverall).toBe(85)
    expect(decision.regressionCases).toEqual([])
    expect(decision.failedCells).toBe(0)
  })

  it('accepts equal scores', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 80, status: 'ok' }),
    ])
    expect(decision.status).toBe('ACCEPTED')
  })

  it('rejects overall regression even when no case regresses', () => {
    // Reference: case-a 2x100, case-b 1x0  -> overall 66.67.
    // Candidate: case-a 1x100, case-b 2x0  -> overall 33.33; every per-case mean
    // is at least the reference's, so only the overall rule can reject.
    const decision = decide([
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 1 }),
      cell({ side: 'reference', caseId: 'case-a', score: 100, status: 'ok', iteration: 2 }),
      cell({ side: 'reference', caseId: 'case-b', score: 0, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-a', score: 100, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-b', score: 0, status: 'ok', iteration: 1 }),
      cell({ side: 'candidate', caseId: 'case-b', score: 0, status: 'ok', iteration: 2 }),
    ])
    expect(decision.status).toBe('REJECTED')
    expect(decision.referenceOverall).toBeCloseTo(66.67, 2)
    expect(decision.candidateOverall).toBeCloseTo(33.33, 2)
    expect(decision.regressionCases).toEqual([])
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

  it('rejects when candidate failed cells exceed maxFailedCells', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: null, status: 'failed', iteration: 1 }),
      cell({ side: 'candidate', score: null, status: 'failed', iteration: 2 }),
      cell({ side: 'candidate', score: 85, status: 'ok', iteration: 3 }),
    ], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 1 })
    expect(decision.status).toBe('REJECTED')
    expect(decision.failedCells).toBe(2)
  })

  it('accepts a candidate regression within tolerance', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 78, status: 'ok' }),
    ], { passThreshold: 60, regressionTolerance: 5, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
  })

  it('rejects a candidate regression beyond tolerance', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: 74, status: 'ok' }),
    ], { passThreshold: 60, regressionTolerance: 5, maxFailedCells: 0 })
    expect(decision.status).toBe('REJECTED')
    expect(decision.regressionCases).toEqual(['case-a'])
  })

  it('rejects when a side has no usable cells (insufficient evidence)', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok' }),
      cell({ side: 'candidate', score: null, status: 'failed' }),
    ])
    expect(decision.status).toBe('REJECTED')
    expect(decision.referenceOverall).toBe(80)
    expect(decision.candidateOverall).toBeNull()
    expect(decision.regressionCases).toEqual([])
  })

  it('rejects empty input with no usable cells on either side', () => {
    const decision = decide([])
    expect(decision.status).toBe('REJECTED')
    expect(decision.referenceOverall).toBeNull()
    expect(decision.candidateOverall).toBeNull()
    expect(decision.failedCells).toBe(0)
  })

  it('accepts only when every rule passes', () => {
    const decision = decide([
      cell({ side: 'reference', caseId: 'case-a', score: 90, status: 'ok' }),
      cell({ side: 'reference', caseId: 'case-b', score: 70, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-a', score: 92, status: 'ok' }),
      cell({ side: 'candidate', caseId: 'case-b', score: 71, status: 'ok' }),
    ])
    expect(decision.status).toBe('ACCEPTED')
  })

  it('preserves non-empty cell feedback in input order', () => {
    const decision = decide([
      cell({ side: 'reference', score: 80, status: 'ok', feedback: 'tighten the loop' }),
      cell({ side: 'candidate', score: 85, status: 'ok', feedback: 'improve error handling' }),
      cell({ side: 'candidate', score: 85, status: 'ok', iteration: 2 }),
    ])
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
    // Equal scores below passThreshold are still accepted: the spec keeps
    // passThreshold for reporting only, never as an acceptance condition.
    const decision = decide([
      cell({ side: 'reference', score: 55, status: 'ok' }),
      cell({ side: 'candidate', score: 55, status: 'ok' }),
    ], { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 })
    expect(decision.status).toBe('ACCEPTED')
  })

  it('validates input cells through the decision path too', () => {
    expect(() => decide([cell({ side: 'candidate', score: 150, status: 'ok' })])).toThrow('score-out-of-range')
  })
})
