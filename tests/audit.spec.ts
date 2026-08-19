import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendReview, gateOutcome, loadReviews, REVIEWS_FILE_NAME } from '../src/audit.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-audit-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('audit', () => {
  it('roundtrips appended review records in file order with full fields', () => {
    const home = tempHome()
    appendReview(home, {
      timestamp: '2026-08-19T00:00:00.000Z',
      sessionId: 's1',
      trigger: 'turn-interval',
      turnsSinceLastReview: 25,
      outcome: 'approved',
      rationale: 'interval reached',
      refinementId: 'auto_1',
      rejectedEdits: [{ kind: 'memory', id: 'm1', action: 'update', error: 'rejected' }],
    })
    appendReview(home, {
      timestamp: '2026-08-19T00:00:01.000Z',
      sessionId: 's1',
      trigger: 'compact',
      turnsSinceLastReview: 4,
      outcome: 'declined',
      rationale: 'nothing new',
    })

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(2)
    expect(reviews[0]).toMatchObject({
      timestamp: '2026-08-19T00:00:00.000Z',
      sessionId: 's1',
      trigger: 'turn-interval',
      turnsSinceLastReview: 25,
      outcome: 'approved',
      rationale: 'interval reached',
      refinementId: 'auto_1',
    })
    expect(reviews[0]?.rejectedEdits).toEqual([{ kind: 'memory', id: 'm1', action: 'update', error: 'rejected' }])
    expect(reviews[1]).toMatchObject({ trigger: 'compact', outcome: 'declined', rationale: 'nothing new' })
  })

  it('keeps the trigger reason separate from an edit rejection reason', () => {
    const home = tempHome()
    appendReview(home, {
      timestamp: '2026-08-19T00:00:00.000Z',
      sessionId: 's2',
      trigger: 'turn-interval',
      turnsSinceLastReview: 25,
      outcome: 'approved',
      rejectedEdits: [{ kind: 'prompt', id: 'p1', action: 'update', error: 'missing reason' }],
    })

    const [review] = loadReviews(home)
    expect(review?.trigger).toBe('turn-interval')
    expect(review?.rejectedEdits?.[0]?.error).toBe('missing reason')
    expect(review?.trigger).not.toBe(review?.rejectedEdits?.[0]?.error)
  })

  it('maps gate outcomes from approval and applied counts', () => {
    expect(gateOutcome(false, 3, 1)).toBe('declined')
    expect(gateOutcome(true, 0, 0)).toBe('assessed')
    expect(gateOutcome(true, 2, 1)).toBe('approved')
    // approved plan with edits but zero applied is a failed gate
    expect(gateOutcome(true, 2, 0)).toBe('failed')
  })

  it('skips corrupt lines and returns good records in order', () => {
    const home = tempHome()
    appendReview(home, {
      timestamp: '2026-08-19T00:00:00.000Z',
      sessionId: 's3',
      trigger: 'manual',
      turnsSinceLastReview: 0,
      outcome: 'declined',
      rationale: 'first',
    })
    writeFileSync(join(home, REVIEWS_FILE_NAME), 'this is not json\n', { flag: 'a' })
    appendReview(home, {
      timestamp: '2026-08-19T00:00:02.000Z',
      sessionId: 's3',
      trigger: 'compact',
      turnsSinceLastReview: 1,
      outcome: 'assessed',
      rationale: 'third',
    })

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(2)
    expect(reviews[0]?.rationale).toBe('first')
    expect(reviews[1]?.rationale).toBe('third')
  })

  it('returns an empty list when the reviews file does not exist', () => {
    expect(loadReviews(tempHome())).toEqual([])
  })
})
