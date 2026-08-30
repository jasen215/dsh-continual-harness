/**
 * Planner route detection for warm-cache planning (spec §2.1): read the
 * session's usage records to decide whether the provider can serve a warm
 * prefix (Route A) or whether the deterministic trajectory summary must be
 * used instead (Route B).
 *
 * @module dsh-continual-harness
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Which planning input shape to use: A = warm-cache session prefix, B = layered summary. */
export type PlannerRoute = 'A' | 'B'

/** Routing mode for planner prefix caching. */
export type PlannerPrefixCacheMode = 'auto' | 'session' | 'off'

/**
 * True when any recorded model call in this session reported cache-read
 * tokens — evidence the provider can serve a warm prefix. Reads the same two
 * sources the spec allows: `assistant/message` events carry `usage` on the
 * event wrapper; `assistant/chunk` events of `type: 'usage'` carry it on the
 * chunk. Non-surface `assistant/chunk` events need no surfaceOp on append.
 */
export function hasCacheEvidence(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type === 'assistant/message') {
      if ((event.data.usage?.cacheReadTokens ?? 0) > 0) return true
    } else if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk as { type: 'usage'; usage?: { cacheReadTokens?: number } } | undefined
      if (chunk?.type === 'usage' && (chunk.usage?.cacheReadTokens ?? 0) > 0) return true
    }
  }
  return false
}

/** Pick the planning route per spec §2.1 lifecycle table. */
export function detectPlannerRoute(events: readonly SessionEvent[], mode: PlannerPrefixCacheMode): PlannerRoute {
  if (mode === 'session') return 'A'
  if (mode === 'off') return 'B'
  return hasCacheEvidence(events) ? 'A' : 'B'
}
