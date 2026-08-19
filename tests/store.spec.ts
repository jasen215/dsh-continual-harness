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
import { getGlobalHarnessStateDir, saveHarnessState } from '../src/storage.ts'
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
    expect(grown.appliedEdits[0]!.error).toBe('条目增长率超过 maxEntryGrowth上限')
    expect(store.state(agent).entries.memory['long']!.content).toBe('x'.repeat(100))

    // protected layer: an automatic-path write of a protected global skill is rejected
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
    expect(automatic.appliedEdits[0]!.error).toBe('受保护条目仅显式用户会话可改')
    expect(store.state(agent).entries.skill['pinned-skill']?.content).toBe('protected body')
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
