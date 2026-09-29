import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendGlobalRefinement, appendLocalRefinement, appendUsageEvent, appendUsageEvents, backfillBlastRadius, emptyHarnessState, getGlobalHarnessStateDir, getLocalHarnessStateDir, loadGlobalRefinementHistory, loadHarnessState, loadSessionRefinementHistory, loadUsageEvents, mergeHarnessStates, mergeRefinementHistory, migrateHarnessState, normalizeBlastRadius, saveHarnessState } from '../src/storage.ts'
import { USAGE_ARCHIVE_PREFIX, HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
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

  it('rejects a malformed projects tag rather than loading a file that breaks ranking', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 2,
      entries: {
        memory: {
          wrong: { id: 'wrong', kind: 'memory', version: 1, content: 'x', updatedAt: 't', projects: 'not-an-array' },
          mixed: { id: 'mixed', kind: 'memory', version: 1, content: 'x', updatedAt: 't', projects: ['ok', 7] },
        },
        prompt: {}, skill: {}, subagent: {},
      },
      refinements: [],
    })
    // Ranking calls `projects.includes`; a non-string member would throw mid-render.
    expect(state.entries.memory['wrong']).toBeUndefined()
    expect(state.entries.memory['mixed']).toBeUndefined()
    expect(diagnostics).toContain('skipping invalid memory entry wrong')
    expect(diagnostics).toContain('skipping invalid memory entry mixed')
  })

  it('loads an entry written before the projects field existed, untagged', () => {
    const { state, diagnostics } = migrateHarnessState({
      schemaVersion: 2,
      entries: { memory: { old: { id: 'old', kind: 'memory', version: 1, content: 'x', updatedAt: 't' } }, prompt: {}, skill: {}, subagent: {} },
      refinements: [],
    })
    expect(diagnostics).toEqual([])
    expect(state.entries.memory['old']?.projects).toBeUndefined()
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
    const backups = readdirSync(dir).filter((name) => name.endsWith('.corrupt.bak'))
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
    const backups = readdirSync(dir).filter((name) => name.endsWith('.corrupt.bak'))
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
    const backups = readdirSync(dir).filter((name) => name.endsWith('.corrupt.bak'))
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
    saveHarnessState(dir, state) // the commit path that applyRefinement ends up on
    const backups = readdirSync(dir).filter((name) => name.endsWith('.corrupt.bak'))
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

describe('blastRadius backfill', () => {
  const baseEntry = (id: string, extra: Record<string, unknown> = {}) => ({
    id, kind: 'memory' as const, version: 1, content: 'c', updatedAt: '2026-09-29T00:00:00Z', ...extra,
  })
  const baseEdit = (id: string, extra: Record<string, unknown> = {}) => ({
    action: 'create' as const, kind: 'memory' as const, id, applied: true, ...extra,
  })
  const stateWith = (entries: Array<{ id: string }>, edits: unknown[][]): HarnessState => ({
    schemaVersion: HARNESS_SCHEMA_VERSION,
    entries: {
      prompt: {},
      memory: Object.fromEntries(entries.map(entry => [entry.id, entry])),
      skill: {},
      subagent: {},
    },
    refinements: edits.map((appliedEdits, i) => ({ id: `r${i}`, summary: 's', appliedEdits, committedAt: 't', scope: 'local' })),
  }) as unknown as HarnessState
  it('clears an out-of-domain radius but keeps the entry', () => {
    const state = stateWith([baseEntry('a', { blastRadius: 'global' })], [])
    expect(normalizeBlastRadius(state)).toBe(1)
    // Losing a memory over one stale field would be worse than the stale value.
    expect(state.entries.memory.a).toBeDefined()
    expect(state.entries.memory.a.blastRadius).toBeUndefined()
  })

  it('lets history refill a cleared radius instead of leaving it invented', () => {
    const state = stateWith([baseEntry('a', { blastRadius: 7 })], [[baseEdit('a', { blastRadius: 'project' })]])
    expect(normalizeBlastRadius(state)).toBe(1)
    expect(backfillBlastRadius(state)).toEqual({ filled: 1, undeclared: 0 })
    expect(state.entries.memory.a.blastRadius).toBe('project')
  })

  it('leaves an in-domain radius untouched', () => {
    const state = stateWith([baseEntry('a', { blastRadius: 'session' }), baseEntry('b')], [])
    expect(normalizeBlastRadius(state)).toBe(0)
    expect(state.entries.memory.a.blastRadius).toBe('session')
    expect(state.entries.memory.b.blastRadius).toBeUndefined()
  })

  it('reports the clearing through migrate diagnostics', () => {
    const parsed = {
      schemaVersion: 1,
      entries: { memory: { a: baseEntry('a', { blastRadius: 'global' }) } },
      refinements: [],
    }
    const { state, diagnostics } = migrateHarnessState(parsed)
    expect(diagnostics.some(line => line.includes('out-of-domain'))).toBe(true)
    expect(state.entries.memory.a).toBeDefined()
  })

  it('takes the last successful edit\'s radius', () => {
    const state = stateWith([baseEntry('a')], [
      [baseEdit('a', { blastRadius: 'project' })],
      [baseEdit('a', { blastRadius: 'session' })],
    ])
    expect(backfillBlastRadius(state)).toEqual({ filled: 1, undeclared: 0 })
    expect(state.entries.memory.a.blastRadius).toBe('session')
  })

  it('skips rejected edits, whose radius can be a fallback rather than a declaration', () => {
    const state = stateWith([baseEntry('a')], [
      [baseEdit('a', { blastRadius: 'project' })],
      [baseEdit('a', { blastRadius: 'general', applied: false, error: 'rejected' })],
    ])
    expect(backfillBlastRadius(state)).toEqual({ filled: 1, undeclared: 0 })
    expect(state.entries.memory.a.blastRadius).toBe('project')
  })

  it('leaves an entry undeclared when no successful edit declared a valid radius', () => {
    const state = stateWith([baseEntry('a'), baseEntry('b')], [
      [baseEdit('a', { blastRadius: 'bogus' })],
      [baseEdit('b', { applied: false })],
    ])
    expect(backfillBlastRadius(state)).toEqual({ filled: 0, undeclared: 2 })
    expect(state.entries.memory.a.blastRadius).toBeUndefined()
    expect(state.entries.memory.b.blastRadius).toBeUndefined()
  })

  it('never overwrites a radius already on the entry, and is idempotent', () => {
    const state = stateWith([baseEntry('a', { blastRadius: 'general' })], [[baseEdit('a', { blastRadius: 'session' })]])
    expect(backfillBlastRadius(state)).toEqual({ filled: 0, undeclared: 0 })
    expect(state.entries.memory.a.blastRadius).toBe('general')

    const again = stateWith([baseEntry('b')], [[baseEdit('b', { blastRadius: 'project' })]])
    expect(backfillBlastRadius(again)).toEqual({ filled: 1, undeclared: 0 })
    expect(backfillBlastRadius(again)).toEqual({ filled: 0, undeclared: 0 })
  })

  it('migrateHarnessState fills the field and reports the backfill in diagnostics', () => {
    const { state, diagnostics } = migrateHarnessState(
      stateWith([baseEntry('a')], [[baseEdit('a', { blastRadius: 'project' })]]),
    )
    expect(state.entries.memory.a.blastRadius).toBe('project')
    expect(diagnostics).toContain('backfilled blastRadius on 1 entries from refinement history')
  })

  it('treats an entry with no history as undeclared, not as an error', () => {
    const state = stateWith([baseEntry('a')], [])
    expect(backfillBlastRadius(state)).toEqual({ filled: 0, undeclared: 1 })

    // Loading it must stay clean: undeclared is a legal legacy state (3.1),
    // so it is not a diagnostic the way "skipping invalid entry" is.
    const { state: loaded, diagnostics } = migrateHarnessState(stateWith([baseEntry('a')], []))
    expect(loaded.entries.memory.a.blastRadius).toBeUndefined()
    expect(diagnostics).toEqual([])
  })
})
