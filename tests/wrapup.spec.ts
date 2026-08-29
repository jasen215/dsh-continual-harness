import { describe, expect, it } from 'vitest'
import { suggestWrapup } from '../src/wrapup.ts'
import { freshState } from '../src/refine.ts'
import { usageKey } from '../src/usage.ts'

describe('suggestWrapup', () => {
  it('suggests archive for never-injected, promote for used without global, keep otherwise', () => {
    const local = freshState()
    local.entries.memory['never'] = { id: 'never', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    local.entries.memory['used'] = { id: 'used', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    local.entries.memory['covered'] = { id: 'covered', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    const global = freshState()
    global.entries.memory['covered'] = { id: 'covered', kind: 'memory', version: 1, content: 'g', updatedAt: 't' }
    const usageFor = (key: string) =>
      key === usageKey('local', 'memory', 'used', 's1') || key === usageKey('local', 'memory', 'covered', 's1')
        ? { injectionCount: 3 }
        : undefined

    const suggestions = suggestWrapup(local, global, usageFor, 's1')
    const byId = Object.fromEntries(suggestions.map(s => [s.id, s.fate]))
    expect(byId['never']).toBe('archive')
    expect(byId['used']).toBe('promote')
    expect(byId['covered']).toBe('keep')
  })
})
