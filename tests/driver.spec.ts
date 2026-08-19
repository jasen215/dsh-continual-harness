import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { loadReviews, REVIEWS_FILE_NAME } from '../src/audit.ts'
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

function makeLlm(replies: ReadonlyArray<Record<string, unknown>>, delayMs = 0): FakeLlm {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls += 1
      yield { type: 'text-delta', text: JSON.stringify(reply) }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
}

/** Llm stand-in that yields non-JSON prose, so parseAutoRefineReview throws. */
function makeFailingLlm(delayMs = 0): FakeLlm {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      calls += 1
      yield { type: 'text-delta', text: 'the model replied with prose, not JSON' }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
}

/** Llm stand-in that never replies; the gate hangs on the stream forever. */
function makeHangingLlm(): FakeLlm {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      calls += 1
      await new Promise(() => {})
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
      auditReviews: false,
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
      auditReviews: false,
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
      auditReviews: false,
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
      auditReviews: false,
    })
    const session = Session.create(SessionId('driver-4'))

    turnEnd(session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(llm.callCount).toBe(0)
  })

  it('records an approved gate verdict with rejected edits to the audit file', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      {
        id: 'auto_1',
        summary: 'auto',
        edits: [
          // update without a reason: validateEdit rejects it
          { action: 'update', kind: 'memory', id: 'm1', content: 'rewritten' },
          { action: 'create', kind: 'memory', id: 'm2', content: 'learned' },
        ],
      },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-5')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(1)
    const review = reviews[0]
    expect(review?.outcome).toBe('approved')
    expect(review?.refinementId).toBe('auto_1')
    expect(review?.trigger).toBe('turn-interval')
    expect(review?.sessionId).toBe(String(agent.session.id))
    expect(review?.rejectedEdits).toHaveLength(1)
    expect(review?.rejectedEdits?.[0]).toMatchObject({ kind: 'memory', id: 'm1', action: 'update' })
    expect(review?.rejectedEdits?.[0]?.error).toContain('reason')
    // the valid create still applied
    expect(store.state(agent).entries.memory['m2']?.content).toBe('learned')
  })

  it('records a declined gate verdict with its rationale', async () => {
    ctx = new Context()
    const llm = makeLlm([{ approved: false, rationale: 'nothing to fix' }])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-6')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.outcome).toBe('declined')
    expect(reviews[0]?.rationale).toBe('nothing to fix')
    expect(llm.callCount).toBe(1)
  })

  it('records an assessed gate verdict when the plan is empty', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-7')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.outcome).toBe('assessed')
    expect(reviews[0]?.rationale).toBe('interval reached')
    expect(llm.callCount).toBe(2)
  })

  it('records a failed gate verdict and re-triggers once a later turn crosses the interval', async () => {
    ctx = new Context()
    const llm = makeFailingLlm()
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-8')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(1)
    const first = loadReviews(home)
    expect(first).toHaveLength(1)
    expect(first[0]?.outcome).toBe('failed')
    expect(first[0]?.rationale).toContain('JSON')

    // The failed attempt settled as a terminal result, so the counter reset;
    // with turnInterval 1 the next turn/end crosses the interval again.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)
    expect(loadReviews(home)).toHaveLength(2)
  })

  it('does not create the audit file when auditing is disabled', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: false,
    })
    const agent = stubAgent('driver-9')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(llm.callCount).toBe(2)
    expect(store.state(agent).entries.memory['m1']?.content).toBe('learned')
    expect(existsSync(join(home, REVIEWS_FILE_NAME))).toBe(false)
  })

  it('swallows an audit write failure and still completes the gate', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    // reviews.jsonl path is occupied by a directory: appendReview must throw
    mkdirSync(join(home, REVIEWS_FILE_NAME))
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-10')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))

    // the audit failure was swallowed; the gate still planned and applied
    expect(llm.callCount).toBe(2)
    expect(store.state(agent).entries.memory['m1']?.content).toBe('learned')
  })

  it('schedules a single gate once the turn interval is reached, not on every turn', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'first interval' },
      { id: 'auto_a', summary: 'a', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
      { approved: true, rationale: 'second interval' },
      { id: 'auto_b', summary: 'b', edits: [{ action: 'create', kind: 'memory', id: 'm2', content: 'more' }] },
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
      auditReviews: false,
    })
    const agent = stubAgent('driver-11')
    agents.register(agent)

    // Two turns reach the interval: exactly one gate (review + plan).
    turnEnd(agent.session, 1)
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // Turn three does not start another gate; the next pair does.
    turnEnd(agent.session, 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)
    turnEnd(agent.session, 4)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(4)
    expect(store.state(agent).entries.memory['m1']?.content).toBe('learned')
    expect(store.state(agent).entries.memory['m2']?.content).toBe('more')
  })

  it('awaits an in-flight gate when the session is finalized', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ], 30)
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: false,
    })
    const agent = stubAgent('driver-12')
    agents.register(agent)

    // The gate starts and is now in flight, awaiting the slow llm.
    turnEnd(agent.session, 1)
    // The final drain awaits the in-flight gate to completion.
    await driver.finalize(String(agent.session.id))

    expect(llm.callCount).toBe(2)
    expect(store.state(agent).entries.memory['m1']?.content).toBe('learned')
  })

  it('makes zero LLM calls when the final drain has no pending work', async () => {
    ctx = new Context()
    const llm = makeLlm([{ approved: true, rationale: 'interval reached' }])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 10,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: false,
    })
    const agent = stubAgent('driver-13')
    agents.register(agent)

    // One turn does not reach the interval, so no gate is due.
    turnEnd(agent.session, 1)
    await driver.finalize(String(agent.session.id))
    // A session the driver never saw is also a no-op.
    await driver.finalize('driver-unknown')
    expect(llm.callCount).toBe(0)
  })

  it('is idempotent: repeated finalizer calls do not duplicate work and block late events', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ], 30)
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-14')
    agents.register(agent)

    turnEnd(agent.session, 1)
    // The first finalizer call awaits the in-flight gate; the repeats no-op.
    await driver.finalize(String(agent.session.id))
    await driver.finalize(String(agent.session.id))
    // A late event after the drain must not start new work.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(llm.callCount).toBe(2)
    expect(loadReviews(home)).toHaveLength(1)
  })

  it('resolves without throwing when the final drain times out on a hanging gate', async () => {
    ctx = new Context()
    const llm = makeHangingLlm()
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const store = testStore(tempHome())
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: false,
    })
    const agent = stubAgent('driver-15')
    agents.register(agent)

    turnEnd(agent.session, 1)
    // The gate hangs on the llm; the drain bounds the wait and resolves.
    await expect(driver.finalize(String(agent.session.id))).resolves.toBeUndefined()
    await expect(driver.finalize(String(agent.session.id))).resolves.toBeUndefined()
  })

  it('resolves without throwing when the in-flight gate fails during the drain', async () => {
    ctx = new Context()
    const llm = makeFailingLlm(30)
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 0,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-16')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await expect(driver.finalize(String(agent.session.id))).resolves.toBeUndefined()

    // The failure was audited once; the drain did not re-run the gate.
    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.outcome).toBe('failed')
    expect(llm.callCount).toBe(1)
  })

  it('drains a due-but-unstarted gate (cooldown-blocked) at session disposal', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'first interval' },
      { id: 'auto_1', summary: 'one', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
      { approved: true, rationale: 'final drain' },
      { id: 'auto_2', summary: 'two', edits: [{ action: 'create', kind: 'memory', id: 'm2', content: 'drained' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    const driver = registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 60_000,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-17')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)
    expect(loadReviews(home)).toHaveLength(1)

    // The interval is reached again, but the cooldown blocks the gate: it
    // stays pending, neither started nor lost.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // The final drain starts the due gate, bypassing the cooldown.
    await driver.finalize(String(agent.session.id))
    expect(llm.callCount).toBe(4)
    expect(loadReviews(home)).toHaveLength(2)
    expect(store.state(agent).entries.memory['m2']?.content).toBe('drained')
  })

  it('runs a cooldown-blocked due gate on a later turn once the cooldown elapses', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'first interval' },
      { id: 'auto_1', summary: 'one', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
      { approved: true, rationale: 'cooldown elapsed' },
      { id: 'auto_2', summary: 'two', edits: [{ action: 'create', kind: 'memory', id: 'm2', content: 'recovered' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 50,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-17b')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)
    expect(loadReviews(home)).toHaveLength(1)

    // The next threshold is cooldown-blocked, so the gate parks as pending.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // Once the cooldown elapses, a later turn/end runs the parked gate again:
    // the event path recovers it, the final drain is not the only trigger.
    await new Promise(resolve => setTimeout(resolve, 60))
    turnEnd(agent.session, 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(4)
    expect(loadReviews(home)).toHaveLength(2)
    expect(store.state(agent).entries.memory['m2']?.content).toBe('recovered')
  })

  it('drains pending work when the session is disposed through the event', async () => {
    ctx = new Context()
    const llm = makeLlm([
      { approved: true, rationale: 'first interval' },
      { id: 'auto_1', summary: 'one', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
      { approved: true, rationale: 'final drain' },
      { id: 'auto_2', summary: 'two', edits: [{ action: 'create', kind: 'memory', id: 'm2', content: 'drained' }] },
    ])
    const agents = makeAgents()
    ctx.provide('llm', llm as never)
    ctx.provide('agents', agents as never)
    const home = tempHome()
    const store = testStore(home)
    registerHarnessDriver(ctx, store, {
      enabled: true,
      turnInterval: 1,
      cooldownMs: 60_000,
      compact: true,
      plannerMaxTokens: 1000,
      maxTrajectoryChars: 500,
      auditReviews: true,
    })
    const agent = stubAgent('driver-18')
    agents.register(agent)

    turnEnd(agent.session, 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // The next threshold is cooldown-blocked, so the gate stays pending.
    turnEnd(agent.session, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(llm.callCount).toBe(2)

    // The drain is attached to the dsh-session `session/disposed` boundary.
    ctx.emit('session/disposed', agent.session)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(llm.callCount).toBe(4)
    expect(loadReviews(home)).toHaveLength(2)
    expect(store.state(agent).entries.memory['m2']?.content).toBe('drained')
  })
})
