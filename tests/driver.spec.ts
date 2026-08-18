import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { registerHarnessDriver } from '../src/driver.ts'
import { HarnessStore } from '../src/store.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-driver-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Agents accessor stand-in: the driver only reads `get(sessionId)`. */
interface FakeAgents {
  register(agent: Agent): () => void
  get(id: unknown): Agent | undefined
}

function makeAgents(): FakeAgents {
  const byId = new Map<string, Agent>()
  return {
    register(agent) {
      byId.set(String(agent.id), agent)
      return () => { byId.delete(String(agent.id)) }
    },
    get(id) {
      return byId.get(String(id))
    },
  }
}

/** Llm stand-in: one review reply, then one plan reply, per gate run. */
interface FakeLlm {
  readonly callCount: number
  stream(): AsyncGenerator<
    { type: 'text-delta'; text: string } | { type: 'finish'; reason: { kind: 'success' } },
    void,
    unknown
  >
}

function makeLlm(replies: ReadonlyArray<Record<string, unknown>>): FakeLlm {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify(reply) }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
}

function stubAgent(rawId: string): Agent {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  return {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
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
}

function turnEnd(session: Session, seq: number): void {
  // session/event listeners run synchronously; the driver's gate is
  // fire-and-forget, so tests settle it with a macrotask below.
  ctx.emit('session/event', session, {
    type: 'turn/end',
    seq,
    time: Date.now(),
    data: { turn: seq, reason: { kind: 'success' } },
  })
}

let ctx: Context

/** Hermetic store: harness root + skills dir both inside one temp home. */
function testStore(root: string): HarnessStore {
  return new HarnessStore(ctx, { harnessRoot: root, skillsDir: join(root, 'skills') })
}

describe('registerHarnessDriver', () => {
  it('applies a reviewed plan once the turn interval is reached', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 2,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
    })
    const agent = stubAgent('driver-1')
    agents.register(agent)

    const session = agent.session
    turnEnd(session, 1)
    turnEnd(session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(llm.callCount).toBe(2)
    expect(store.state(agent).entries.memory['m1']?.content).toBe('learned')
  })

  it('holds a rejected review without applying', async () => {
    ctx = new Context()
    const llm = makeLlm([{ approved: false, rationale: 'nothing to fix' }])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
    })
    const agent = stubAgent('driver-2')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    // The review ran once; the plan call and the apply never happened.
    expect(llm.callCount).toBe(1)
    expect(store.state(agent).entries.memory['m1']).toBeUndefined()
  })

  it('respects the cooldown between gate attempts', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 60_000,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
    })
    const agent = stubAgent('driver-3')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // Inside the cooldown window a further interval does not run the gate.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)
  })

  it('skips sessions with no live agent without throwing', async () => {
    ctx = new Context()
    const llm = makeLlm([{ approved: true, rationale: 'interval reached' }])
    ctx.provide('llm', llm as never)
    ctx.provide('agents', makeAgents() as never)
    const store = testStore(tempHome())
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
    })
    const session = Session.create(SessionId('driver-4'))

    turnEnd(session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(llm.callCount).toBe(0)
  })
})
