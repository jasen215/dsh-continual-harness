import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { HarnessStore, serializeTrajectory } from '../src/store.ts'
import { HARNESS_REFINEMENT_EVENT } from '../src/domain.ts'
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
  it('applies a refinement locally: state file, session event, and merged view', () => {
    const ctx = new Context()
    const store = new HarnessStore(ctx, { harnessRoot: tempHome() })
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
    const store = new HarnessStore(ctx, { harnessRoot: tempHome() })
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
    const store = new HarnessStore(ctx, { harnessRoot: home })
    const { agent } = stubAgent('agent-3')
    const plan: RefinementProposal = {
      id: 'refine_3',
      summary: 'global',
      edits: [{ action: 'create', kind: 'prompt', id: 'global-note', content: 'cross-session' }],
    }
    store.applyRefinement(agent, plan, { global: true })
    expect(store.state(agent).entries.prompt['global-note']?.content).toBe('cross-session')
    expect(store.history(agent).map(entry => entry.id)).toContain('refine_3')
    expect(store.render(agent)).toContain('global-note')
  })

  it('renders an empty overview when nothing is stored', () => {
    const store = new HarnessStore(new Context(), { harnessRoot: tempHome() })
    const { agent } = stubAgent('agent-4')
    expect(store.render(agent)).toContain('# Continual Harness State')
    expect(store.render(agent)).toContain('- none')
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
