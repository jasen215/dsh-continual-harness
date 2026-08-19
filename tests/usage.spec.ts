import { describe, expect, it } from 'vitest'
import { usageKey, aggregateUsage } from '../src/usage.ts'

describe('usage telemetry', () => {
  it('builds scope-qualified keys', () => {
    expect(usageKey('global', 'memory', 'fact')).toBe('global:memory:fact')
    expect(usageKey('local', 'memory', 'fact', 's1')).toBe('local:s1:memory:fact')
  })

  it('aggregates counts and last-injected time', () => {
    const agg = aggregateUsage([
      { key: 'global:memory:fact', at: '2026-01-01T00:00:00.000Z' },
      { key: 'global:memory:fact', at: '2026-01-02T00:00:00.000Z' },
      { key: 'local:s1:memory:x', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(agg['global:memory:fact']).toEqual({ injectionCount: 2, lastInjectedAt: '2026-01-02T00:00:00.000Z' })
    expect(agg['local:s1:memory:x']?.injectionCount).toBe(1)
    expect(agg['global:memory:nope']).toBeUndefined()
  })

  it('uses the later event in file order even when its timestamp is earlier', () => {
    const agg = aggregateUsage([
      { key: 'global:memory:fact', at: '2026-01-02T00:00:00.000Z' },
      { key: 'global:memory:fact', at: '2026-01-01T00:00:00.000Z' },
    ])
    expect(agg['global:memory:fact']).toEqual({ injectionCount: 2, lastInjectedAt: '2026-01-01T00:00:00.000Z' })
  })
})
