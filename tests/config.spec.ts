import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import type { Config as ConfigSchema } from '../src/index.ts'

describe('config defaults', () => {
  // The schema accepts partial input (every field but `defaultGlobal` has a
  // `.default()`); the `z<Config>` type annotates the *output* type, so the
  // partial input needs a cast at the call boundary.
  const base = { defaultGlobal: true } as Partial<ConfigSchema>
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
