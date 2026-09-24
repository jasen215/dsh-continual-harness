/**
 * Planner route detection for warm-cache planning (spec §2.1): the session's
 * recorded cache-read evidence decides whether the provider can serve a warm
 * prefix (Route A) or whether the deterministic trajectory summary must be used
 * instead (Route B).
 *
 * The evidence is per event: `AssistantMessage` carries no `usage`, so the
 * derived history cannot answer this and the committed event is the only
 * source — see session-state.ts, which observes it as it arrives.
 * @module dsh-continual-harness
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Which planning input shape to use: A = warm-cache session prefix, B = layered summary. */
export type PlannerRoute = 'A' | 'B'

/** Routing mode for planner prefix caching. */
export type PlannerPrefixCacheMode = 'auto' | 'session' | 'off'

/**
 * True when one committed event is cache-read evidence: a recorded model call
 * that reported cache-read tokens proves the provider can serve a warm prefix.
 * Reads the one source the spec allows: `assistant/message` carries the step's
 * `usage` on the event wrapper, so the model output and its accounting travel
 * together. (dsh 0.1.5 removed the separate `assistant/chunk` event; its
 * `usage` chunk is folded into this single record rather than lost.)
 */
export function isCacheEvidenceEvent(event: SessionEvent): boolean {
  return event.type === 'assistant/message' && (event.data.usage?.cacheReadTokens ?? 0) > 0
}

/** Pick the planning route per spec §2.1 lifecycle table. */
export function detectPlannerRoute(cacheEvidence: boolean, mode: PlannerPrefixCacheMode): PlannerRoute {
  if (mode === 'session') return 'A'
  if (mode === 'off') return 'B'
  return cacheEvidence ? 'A' : 'B'
}
