import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { HarnessStore, serializeTrajectory } from '../src/store.ts'
import { HARNESS_REFINEMENT_EVENT, HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import { getGlobalHarnessStateDir, getLocalHarnessStateDir, saveHarnessState } from '../src/storage.ts'
import type { RefinementProposal } from '../src/types.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent with a durable session. */
function stubAgent(rawId: string): StubAgent {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: undefined as never,
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, setStatus(value) { status = value } }
}

describe('HarnessStore', () => {
  /** Hermetic store: harness root + skills dir both inside one temp home. */
  function testStore(ctx: Context, root: string): HarnessStore {
    return new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
  }

  it('records injections and exposes persisted usage stats', () => {
    const home = tempHome()
    const store = testStore(new Context(), home)
    const { agent } = stubAgent('usage-agent')

    store.recordInjections(agent, ['global:memory:fact', 'global:memory:fact', 'local:usage-agent:memory:note'])

    expect(store.usageStatsFor('global:memory:fact')).toEqual({ injectionCount: 2, lastInjectedAt: expect.any(String) })
    expect(store.usageStatsFor('local:usage-agent:memory:note')).toEqual({ injectionCount: 1, lastInjectedAt: expect.any(String) })
    const lines = readFileSync(join(home, 'usage.events.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(line => JSON.parse(line).key)).toEqual([
      'global:memory:fact',
      'global:memory:fact',
      'local:usage-agent:memory:note',
    ])
  })

  it('does nothing for an empty injection list', () => {
    const home = tempHome()
    const store = testStore(new Context(), home)
    const { agent } = stubAgent('usage-empty')

    store.recordInjections(agent, [])

    expect(existsSync(join(home, 'usage.events.jsonl'))).toBe(false)
    expect(store.usageStatsFor('global:memory:missing')).toBeUndefined()
  })

  it('lazy-loads usage stats from an existing event log', () => {
    const home = tempHome()
    writeFileSync(join(home, 'usage.events.jsonl'), [
      JSON.stringify({ key: 'global:memory:fact', at: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ key: 'global:memory:fact', at: '2026-01-02T00:00:00.000Z' }),
    ].join('\n') + '\n')
    const store = testStore(new Context(), home)

    expect(store.usageStatsFor('global:memory:fact')).toEqual({
      injectionCount: 2,
      lastInjectedAt: '2026-01-02T00:00:00.000Z',
    })
  })

  it('does not throw when usage log loading fails', () => {
    const home = tempHome()
    mkdirSync(join(home, 'usage.events.jsonl'))
    const store = testStore(new Context(), home)
    const { agent } = stubAgent('usage-failure')

    expect(() => store.recordInjections(agent, ['global:memory:fact'])).not.toThrow()
    expect(store.usageStatsFor('global:memory:fact')?.injectionCount).toBe(1)
  })

  it('applies a refinement locally: state file, session event, and merged view', () => {
    const ctx = new Context()
    const store = testStore(ctx, tempHome())
    const { agent, session } = stubAgent('agent-1')
    const plan: RefinementProposal = {
      id: 'refine_1',
      summary: 'remember',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'durable' }],
    }
    const result = store.applyRefinement(agent, plan, {})
    expect(result.scope).toBe('local')
    expect(session.events.some(event => event.type === HARNESS_REFINEMENT_EVENT)).toBe(true)
    expect(store.state(agent).entries.memory['fact']?.content).toBe('durable')
    expect(store.history(agent).map(entry => entry.id)).toEqual(['refine_1'])
  })

  it('rolls back a refinement from the merged history', () => {
    const ctx = new Context()
    const store = testStore(ctx, tempHome())
    const { agent } = stubAgent('agent-2')
    const plan: RefinementProposal = {
      id: 'refine_2',
      summary: 'add',
      edits: [{ action: 'create', kind: 'memory', id: 'temp', content: 'x' }],
    }
    store.applyRefinement(agent, plan, {})
    const rollback = store.rollbackRefinement(agent, 'refine_2', {})
    expect(rollback.rollbackOf).toBe('refine_2')
    expect(store.state(agent).entries.memory['temp']).toBeUndefined()
  })

  it('applies globally and persists the cross-session history', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('agent-3')
    const plan: RefinementProposal = {
      id: 'refine_3',
      summary: 'global',
      edits: [{ action: 'create', kind: 'prompt', id: 'global-note', content: 'cross-session' }],
    }
    store.applyRefinement(agent, plan, { global: true })
    expect(store.state(agent).entries.prompt['global-note']?.content).toBe('cross-session')
    expect(store.history(agent).map(entry => entry.id)).toContain('refine_3')
    expect(store.render(agent).overview).toContain('global-note')
  })

  it('promotes a local entry to global by copy, leaving local unchanged', () => {
    const ctx = new Context()
    const store = testStore(ctx, tempHome())
    const { agent } = stubAgent('promote-1')
    store.applyRefinement(agent, {
      id: 'rp1', summary: 'local seed',
      edits: [{ action: 'create', kind: 'memory', id: 'lesson', content: 'durable' }],
    }, {})
    const out = store.promoteEntry(agent, 'lesson')
    expect(out.applied).toBe(true)
    expect(store.globalState().entries.memory['lesson']?.content).toBe('durable')
    expect(store.localState(agent).entries.memory['lesson']?.content).toBe('durable')
  })

  it('promotes every persisted local field without changing local state', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('promote-full')
    store.applyRefinement(agent, {
      id: 'rp-full', summary: 'local skill',
      edits: [{
        action: 'create', kind: 'skill', id: 'complete-skill', content: 'body', title: 'Title',
        description: 'Description', reference: 'Reference', arguments: '{"mode":"fast"}',
        metadata: { sourceSession: 'original', lifecycleState: 'archived', pinned: true, lastInjectedAt: 'when' },
      }],
    }, {})
    const localBefore = structuredClone(store.localState(agent).entries.skill['complete-skill'])
    expect(store.promoteEntry(agent, 'complete-skill').applied).toBe(true)
    const promoted = store.globalState().entries.skill['complete-skill']
    expect(promoted).toMatchObject({
      content: 'body', title: 'Title', description: 'Description', reference: 'Reference', arguments: '{"mode":"fast"}',
      metadata: { sourceSession: 'original', lifecycleState: 'archived', pinned: true, lastInjectedAt: 'when' },
    })
    expect(promoted?.updatedAt).toEqual(expect.any(String))
    expect(store.localState(agent).entries.skill['complete-skill']).toEqual(localBefore)
  })

  it('reports an unknown local id without changing either store', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('promote-missing')
    expect(store.promoteEntry(agent, 'missing')).toEqual({ applied: false, error: 'local entry not found: missing' })
    expect(store.globalState().entries).toEqual({ prompt: {}, memory: {}, skill: {}, subagent: {} })
  })

  it('rejects an ambiguous id shared by multiple kinds instead of picking one', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('promote-ambig')
    store.applyRefinement(agent, {
      id: 'rp-a', summary: 'seed memory',
      edits: [{ action: 'create', kind: 'memory', id: 'same', content: 'm' }],
    }, {})
    store.applyRefinement(agent, {
      id: 'rp-b', summary: 'seed skill',
      edits: [{ action: 'create', kind: 'skill', id: 'same', content: 's' }],
    }, {})
    expect(store.promoteEntry(agent, 'same')).toEqual({ applied: false, error: 'ambiguous local id: same' })
    expect(store.globalState().entries).toEqual({ prompt: {}, memory: {}, skill: {}, subagent: {} })
  })

  it('promote conflicts when the global id already exists and leaves everything unchanged', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('promote-2')
    store.applyRefinement(agent, {
      id: 'rp2', summary: 'seed both',
      edits: [{ action: 'create', kind: 'memory', id: 'same', content: 'local' }],
    }, {})
    store.applyRefinement(agent, {
      id: 'rp3', summary: 'seed global',
      edits: [{ action: 'create', kind: 'memory', id: 'same', content: 'global' }],
    }, { global: true })
    const out = store.promoteEntry(agent, 'same')
    expect(out.applied).toBe(false)
    expect(out.error).toBe('global id conflict')
    expect(store.globalState().entries.memory['same']?.content).toBe('global')
  })

  it('renders an empty overview when nothing is stored', () => {
    const store = testStore(new Context(), tempHome())
    const { agent } = stubAgent('agent-4')
    expect(store.render(agent).overview).toContain('# Continual Harness State')
    expect(store.render(agent).overview).toContain('- none')
  })

  it('materializes skill edits as SKILL.md bundles and restores them on rollback', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('agent-5')
    const bundle = join(home, 'skills', 'repro', 'SKILL.md')
    store.applyRefinement(agent, {
      id: 'refine_skill',
      summary: 'add repro skill',
      edits: [{ action: 'create', kind: 'skill', id: 'repro', content: 'repro body', description: 'reproduce fast' }],
    }, {})
    expect(existsSync(bundle)).toBe(true)
    expect(readFileSync(bundle, 'utf8')).toContain('name: repro')
    expect(readFileSync(bundle, 'utf8')).toContain('repro body')

    store.rollbackRefinement(agent, 'refine_skill', {})
    expect(existsSync(bundle)).toBe(false)
    expect(store.state(agent).entries.skill['repro']).toBeUndefined()
  })

  it('removes archived skill bundles and restores them on unarchive', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('agent-archive-skill')
    const bundle = join(home, 'skills', 'repro', 'SKILL.md')

    store.applyRefinement(agent, {
      id: 'skill_seed',
      summary: 'seed skill',
      edits: [{ action: 'create', kind: 'skill', id: 'repro', content: 'body' }],
    }, {})
    expect(existsSync(bundle)).toBe(true)

    store.applyRefinement(agent, {
      id: 'skill_archive',
      summary: 'archive skill',
      edits: [{ action: 'update', kind: 'skill', id: 'repro', archive: true, reason: 'hide' }],
    }, {})
    expect(existsSync(bundle)).toBe(false)

    store.applyRefinement(agent, {
      id: 'skill_unarchive',
      summary: 'restore skill',
      edits: [{ action: 'update', kind: 'skill', id: 'repro', archive: false, reason: 'restore' }],
    }, {})
    expect(existsSync(bundle)).toBe(true)
  })

  it('materializes a repeated skill touch once', () => {
    const root = tempHome()
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
    const { agent } = stubAgent('repeated-skill-touch')

    store.applyRefinement(agent, {
      id: 'seed_repeated_skill',
      summary: 'seed skill',
      edits: [{ action: 'create', kind: 'skill', id: 'repeat-demo', content: 'before', description: 'Use repeat demo' }],
    }, { global: true })
    const result = store.applyRefinement(agent, {
      id: 'update_repeated_skill',
      summary: 'update skill twice',
      edits: [
        { action: 'update', kind: 'skill', id: 'repeat-demo', content: 'after', reason: 'first update' },
        { action: 'update', kind: 'skill', id: 'repeat-demo', content: 'after', reason: 'second update' },
      ],
    }, { global: true })

    expect(result.appliedEdits.filter(edit => edit.applied)).toHaveLength(2)
    expect(result.materialization.written).toHaveLength(1)
    expect(result.materialization.unchanged).toHaveLength(0)
  })

  it('materializes a skill bundle with files and returns a completed materialization', () => {
    const root = tempHome()
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
    const { agent } = stubAgent('m')
    const result = store.applyRefinement(agent, {
      id: 'refine_bundle',
      summary: 'create a bundle skill',
      edits: [{
        action: 'create', kind: 'skill', id: 'bundle-demo',
        description: 'Use whenever bundling',
        content: '## Steps\\n1. Run `scripts/bundle.py`',
        files: { 'scripts/bundle.py': 'print(1)', 'references/t.md': '# t' },
      }],
    }, { global: true })
    expect(result.materialization.status).toBe('completed')
    expect(existsSync(join(root, 'skills', 'bundle-demo', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(root, 'skills', 'bundle-demo', 'scripts', 'bundle.py'), 'utf8')).toBe('print(1)')
    expect(result.materialization.written).toHaveLength(3)
  })

  it('rejects a create edit whose target is an existing empty directory', () => {
    const root = tempHome()
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
    mkdirSync(join(root, 'skills', 'empty'), { recursive: true })
    const { agent } = stubAgent('m')
    const result = store.applyRefinement(agent, {
      id: 'refine_empty_conflict',
      summary: 'take an existing directory',
      edits: [{ action: 'create', kind: 'skill', id: 'empty', content: 'body' }],
    }, { global: true })
    const failed = result.appliedEdits.find(edit => edit.id === 'empty')
    expect(failed?.applied).toBe(false)
    expect(failed?.error).toContain('not harness-owned')
    expect(existsSync(join(root, 'skills', 'empty', 'SKILL.md'))).toBe(false)
  })

  it('rejects a create edit whose target directory holds a non-harness-owned SKILL.md', () => {
    const root = tempHome()
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
    mkdirSync(join(root, 'skills', 'taken'), { recursive: true })
    writeFileSync(join(root, 'skills', 'taken', 'SKILL.md'), '---\\nname: taken\\n---\\nuser skill')
    const { agent } = stubAgent('m')
    const result = store.applyRefinement(agent, {
      id: 'refine_conflict',
      summary: 'take a used name',
      edits: [{ action: 'create', kind: 'skill', id: 'taken', content: 'body' }],
    }, { global: true })
    const failed = result.appliedEdits.find(edit => edit.id === 'taken')
    expect(failed?.applied).toBe(false)
    expect(failed?.error).toContain('not harness-owned')
    expect(readFileSync(join(root, 'skills', 'taken', 'SKILL.md'), 'utf8')).toBe('---\\nname: taken\\n---\\nuser skill')
  })

  it('reports a partial materialization when a non-harness-owned bundle is targeted by an update', () => {
    const root = tempHome()
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
    // seed a harness-owned bundle
    const { agent } = stubAgent('m')
    store.applyRefinement(agent, {
      id: 'refine_seed', summary: 'seed',
      edits: [{ action: 'create', kind: 'skill', id: 'ours', content: 'body', description: 'use ours' }],
    }, { global: true })
    // replace the seeded SKILL.md with a user-owned one, then update must skip
    writeFileSync(join(root, 'skills', 'ours', 'SKILL.md'), '---\\nname: ours\\n---\\nuser skill')
    const result = store.applyRefinement(agent, {
      id: 'refine_update', summary: 'update',
      edits: [{ action: 'update', kind: 'skill', id: 'ours', content: 'body2', reason: 'why' }],
    }, { global: true })
    expect(result.materialization.status).toBe('partial')
    expect(result.materialization.skipped).toEqual([join(root, 'skills', 'ours')])
    expect(readFileSync(join(root, 'skills', 'ours', 'SKILL.md'), 'utf8')).toBe('---\\nname: ours\\n---\\nuser skill')
  })

  it('applies store-configured growth limit and protected layers', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = new HarnessStore(ctx, {
      harnessRoot: home,
      skillsDir: join(home, 'skills'),
      maxEntryGrowth: 0.1,
      protectedKinds: ['skill'],
    })
    const { agent } = stubAgent('agent-gov')

    // growth limit: an update growing 100 -> 200 chars (100% > 10%) is rejected
    store.applyRefinement(agent, {
      id: 'refine_seed',
      summary: 'seed a long memory',
      edits: [{ action: 'create', kind: 'memory', id: 'long', content: 'x'.repeat(100) }],
    }, {})
    const grown = store.applyRefinement(agent, {
      id: 'refine_grow',
      summary: 'grow too much',
      edits: [{ action: 'update', kind: 'memory', id: 'long', reason: 'grow', content: 'y'.repeat(200) }],
    }, {})
    expect(grown.appliedEdits[0]!.applied).toBe(false)
    expect(grown.appliedEdits[0]!.error).toBe('entry growth exceeds the maxEntryGrowth cap')
    expect(store.state(agent).entries.memory['long']!.content).toBe('x'.repeat(100))

    // protected layer: an automatic-path write of a protected global skill is
    // rejected — here the configured protectedKinds gate fires first
    saveHarnessState(getGlobalHarnessStateDir(home), {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      entries: {
        prompt: {},
        memory: {},
        skill: {
          'pinned-skill': {
            id: 'pinned-skill',
            kind: 'skill',
            version: 1,
            content: 'protected body',
            updatedAt: '2026-01-01T00:00:00.000Z',
            protection: 'pinned',
          },
        },
        subagent: {},
      },
      refinements: [],
    })
    const automatic = store.applyRefinement(agent, {
      id: 'refine_auto',
      summary: 'automatic write',
      edits: [{ action: 'update', kind: 'skill', id: 'pinned-skill', reason: 'auto', content: 'tampered' }],
    }, { automatic: true, global: true })
    expect(automatic.appliedEdits[0]!.applied).toBe(false)
    expect(automatic.appliedEdits[0]!.error).toBe('kind skill is protected from automatic refinement')
    expect(store.state(agent).entries.skill['pinned-skill']?.content).toBe('protected body')

    // with an empty protectedKinds list, the per-entry protection guard still
    // rejects the same automatic write (the second line of defense)
    const perEntryStore = new HarnessStore(ctx, {
      harnessRoot: home,
      skillsDir: join(home, 'skills'),
      protectedKinds: [],
    })
    const perEntry = perEntryStore.applyRefinement(agent, {
      id: 'refine_auto_per_entry',
      summary: 'automatic write',
      edits: [{ action: 'update', kind: 'skill', id: 'pinned-skill', reason: 'auto', content: 'tampered' }],
    }, { automatic: true, global: true })
    expect(perEntry.appliedEdits[0]!.applied).toBe(false)
    expect(perEntry.appliedEdits[0]!.error).toBe('protected entries are mutable only in explicit user sessions')
  })

  it('rejects automatic-path writes on a configured protected kind, even for unprotected entries', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = new HarnessStore(ctx, {
      harnessRoot: home,
      skillsDir: join(home, 'skills'),
      protectedKinds: ['skill'],
    })
    const { agent } = stubAgent('agent-protected-kind')
    const automatic = store.applyRefinement(agent, {
      id: 'refine_auto_kind',
      summary: 'automatic skill create',
      edits: [{ action: 'create', kind: 'skill', id: 'fresh-skill', content: 'body' }],
    }, { automatic: true })
    expect(automatic.appliedEdits[0]!.applied).toBe(false)
    expect(automatic.appliedEdits[0]!.error).toBe('kind skill is protected from automatic refinement')
    expect(store.state(agent).entries.skill['fresh-skill']).toBeUndefined()
    // the explicit tool path (no `automatic`) may still write the kind
    const manual = store.applyRefinement(agent, {
      id: 'refine_manual_kind',
      summary: 'explicit skill create',
      edits: [{ action: 'create', kind: 'skill', id: 'fresh-skill', content: 'body' }],
    }, {})
    expect(manual.appliedEdits[0]!.applied).toBe(true)
    expect(store.state(agent).entries.skill['fresh-skill']?.content).toBe('body')
  })

  it('rejects a commit over entries changed between planning and commit via the captured baseline', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('agent-baseline')
    store.applyRefinement(agent, {
      id: 'seed',
      summary: 'seed',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'original' }],
    }, {})
    // the state the planner saw
    const planningBaseline = store.localState(agent)
    // a concurrent change lands between planning and commit
    store.applyRefinement(agent, {
      id: 'concurrent',
      summary: 'concurrent',
      edits: [{ action: 'update', kind: 'memory', id: 'fact', reason: 'other writer', content: 'changed concurrently' }],
    }, {})
    const result = store.applyRefinement(agent, {
      id: 'stale',
      summary: 'stale plan',
      edits: [{ action: 'update', kind: 'memory', id: 'fact', reason: 'stale plan', content: 'stale write' }],
    }, { baseline: planningBaseline })
    expect(result.appliedEdits[0]!.applied).toBe(false)
    expect(result.appliedEdits[0]!.error).toBe('entry changed during refinement planning')
    expect(store.state(agent).entries.memory['fact']!.content).toBe('changed concurrently')
  })

  it('a commit without a captured baseline keeps the commit-time read (rollback semantics)', () => {
    const ctx = new Context()
    const home = tempHome()
    const store = testStore(ctx, home)
    const { agent } = stubAgent('agent-no-baseline')
    store.applyRefinement(agent, {
      id: 'seed',
      summary: 'seed',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'original' }],
    }, {})
    const result = store.applyRefinement(agent, {
      id: 'no-baseline',
      summary: 'commit without baseline',
      edits: [{ action: 'update', kind: 'memory', id: 'fact', reason: 'write', content: 'applied' }],
    }, {})
    expect(result.appliedEdits[0]!.applied).toBe(true)
    expect(store.state(agent).entries.memory['fact']!.content).toBe('applied')
  })

  describe('captureSnapshot', () => {
    /** Seed one memory entry into the given store dir. */
    function seedMemory(dir: string, id: string, content: string): void {
      saveHarnessState(dir, {
        schemaVersion: HARNESS_SCHEMA_VERSION,
        entries: {
          prompt: {},
          memory: { [id]: { id, kind: 'memory', version: 1, content, updatedAt: '2026-08-19T00:00:00.000Z' } },
          skill: {},
          subagent: {},
        },
        refinements: [],
      })
    }

    it('captures merged local and global entries', () => {
      const home = tempHome()
      const store = testStore(new Context(), home)
      const { agent } = stubAgent('snap-agent')
      seedMemory(getGlobalHarnessStateDir(home), 'global-fact', 'global value')
      seedMemory(getLocalHarnessStateDir(home, String(agent.session.id)), 'local-fact', 'local value')

      const snapshot = store.captureSnapshot(agent, 'ref-1')
      expect(snapshot.snapshotId).toBe('ref-1')
      expect(snapshot.stateHash).toMatch(/^[a-f0-9]{64}$/)
      expect(snapshot.capturedAt).toEqual(expect.any(String))
      expect(snapshot.state.entries.memory['global-fact']?.content).toBe('global value')
      expect(snapshot.state.entries.memory['local-fact']?.content).toBe('local value')
    })

    it('later store writes do not mutate the captured object', () => {
      const ctx = new Context()
      const home = tempHome()
      const store = testStore(ctx, home)
      const { agent } = stubAgent('snap-agent')
      store.applyRefinement(agent, {
        id: 'seed',
        summary: 'seed',
        edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'original' }],
      }, {})
      const captured = store.captureSnapshot(agent, 'ref-1')
      expect(captured.state.entries.memory['fact']?.content).toBe('original')

      // mutate the live store afterwards
      store.applyRefinement(agent, {
        id: 'grow',
        summary: 'grow',
        edits: [{ action: 'update', kind: 'memory', id: 'fact', reason: 'grow', content: 'changed' }],
      }, {})
      expect(store.state(agent).entries.memory['fact']?.content).toBe('changed')
      expect(captured.state.entries.memory['fact']?.content).toBe('original')
    })

    it('capture has no side effects: no files, no usage events, no state mutation', () => {
      const home = tempHome()
      const store = testStore(new Context(), home)
      const { agent } = stubAgent('snap-agent')

      const before = store.state(agent)
      const snapshot = store.captureSnapshot(agent, 'ref-1')

      // no files written by the capture itself
      expect(existsSync(join(home, 'benchmark'))).toBe(false)
      expect(existsSync(join(home, 'usage.events.jsonl'))).toBe(false)
      // no state mutation: the merged view is unchanged
      expect(store.state(agent)).toEqual(before)
      // and the captured object is a detached structured clone
      expect(snapshot.state.entries.memory).toEqual({})
    })
  })
})

describe('serializeTrajectory', () => {
  it('collects user and assistant text turns', () => {
    const session = Session.create(SessionId('traj-1'))
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'first prompt' }],
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'second prompt' }],
    }), { surfaceOp: 'append' })
    const text = serializeTrajectory(session, 10_000)
    expect(text).toContain('[user/message] first prompt')
    expect(text).toContain('[user/message] second prompt')
  })

  it('truncates tail-biased beyond the cap', () => {
    const session = Session.create(SessionId('traj-2'))
    const long = 'x'.repeat(2000)
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `second prompt ${long}` }],
    }), { surfaceOp: 'append' })
    const text = serializeTrajectory(session, 300)
    expect(text).toContain('(truncated')
    expect(text).toContain(long.slice(-100))
    expect(text).not.toContain('[user/message]')
  })
})
