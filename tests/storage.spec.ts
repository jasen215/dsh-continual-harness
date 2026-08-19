import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendGlobalRefinement,
  emptyHarnessState,
  getGlobalHarnessStateDir,
  getLocalHarnessStateDir,
  loadGlobalRefinementHistory,
  loadHarnessState,
  mergeHarnessStates,
  mergeRefinementHistory,
  saveHarnessState,
} from '../src/storage.ts'
import type { HarnessState, RefinementResult } from '../src/types.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('harness state storage', () => {
  it('keeps global and local stores directly under the harness home', () => {
    const home = tempHome()
    expect(getGlobalHarnessStateDir(home)).toBe(home)
    expect(getLocalHarnessStateDir(home, 'session-1')).toBe(join(home, 'sessions', 'session-1'))
  })

  it('round-trips state through save and load', () => {
    const home = tempHome()
    const dir = getLocalHarnessStateDir(home, 'session-1')
    const state = emptyHarnessState()
    state.entries.memory['fact'] = { id: 'fact', kind: 'memory', version: 1, content: 'durable', updatedAt: '2026-01-01T00:00:00.000Z' }
    saveHarnessState(dir, state)
    const loaded = loadHarnessState(dir)
    expect(loaded.entries.memory['fact']?.content).toBe('durable')
    expect(loaded.schemaVersion).toBe(1)
  })

  it('degrades a corrupt or version-mismatched file to empty state', () => {
    const home = tempHome()
    const dir = getGlobalHarnessStateDir(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'harness_state.json'), '{not json', 'utf8')
    expect(loadHarnessState(dir)).toEqual(emptyHarnessState())
    writeFileSync(join(dir, 'harness_state.json'), JSON.stringify({ schemaVersion: 99, entries: {}, refinements: [] }), 'utf8')
    expect(loadHarnessState(dir)).toEqual(emptyHarnessState())
  })

  it('merges local over global with same-id shadowing under a local: prefix', () => {
    const global = emptyHarnessState()
    global.entries.prompt['style'] = { id: 'style', kind: 'prompt', version: 1, content: 'global', updatedAt: 't' }
    const local = emptyHarnessState()
    local.entries.prompt['style'] = { id: 'style', kind: 'prompt', version: 1, content: 'local', updatedAt: 't' }
    const merged = mergeHarnessStates(global, local)
    expect(merged.entries.prompt['style']?.content).toBe('local')
    expect(merged.entries.prompt['local:style']?.content).toBe('global')
  })

  it('merges refinement histories with session events first and dedup by id', () => {
    const local: RefinementResult[] = [{ id: 'r1', summary: 'a', appliedEdits: [], committedAt: 't', scope: 'local' }]
    const global: RefinementResult[] = [
      { id: 'r1', summary: 'a', appliedEdits: [], committedAt: 't', scope: 'global' },
      { id: 'r2', summary: 'b', appliedEdits: [], committedAt: 't', scope: 'global' },
    ]
    const merged = mergeRefinementHistory(local, global)
    expect(merged.map(result => result.id)).toEqual(['r1', 'r2'])
  })

  it('appends and reloads the global refinement history', () => {
    const home = tempHome()
    const result: RefinementResult = { id: 'r9', summary: 's', appliedEdits: [], committedAt: 't', scope: 'global' }
    appendGlobalRefinement(home, result)
    const history = loadGlobalRefinementHistory(home)
    expect(history).toEqual([result])
  })
})
