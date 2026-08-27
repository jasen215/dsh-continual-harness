/**
 * Injection telemetry: scope-qualified usage keys and in-memory aggregation
 * over `usage.events.jsonl`. Approximate telemetry only — never proof that the
 * model read or cited an entry. MVP: no snapshot/compact/lock; the active log
 * rotates by size threshold into epoch-stamped archives (see storage.ts).
 * @module dsh-continual-harness
 */

import type { RefinementKind } from './types.ts'

/** One injection event line. */
export interface UsageEvent {
  key: string
  at: string
}

/** Aggregated stats for one scope-qualified key. */
export interface UsageStats {
  injectionCount: number
  lastInjectedAt?: string
}

/** Build the scope-qualified usage key for an entry. */
export function usageKey(
  scope: 'local' | 'global',
  kind: RefinementKind,
  id: string,
  sessionId?: string,
): string {
  return scope === 'global'
    ? `global:${kind}:${id}`
    : `local:${sessionId}:${kind}:${id}`
}

/** Aggregate events in file order; later `at` wins as lastInjectedAt. */
export function aggregateUsage(events: UsageEvent[]): Record<string, UsageStats> {
  const stats: Record<string, UsageStats> = {}
  for (const event of events) {
    const current = stats[event.key] ?? { injectionCount: 0 }
    current.injectionCount += 1
    current.lastInjectedAt = event.at
    stats[event.key] = current
  }
  return stats
}
