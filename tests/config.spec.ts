import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import type { Config as ConfigSchema } from '../src/index.ts'

describe('config defaults', () => {
  // Every field has a `.default()`, so a profile that overrides one key may omit
  // the rest. That is load-bearing rather than cosmetic: an id-targeted override
  // *replaces* the whole config, so one required key would deactivate the entire
  // plugin for anyone overriding something unrelated — reported only as
  // `1 entry did not activate`. The `z<Config>` type annotates the *output*, so
  // partial input needs a cast at the call boundary.
  const base = {} as Partial<ConfigSchema>
  it('accepts a partial config that overrides one key', () => {
    const cfg = Config({ ...base, injectionAnchor: 'query' } as never)
    expect(cfg.injectionAnchor).toBe('query')
    expect(cfg.defaultGlobal).toBe(true)
  })
  it('defaults defaultGlobal to true', () => {
    expect(Config(base as never).defaultGlobal).toBe(true)
  })
  it('defaults injectionAnchor to stable', () => {
    // WHY stable: the block is re-published only when the harness state changes,
    // which is what keeps the provider's cached prefix alive across a topic
    // change (measured: 95.4% vs 81.2% cache-read hit rate on the same corpus).
    expect(Config(base as never).injectionAnchor).toBe('stable')
  })
  it('accepts an explicit query anchor', () => {
    expect(Config({ ...base, injectionAnchor: 'query' } as never).injectionAnchor).toBe('query')
  })
  it('rejects an unknown injectionAnchor', () => {
    expect(() => Config({ ...base, injectionAnchor: 'live' as never } as never)).toThrow()
  })
  it('defaults plannerPrefixCache to auto', () => {
    const cfg = Config(base as never)
    expect(cfg.plannerPrefixCache).toBe('auto')
  })
  it('defaults trajectorySignalRatio to 0.5', () => {
    const cfg = Config(base as never)
    expect(cfg.trajectorySignalRatio).toBe(0.5)
  })
  it('accepts explicit plannerPrefixCache values', () => {
    expect(Config({ ...base, plannerPrefixCache: 'off' } as never).plannerPrefixCache).toBe('off')
    expect(Config({ ...base, plannerPrefixCache: 'session' } as never).plannerPrefixCache).toBe('session')
  })
  it('rejects invalid plannerPrefixCache values', () => {
    expect(() => Config({ ...base, plannerPrefixCache: 'invalid' as never } as never)).toThrow()
  })
  it('defaults plannerTokenPerCharRatio to 0.5', () => {
    const cfg = Config(base as never)
    expect(cfg.plannerTokenPerCharRatio).toBe(0.5)
  })
  it('defaults plannerSafetyReserveTokens to 1024', () => {
    const cfg = Config(base as never)
    expect(cfg.plannerSafetyReserveTokens).toBe(1024)
  })
  it('defaults minPlannerOutputTokens to 4096', () => {
    const cfg = Config(base as never)
    expect(cfg.minPlannerOutputTokens).toBe(4096)
  })
  it('accepts explicit plannerTokenPerCharRatio values', () => {
    expect(Config({ ...base, plannerTokenPerCharRatio: 0.25 } as never).plannerTokenPerCharRatio).toBe(0.25)
  })
  it('rejects out-of-range plannerTokenPerCharRatio values', () => {
    expect(() => Config({ ...base, plannerTokenPerCharRatio: 1.5 } as never)).toThrow()
  })
})
