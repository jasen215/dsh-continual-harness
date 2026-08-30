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
})
