/**
 * Session wrap-up suggestions: mechanical keep/promote/archive classification
 * of session-local entries from injection telemetry and global coverage.
 * MVP: suggestions only; writes go through the existing refine/apply path.
 * @module dsh-continual-harness
 */

import { usageKey } from './usage.ts'
import type { HarnessState, RefinementKind } from './types.ts'

/** Per-entry wrap-up verdict. */
export interface WrapupSuggestion {
  id: string
  kind: RefinementKind
  fate: 'keep' | 'promote' | 'archive'
  reason: string
}

/** Classify local entries: never injected -> archive; used without a same-id
 * global -> promote; otherwise keep. Deterministic, no LLM in MVP. */
export function suggestWrapup(
  local: HarnessState,
  global: HarnessState,
  usageFor: (key: string) => { injectionCount: number } | undefined,
  sessionId: string,
): WrapupSuggestion[] {
  const suggestions: WrapupSuggestion[] = []
  for (const kind of Object.keys(local.entries) as RefinementKind[]) {
    for (const [id] of Object.entries(local.entries[kind])) {
      const stats = usageFor(usageKey('local', kind, id, sessionId))
      const count = stats?.injectionCount ?? 0
      if (count === 0) {
        suggestions.push({ id, kind, fate: 'archive', reason: `never injected (${count} uses)` })
      } else if (global.entries[kind][id] === undefined) {
        suggestions.push({ id, kind, fate: 'promote', reason: `${count} injections, no same-id global` })
      } else {
        suggestions.push({ id, kind, fate: 'keep', reason: `${count} injections, global already covers id` })
      }
    }
  }
  return suggestions
}
