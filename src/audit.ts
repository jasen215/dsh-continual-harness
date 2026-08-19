/**
 * Persistent gate-verdict audit: every automatic refinement gate pass appends
 * one JSON line to `reviews.jsonl` under the harness home, so verdicts,
 * rationales, and rejected edits survive restarts. Write failures never break
 * the gate loop; the driver swallows them.
 * @module dsh-continual-harness
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RefinementAction, RefinementKind } from './types.ts'

/** Audit file name under the harness home. */
export const REVIEWS_FILE_NAME = 'reviews.jsonl'

/** One durable gate verdict line. */
export interface ReviewRecord {
  /** ISO timestamp of the verdict. */
  timestamp: string
  /** The audited session id. */
  sessionId: string
  /** What triggered the gate pass. */
  trigger: 'turn-interval' | 'compact' | 'manual'
  /** Assistant turns since the last review (0 when the counter was reset). */
  turnsSinceLastReview: number
  /** The gate verdict. */
  outcome: 'approved' | 'declined' | 'failed' | 'assessed' | 'deferred'
  /** One-line justification from the review gate. */
  rationale?: string
  /** Id of the committed refinement, when one was applied. */
  refinementId?: string
  /** Edits the plan carried but the store rejected, with per-edit errors. */
  rejectedEdits?: Array<{ kind: RefinementKind; id: string; action: RefinementAction; error: string }>
}

/** Append one verdict line to `reviews.jsonl` under home. Throws on failure. */
export function appendReview(home: string, record: ReviewRecord): void {
  mkdirSync(home, { recursive: true })
  appendFileSync(join(home, REVIEWS_FILE_NAME), `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Read the audit trail in file order. A missing file yields an empty list;
 * corrupt (non-JSON) lines are skipped so one bad line never hides the rest.
 */
export function loadReviews(home: string): ReviewRecord[] {
  let text: string
  try {
    text = readFileSync(join(home, REVIEWS_FILE_NAME), 'utf8')
  } catch {
    return []
  }
  const records: ReviewRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as ReviewRecord)
    } catch {
      // skip the corrupt line
    }
  }
  return records
}

/**
 * Map the gate flow onto a durable outcome: a rejected review is `declined`;
 * an approved review with an empty plan is `assessed`; otherwise applied edits
 * decide between `approved` and `failed`.
 */
export function gateOutcome(approved: boolean, plannedEdits: number, applied: number): ReviewRecord['outcome'] {
  if (!approved) return 'declined'
  if (plannedEdits === 0) return 'assessed'
  if (applied > 0) return 'approved'
  return 'failed'
}
