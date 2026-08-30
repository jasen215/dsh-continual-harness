import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('config defaults', () => {
  const base = { defaultGlobal: true } // the schema's only required field
  it('defaults plannerPrefixCache to auto', () => {
    const cfg = Config(base)
    expect(cfg.plannerPrefixCache).toBe('auto')
  })
  it('defaults trajectorySignalRatio to 0.5', () => {
    const cfg = Config(base)
    expect(cfg.trajectorySignalRatio).toBe(0.5)
  })
  it('accepts explicit plannerPrefixCache values', () => {
    expect(Config({ ...base, plannerPrefixCache: 'off' }).plannerPrefixCache).toBe('off')
    expect(Config({ ...base, plannerPrefixCache: 'session' }).plannerPrefixCache).toBe('session')
  })
  it('rejects invalid plannerPrefixCache values', () => {
    expect(() => Config({ ...base, plannerPrefixCache: 'invalid' as never })).toThrow()
  })
})
