import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendGlobalRefinement,
  appendLocalRefinement,
  emptyHarnessState,
  getGlobalHarnessStateDir,
  getLocalHarnessStateDir,
  loadGlobalRefinementHistory,
  loadHarnessState,
  loadSessionRefinementHistory,
  loadUsageEvents,
  migrateHarnessState,
  appendUsageEvent,
  appendUsageEvents,
  mergeHarnessStates,
  mergeRefinementHistory,
  saveHarnessState,
} from '../src/storage.ts'
import { USAGE_ARCHIVE_PREFIX, HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import type { RefinementResult } from '../src/types.ts'

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
    expect(loaded.schemaVersion).toBe(HARNESS_SCHEMA_VERSION)
  })

  it('migrates a v1 state file to v2, preserving entries and refinements', () => {
    const dir = getLocalHarnessStateDir(tempHome(), 'session-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'harness_state.json'), JSON.stringify({
      schemaVersion: 1,
      entries: {
        memory: { fact: { id: 'fact', kind: 'memory', version: 1, content: 'durable', updatedAt: '2026-01-01T00:00:00.000Z' } },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [{ id: 'r1', summary: 's', scope: 'local', committedAt: 't', appliedEdits: [] }],
    }), 'utf8')
    const loaded = loadHarnessState(dir)
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.entries.memory['fact']?.content).toBe('durable')
    expect(loaded.refinements).toHaveLength(1)
  })

  it('skips invalid entries individually and reports diagnostics', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 1,
      entries: {
        memory: {
          bad: { id: 'bad' },
          good: { id: 'good', kind: 'memory', version: 1, content: 'ok', updatedAt: 't' },
        },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [],
    })
    expect(state.entries.memory['good']?.content).toBe('ok')
    expect(state.entries.memory['bad']).toBeUndefined()
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('skips malformed buckets while migrating other kinds', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 1,
      entries: {
        memory: 'junk',
        prompt: { good: { id: 'good', kind: 'prompt', version: 1, content: 'ok', updatedAt: 't' } },
        skill: [],
        subagent: {},
      },
      refinements: [],
    })
    expect(state.entries.memory).toEqual({})
    expect(state.entries.prompt['good']?.content).toBe('ok')
    expect(state.entries.skill).toEqual({})
    expect(diagnostics).toContain('skipping invalid memory bucket')
    expect(diagnostics).toContain('skipping invalid skill bucket')
  })

  it('skips entries with unsupported kinds and reports diagnostics', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 1,
      entries: {
        memory: {
          bad: { id: 'bad', kind: 'bogus', version: 1, content: 'nope', updatedAt: 't' },
        },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [],
    })
    expect(state.entries.memory['bad']).toBeUndefined()
    expect(diagnostics).toContain('skipping invalid memory entry bad')
  })

  it('skips stale lifecycle metadata but preserves archived entries', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 1,
      entries: {
        memory: {
          stale: { id: 'stale', kind: 'memory', version: 1, content: 'nope', updatedAt: 't', metadata: { lifecycleState: 'stale' } },
          archived: { id: 'archived', kind: 'memory', version: 1, content: 'ok', updatedAt: 't', metadata: { lifecycleState: 'archived' } },
        },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [],
    })
    expect(state.entries.memory['stale']).toBeUndefined()
    expect(state.entries.memory['archived']?.metadata?.lifecycleState).toBe('archived')
    expect(diagnostics).toContain('skipping invalid memory entry stale')
  })

  it('validates all present metadata field types during migration', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 1,
      entries: {
        memory: {
          badSource: { id: 'badSource', kind: 'memory', version: 1, content: 'nope', updatedAt: 't', metadata: { sourceSession: 123 } },
          badPinned: { id: 'badPinned', kind: 'memory', version: 1, content: 'nope', updatedAt: 't', metadata: { pinned: 'yes' } },
          badInjected: { id: 'badInjected', kind: 'memory', version: 1, content: 'nope', updatedAt: 't', metadata: { lastInjectedAt: 5 } },
          valid: {
            id: 'valid', kind: 'memory', version: 1, content: 'ok', updatedAt: 't',
            metadata: { sourceSession: 'session-1', lifecycleState: 'active', pinned: true, lastInjectedAt: '2026-01-01T00:00:00.000Z' },
          },
        },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [],
    })
    expect(state.entries.memory['badSource']).toBeUndefined()
    expect(state.entries.memory['badPinned']).toBeUndefined()
    expect(state.entries.memory['badInjected']).toBeUndefined()
    expect(state.entries.memory['valid']?.metadata).toEqual({
      sourceSession: 'session-1', lifecycleState: 'active', pinned: true, lastInjectedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(diagnostics).toEqual(expect.arrayContaining([
      'skipping invalid memory entry badSource',
      'skipping invalid memory entry badPinned',
      'skipping invalid memory entry badInjected',
    ]))
  })

  it('refuses a future schema version and keeps the file untouched', () => {
    const dir = getLocalHarnessStateDir(tempHome(), 'session-1')
    mkdirSync(dir, { recursive: true })
    const future = JSON.stringify({ schemaVersion: 99, entries: {}, refinements: [] })
    writeFileSync(join(dir, 'harness_state.json'), future, 'utf8')
    expect(loadHarnessState(dir)).toEqual(emptyHarnessState())
    expect(readFileSync(join(dir, 'harness_state.json'), 'utf8')).toBe(future)
  })

  it('appends and loads usage events, skipping bad lines', () => {
    const home = tempHome()
    appendUsageEvent(home, { key: 'global:memory:fact', at: '2026-01-01T00:00:00.000Z' })
    appendUsageEvent(home, { key: 'local:s1:memory:x', at: '2026-01-02T00:00:00.000Z' })
    appendFileSync(join(home, 'usage.events.jsonl'), '{not json}\n', 'utf8')
    const events = loadUsageEvents(home)
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ key: 'global:memory:fact', at: '2026-01-01T00:00:00.000Z' })
  })

  it('rotates usage.events.jsonl past the size threshold and loads across archives in order', () => {
    const home = tempHome()
    const tiny = 200 // bytes; small enough to trip rotation without MB-scale fixtures
    appendUsageEvents(home, [{ key: 'k:1', at: '2026-01-01T00:00:00.000Z' }], tiny)
    // Fill the active file past the threshold: ~20 events × ~55 bytes each.
    const batch = Array.from({ length: 20 }, (_, i) => ({ key: `k:${i + 2}`, at: `2026-01-01T00:00:0${i}.000Z` }))
    appendUsageEvents(home, batch, tiny)
    // The next append must archive the oversized file before writing.
    appendUsageEvents(home, [{ key: 'k:new', at: '2026-01-02T00:00:00.000Z' }], tiny)

    const files = readdirSync(home).filter(name => name.startsWith(USAGE_ARCHIVE_PREFIX)).sort()
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.some(name => name.startsWith(USAGE_ARCHIVE_PREFIX))).toBe(true)

    const events = loadUsageEvents(home)
    expect(events).toHaveLength(22) // 1 + 20 + 1 across the rotation boundary
    expect(events[0]).toEqual({ key: 'k:1', at: '2026-01-01T00:00:00.000Z' })
    expect(events[events.length - 1]).toEqual({ key: 'k:new', at: '2026-01-02T00:00:00.000Z' })
    // The active file restarted small instead of continuing to grow.
    expect(statSync(join(home, 'usage.events.jsonl')).size).toBeLessThan(tiny)
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

  it('backs up a corrupt state file before a later commit can overwrite it', () => {
    const home = tempHome()
    const dir = getGlobalHarnessStateDir(home)
    mkdirSync(dir, { recursive: true })
    const corrupt = '{not json'
    writeFileSync(join(dir, 'harness_state.json'), corrupt, 'utf8')
    const diagnostics: string[] = []
    expect(loadHarnessState(dir, (lines) => diagnostics.push(...lines))).toEqual(emptyHarnessState())
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(corrupt)
    expect(diagnostics.some((line) => line.includes('backed up to'))).toBe(true)
  })

  it('backs up a corrupt state file only once across repeated loads', () => {
    const home = tempHome()
    const dir = getGlobalHarnessStateDir(home)
    mkdirSync(dir, { recursive: true })
    const corrupt = '{not json'
    writeFileSync(join(dir, 'harness_state.json'), corrupt, 'utf8')
    const diagnostics: string[] = []
    for (let i = 0; i < 3; i++) {
      expect(loadHarnessState(dir, (lines) => diagnostics.push(...lines))).toEqual(emptyHarnessState())
    }
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(diagnostics.filter((line) => line.includes('backed up to'))).toHaveLength(1)
    expect(diagnostics.filter((line) => line.includes('already backed up'))).toHaveLength(2)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(corrupt)
  })

  it('backs up a future-version state file the same way', () => {
    const home = tempHome()
    const dir = getLocalHarnessStateDir(home, 'session-bak')
    mkdirSync(dir, { recursive: true })
    const future = JSON.stringify({ schemaVersion: 99, entries: {}, refinements: [] })
    writeFileSync(join(dir, 'harness_state.json'), future, 'utf8')
    loadHarnessState(dir)
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(future)
  })

  it('the backup survives the next save that would previously have wiped the data', () => {
    const home = tempHome()
    const dir = getGlobalHarnessStateDir(home)
    mkdirSync(dir, { recursive: true })
    const corrupt = '{not json'
    writeFileSync(join(dir, 'harness_state.json'), corrupt, 'utf8')
    const state = loadHarnessState(dir)
    saveHarnessState(dir, state) // applyRefinement 的提交路径最终都走到这里
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(corrupt)
    expect(JSON.parse(readFileSync(join(dir, 'harness_state.json'), 'utf8'))).toHaveProperty('schemaVersion', HARNESS_SCHEMA_VERSION)
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

  it('appends and reloads the session-local refinement journal per session', () => {
    const home = tempHome()
    const result: RefinementResult = { id: 'r10', summary: 's', appliedEdits: [], committedAt: 't', scope: 'local' }
    appendLocalRefinement(home, 'session-a', result)
    expect(loadSessionRefinementHistory(home, 'session-a')).toEqual([result])
    expect(loadSessionRefinementHistory(home, 'session-b')).toEqual([])
  })
})
