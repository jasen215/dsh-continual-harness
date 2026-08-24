import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { loadReviews } from '../src/audit.ts'
import { HARNESS_STATE_SOURCE } from '../src/domain.ts'
import { PLUGIN_LOG_FILE_NAME } from '../src/logfile.ts'
import { HarnessStore } from '../src/store.ts'

const testToolSignal = new AbortController().signal
const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-plugin-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(rawId: string): StubAgent {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Execute one registered tool. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  })
}

/** Parse the compact JSON returned by a successful tool call. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return JSON.parse(block.text) as Record<string, unknown>
}

/** Hermetic plugin config: harness root + skills dir inside one temp home. */
function pluginConfig(root: string) {
  return { defaultGlobal: true, harnessRoot: root, skillsDir: join(root, 'skills') }
}

/** Llm stand-in that yields one plan JSON per planning call. */
function makePlanLlm(plan: Record<string, unknown>) {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      calls += 1
      yield { type: 'text-delta' as const, text: JSON.stringify(plan) }
      yield { type: 'finish' as const, reason: { kind: 'success' as const } }
    },
  }
}

/** Llm stand-in that yields one reply JSON per completion call, in order. */
function makeLlm(replies: ReadonlyArray<Record<string, unknown>>) {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream() {
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls += 1
      yield { type: 'text-delta' as const, text: JSON.stringify(reply) }
      yield { type: 'finish' as const, reason: { kind: 'success' as const } }
    },
  }
}

/** A valid global memory-create plan the fake llm returns. */
const PLAN = {
  id: 'refine_appr',
  summary: 'approve the global write',
  edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }],
}

describe('plugin registration', () => {
  it('mounts the plugin and registers the harness_refine tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(tempHome()))
    expect(ctx.tools.get('harness_refine')?.name).toBe('harness_refine')
  })

  it('registers harness_wrapup by default and skips it when wrapupEnabled is false', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(tempHome()))
    expect(ctx.tools.get('harness_wrapup')?.name).toBe('harness_wrapup')

    const off = new Context()
    await off.plugin(SystemPrompt)
    await off.plugin(AgentRegistry)
    await off.plugin(ToolRuntime)
    await off.plugin(plugin, { ...pluginConfig(tempHome()), wrapupEnabled: false })
    expect(off.tools.get('harness_wrapup')).toBeUndefined()
  })

  it('accepts maxInjectedEntriesPerKind and validates it as a positive integer', async () => {
    const ok = new Context()
    await ok.plugin(SystemPrompt)
    await ok.plugin(AgentRegistry)
    await ok.plugin(ToolRuntime)
    await ok.plugin(plugin, { ...pluginConfig(tempHome()), maxInjectedEntriesPerKind: 3 })
    expect(ok.tools.get('harness_refine')).toBeDefined()

    const bad = new Context()
    await bad.plugin(SystemPrompt)
    await bad.plugin(AgentRegistry)
    await bad.plugin(ToolRuntime)
    await expect(
      bad.plugin(plugin, { ...pluginConfig(tempHome()), maxInjectedEntriesPerKind: 1.5 }),
    ).rejects.toThrow()
  })

  it('accepts custom skill bundle limits and rejects non-positive values', async () => {
    const ok = new Context()
    await ok.plugin(SystemPrompt)
    await ok.plugin(AgentRegistry)
    await ok.plugin(ToolRuntime)
    await ok.plugin(plugin, {
      ...pluginConfig(tempHome()),
      maxSkillFiles: 5,
      maxSkillFileBytes: 128 * 1024,
      maxSkillBundleBytes: 512 * 1024,
    })
    expect(ok.tools.get('harness_refine')).toBeDefined()

    const bad = new Context()
    await bad.plugin(SystemPrompt)
    await bad.plugin(AgentRegistry)
    await bad.plugin(ToolRuntime)
    await expect(
      bad.plugin(plugin, { ...pluginConfig(tempHome()), maxSkillFiles: 0 }),
    ).rejects.toThrow()
  })

  it('rolls back a prior global refinement through the tool without an LLM', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(home))

    const seeder = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    seeder.applyRefinement(stubAgent('seeder').agent, {
      id: 'refine_seed',
      summary: 'seed a global memory',
      edits: [{ action: 'create', kind: 'memory', id: 'seed', content: 'x' }],
    }, { global: true })

    const result = await execute(ctx, 'harness_refine', { rollback_id: 'refine_seed' }, stubAgent('executor').agent)
    const json = resultJson(result)
    expect(json.refinement_id).toBe('rollback_refine_seed')
    expect(json.scope).toBe('global')
    expect(json.applied).toBe(1)

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['seed']).toBeUndefined()
  })
})

describe('governance default mode', () => {
  it('performs a global write without consulting the approval service', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm(PLAN) as never)

    const stub = { ask: vi.fn(async () => ({ value: 'approve' })) }
    ;(ctx as { userQuestions?: unknown }).userQuestions = stub
    await ctx.plugin(plugin, pluginConfig(home))

    const result = await execute(ctx, 'harness_refine', { global: true }, stubAgent('default-mode').agent)
    const json = resultJson(result)
    expect(json.refinement_id).toBe('refine_appr')
    expect(json.applied).toBe(1)
    expect(stub.ask).not.toHaveBeenCalled()

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['m1']?.content).toBe('learned')
  })

  it('records a gate verdict to reviews.jsonl under the harness root when the turn interval is reached', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makeLlm([
      { approved: true, rationale: 'interval reached' },
      { id: 'auto_1', summary: 'auto', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
    ]) as never)
    // auditReviews defaults to true: the plugin-wired driver appends every gate
    // verdict to <harnessRoot>/reviews.jsonl. cooldownMs is 1 because the
    // plugin schema requires >= 1 (0 is rejected by schemastery).
    await ctx.plugin(plugin, {
      ...pluginConfig(home),
      autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 1, compact: true },
    })

    // The gate looks the live agent up through the real agents service.
    const { agent } = stubAgent('gate-mount')
    ctx.agents.register(agent)

    ctx.emit('session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'success' } },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      outcome: 'approved',
      trigger: 'turn-interval',
      sessionId: String(agent.session.id),
    })
    // the approved plan committed to the session-local store
    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.localState(agent).entries.memory['m1']?.content).toBe('learned')
  })

  it('drains pending review work when a session is disposed', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makeLlm([
      { approved: true, rationale: 'first interval' },
      { id: 'auto_1', summary: 'auto one', edits: [{ action: 'create', kind: 'memory', id: 'm1', content: 'learned' }] },
      { approved: true, rationale: 'final drain' },
      { id: 'auto_2', summary: 'auto two', edits: [{ action: 'create', kind: 'memory', id: 'm2', content: 'drained' }] },
    ]) as never)
    await ctx.plugin(plugin, {
      ...pluginConfig(home),
      autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 60_000, compact: true },
    })

    const { agent } = stubAgent('drain-mount')
    ctx.agents.register(agent)
    const emitTurn = (seq: number) => ctx.emit('session/event', agent.session, {
      type: 'turn/end',
      seq,
      time: Date.now(),
      data: { turn: seq, reason: { kind: 'success' } },
    })

    emitTurn(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(loadReviews(home)).toHaveLength(1)

    // The second threshold is cooldown-blocked, so the gate stays pending.
    emitTurn(2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(loadReviews(home)).toHaveLength(1)

    // The plugin-mounted driver drains the pending gate at session disposal.
    ctx.emit('session/disposed', agent.session)
    await new Promise(resolve => setTimeout(resolve, 50))
    const reviews = loadReviews(home)
    expect(reviews).toHaveLength(2)
    expect(reviews[1]).toMatchObject({ outcome: 'approved', trigger: 'turn-interval' })
    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.localState(agent).entries.memory['m2']?.content).toBe('drained')
  })
})

describe('governance conservative mode', () => {
  it('blocks a global write the user rejects', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm(PLAN) as never)

    const stub = { ask: vi.fn(async () => ({ value: 'reject' })) }
    ;(ctx as { userQuestions?: unknown }).userQuestions = stub
    await ctx.plugin(plugin, { ...pluginConfig(home), requireGlobalApproval: true })

    const result = await execute(ctx, 'harness_refine', { global: true }, stubAgent('reject-mode').agent)
    const json = resultJson(result)
    expect(json.refinement_id).toBe('none')
    expect(json.scope).toBe('global')
    expect(json.summary).toContain('not approved')
    expect(json.applied).toBe(0)
    expect(stub.ask).toHaveBeenCalledOnce()

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['m1']).toBeUndefined()
  })

  it('allows a global write the user approves', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm(PLAN) as never)

    const stub = { ask: vi.fn(async () => ({ value: 'approve' })) }
    ;(ctx as { userQuestions?: unknown }).userQuestions = stub
    await ctx.plugin(plugin, { ...pluginConfig(home), requireGlobalApproval: true })

    const result = await execute(ctx, 'harness_refine', { global: true }, stubAgent('approve-mode').agent)
    const json = resultJson(result)
    expect(json.refinement_id).toBe('refine_appr')
    expect(json.applied).toBe(1)
    expect(stub.ask).toHaveBeenCalledOnce()

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['m1']?.content).toBe('learned')
  })
})

describe('governance config defaults', () => {
  it('wires the default file log into the harness root with mode 0600', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(home))

    // logToFile defaults to true: the exporter attached during apply lazily
    // materializes <harnessRoot>/continual-harness.log on the first harness log.
    ctx.logger('harness').info('mount probe')

    const file = join(home, PLUGIN_LOG_FILE_NAME)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('does not create the file log when logToFile is disabled', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { ...pluginConfig(home), logToFile: false })

    ctx.logger('harness').info('not persisted')

    expect(existsSync(join(home, PLUGIN_LOG_FILE_NAME))).toBe(false)
  })

  it('enforces the default maxEntryGrowth cap on a global update through the tool', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)

    // Seed a one-character global memory entry through the shared store file.
    const seeder = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    seeder.applyRefinement(stubAgent('growth-seeder').agent, {
      id: 'refine_seed_growth',
      summary: 'seed a one-character memory',
      edits: [{ action: 'create', kind: 'memory', id: 'seed', content: 'x' }],
    }, { global: true })

    // The plan carries a reason so validation passes and only the growth rule
    // fires: 20 chars vs 1 is a 19x growth, far beyond the default 0.5 cap.
    ctx.provide('llm', makePlanLlm({
      id: 'refine_growth',
      summary: 'grow the seeded entry',
      edits: [{ action: 'update', kind: 'memory', id: 'seed', content: 'a'.repeat(20), reason: 'grow it' }],
    }) as never)
    await ctx.plugin(plugin, pluginConfig(home))

    const result = await execute(ctx, 'harness_refine', {}, stubAgent('growth-executor').agent)
    const json = resultJson(result)
    expect(json.applied).toBe(0)
    expect(json.failed).toBe(1)
    const edit = (json.edits as Array<Record<string, unknown>>)[0]
    expect(edit).toMatchObject({ action: 'update', kind: 'memory', id: 'seed', applied: false })
    expect(edit?.error).toBe('entry growth exceeds the maxEntryGrowth cap')

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['seed']?.content).toBe('x')
  })
})

describe('optional refine command capability', () => {
  it('mounts without a commands capability, keeps the normal tools, and warns once', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    const warns: string[] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message) {
        if (message.type === 'warn') warns.push(message.name)
      },
    })
    await ctx.plugin(plugin, pluginConfig(tempHome()))
    expect(ctx.tools.get('harness_refine')?.name).toBe('harness_refine')
    expect(ctx.tools.get('harness_wrapup')?.name).toBe('harness_wrapup')
    expect(ctx.tools.get('harness_benchmark')?.name).toBe('harness_benchmark')
    expect(warns.filter(name => name === 'harness')).toHaveLength(1)
  })

  it('registers the refine command through a commands capability and unregisters it on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    const dispose = vi.fn()
    const register = vi.fn(() => ({ dispose }))
    ctx.provide('commands', { register })
    const fiber = await ctx.plugin(plugin, pluginConfig(tempHome()))
    expect(register).toHaveBeenCalledWith('refine', expect.any(Function))
    await fiber.dispose()
    expect(dispose).toHaveBeenCalled()
  })
})

describe('benchmark tool registration', () => {
  it('registers the harness_benchmark tool by default and skips it when disabled', async () => {
    const on = new Context()
    await on.plugin(SystemPrompt)
    await on.plugin(AgentRegistry)
    await on.plugin(ToolRuntime)
    await on.plugin(plugin, pluginConfig(tempHome()))
    expect(on.tools.get('harness_benchmark')?.name).toBe('harness_benchmark')

    const off = new Context()
    await off.plugin(SystemPrompt)
    await off.plugin(AgentRegistry)
    await off.plugin(ToolRuntime)
    await off.plugin(plugin, { ...pluginConfig(tempHome()), benchmark: { enabled: false } })
    expect(off.tools.get('harness_benchmark')).toBeUndefined()
  })

  it('accepts explicit benchmark config and still registers the tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, {
      ...pluginConfig(tempHome()),
      benchmark: { enabled: true, defaultRuns: 2, maxRuns: 5, passThreshold: 70, regressionTolerance: 5, maxFailedCells: 1 },
    })
    expect(ctx.tools.get('harness_benchmark')?.name).toBe('harness_benchmark')
  })

  it('keeps the existing tools registered when the benchmark tool is on', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(tempHome()))
    expect(ctx.tools.get('harness_refine')?.name).toBe('harness_refine')
    expect(ctx.tools.get('harness_wrapup')?.name).toBe('harness_wrapup')
    expect(ctx.tools.get('harness_benchmark')?.name).toBe('harness_benchmark')
  })
})

describe('harness-state projection', () => {
  it('injects the overview when the digest changes and skips when it does not', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(home))

    const { agent, session } = stubAgent('projected')
    const seeder = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
    seeder.applyRefinement(agent, {
      id: 'refine_p',
      summary: 'seed',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'durable' }],
    }, {})

    const signal = new AbortController().signal
    const claimed = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] })]

    const first = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected enter decision')
    const firstHarness = first.messages.filter(message => message.source.kind === HARNESS_STATE_SOURCE)
    expect(firstHarness).toHaveLength(1)
    expect(firstHarness[0].content).toContainEqual(expect.objectContaining({ type: 'text' }))

    const second = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed, turn: 1, step: 2, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )
    if (second.kind !== 'enter') throw new Error('expected enter decision')
    const secondHarness = second.messages.filter(message => message.source.kind === HARNESS_STATE_SOURCE)
    expect(secondHarness).toHaveLength(0)
  })

  it('replaces the previous harness-state block on digest change instead of accumulating', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, pluginConfig(home))

    const { agent, session } = stubAgent('projected-replace')
    const seeder = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
    seeder.applyRefinement(agent, {
      id: 'refine_p1',
      summary: 'seed one',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'durable' }],
    }, {})
    const signal = new AbortController().signal
    const claimed1 = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt one' }] })]

    const first = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed1, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed1 }),
    )
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') throw new Error('expected enter decision')
    const firstBlock = first.messages.find(message => message.source.kind === HARNESS_STATE_SOURCE)
    expect(firstBlock).toBeDefined()

    // The agent loop commits every decision message to the session log.
    for (const message of first.messages) {
      session.append('user/message', message, { surfaceOp: 'append' })
    }

    // State changes -> digest changes -> the next pre-step must replace, not add.
    seeder.applyRefinement(agent, {
      id: 'refine_p2',
      summary: 'seed two',
      edits: [{ action: 'create', kind: 'memory', id: 'fact2', content: 'more' }],
    }, {})
    const claimed2 = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt two' }] })]
    const second = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed2, turn: 1, step: 2, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed2 }),
    )
    if (second.kind !== 'enter') throw new Error('expected enter decision')
    // The replacement is committed directly to the session; the decision carries no block.
    expect(second.messages.some(message => message.source.kind === HARNESS_STATE_SOURCE)).toBe(false)

    // Exactly one harness-state block remains on the surface, with the new digest.
    const derived = session.deriveMessages()
    const blocks = derived.filter(message => message.source?.kind === HARNESS_STATE_SOURCE)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.content).not.toEqual(firstBlock?.content)
  })
})

describe('skill bundle acceptance', () => {
  it('restores and clears bundle files on rollback of a create', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm({
      id: 'refine_bundle',
      summary: 'create a bundle skill',
      edits: [{
        action: 'create', kind: 'skill', id: 'bundle-demo',
        description: 'Use whenever bundling',
        content: '## Steps\n1. Run `scripts/bundle.py`',
        files: { 'scripts/bundle.py': 'print(1)' },
      }],
    }) as never)
    await ctx.plugin(plugin, pluginConfig(home))

    const created = resultJson(await execute(ctx, 'harness_refine', { global: true }, stubAgent('executor').agent))
    expect(created.applied).toBe(1)
    expect(existsSync(join(home, 'skills', 'bundle-demo', 'scripts', 'bundle.py'))).toBe(true)
    expect(readFileSync(join(home, 'skills', 'bundle-demo', 'scripts', 'bundle.py'), 'utf8')).toBe('print(1)')
    const skillMd = readFileSync(join(home, 'skills', 'bundle-demo', 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('dsh-continual-harness')
    expect(skillMd).toContain('esp')

    // roll back the create without an LLM
    const rolled = resultJson(await execute(ctx, 'harness_refine', { rollback_id: 'refine_bundle' }, stubAgent('executor').agent))
    expect(rolled.applied).toBe(1)
    expect(existsSync(join(home, 'skills', 'bundle-demo'))).toBe(false)
  })

  it('never touches a non-harness-owned bundle during create', async () => {
    const home = tempHome()
    mkdirSync(join(home, 'skills', 'mine'), { recursive: true })
    writeFileSync(join(home, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm({
      id: 'refine_take',
      summary: 'try to take a user name',
      edits: [{ action: 'create', kind: 'skill', id: 'mine', content: 'body' }],
    }) as never)
    await ctx.plugin(plugin, pluginConfig(home))

    const result = resultJson(await execute(ctx, 'harness_refine', { global: true }, stubAgent('executor').agent))
    expect(result.failed).toBe(1)
    const edit = (result.edits as Array<Record<string, unknown>>).find(entry => entry.id === 'mine')
    expect(String(edit?.error)).toContain('not harness-owned')
    expect(readFileSync(join(home, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('---\nname: mine\n---\nuser skill')
  })
})

describe('post-apply diagnostics wiring', () => {
  it('attaches a completed diagnostics report to tool output by default', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm(PLAN) as never)
    await ctx.plugin(plugin, pluginConfig(home))

    const json = resultJson(await execute(ctx, 'harness_refine', { global: true }, stubAgent('diag-on').agent))
    expect(json).toMatchObject({ applied: 1, failed: 0, refinement_id: 'refine_appr' })
    expect(json.diagnostics).toMatchObject({ status: 'completed', structural: [], security: [], errors: [] })
  })

  it('omits diagnostics entirely when diagnosticsEnabled is false', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm(PLAN) as never)
    await ctx.plugin(plugin, { ...pluginConfig(home), diagnosticsEnabled: false })

    const json = resultJson(await execute(ctx, 'harness_refine', { global: true }, stubAgent('diag-off').agent))
    expect(json.applied).toBe(1)
    expect(json.diagnostics).toBeUndefined()
  })

  it('reports security issues from the local provider when securityEnabled is true', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm({
      id: 'refine_secret',
      summary: 'create a skill with a secret',
      edits: [{
        action: 'create', kind: 'skill', id: 'secret-demo',
        description: 'Use whenever handling tokens',
        content: '## Steps\n1. Call the API with sk-abcdef1234567890abcdef1234567890',
      }],
    }) as never)
    await ctx.plugin(plugin, { ...pluginConfig(home), securityEnabled: true })

    const json = resultJson(await execute(ctx, 'harness_refine', { global: true }, stubAgent('diag-sec').agent))
    expect(json.applied).toBe(1)
    const diagnostics = json.diagnostics as { status: string; security: Array<Record<string, unknown>> }
    expect(diagnostics.status).toBe('completed')
    const issue = diagnostics.security.find(finding => finding.skill_id === 'secret-demo')
    expect(issue?.code).toBe('secret-exposure')
    expect(issue?.severity).toBe('high')
  })
})

describe('harness_refine bundle materialization result', () => {
  it('reports materialization status and writes the bundle files', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', makePlanLlm({
      id: 'refine_bundle',
      summary: 'create a bundle skill',
      edits: [{
        action: 'create', kind: 'skill', id: 'bundle-demo',
        description: 'Use whenever bundling',
        content: '## Steps\n1. Run `scripts/bundle.py`',
        files: { 'scripts/bundle.py': 'print(1)', 'references/t.md': '# t' },
      }],
    }) as never)
    await ctx.plugin(plugin, pluginConfig(home))

    const result = await execute(ctx, 'harness_refine', { global: true }, stubAgent('executor').agent)
    const json = resultJson(result)
    expect(json.applied).toBe(1)
    const materialization = json.materialization as {
      status: string
      written: string[]
      unchanged: string[]
      skipped: string[]
      stale_candidates: string[]
      errors: unknown[]
    }
    expect(materialization).toEqual({
      status: 'completed',
      written: [
        join(home, 'skills', 'bundle-demo', 'SKILL.md'),
        join(home, 'skills', 'bundle-demo', 'scripts', 'bundle.py'),
        join(home, 'skills', 'bundle-demo', 'references', 't.md'),
      ],
      unchanged: [],
      skipped: [],
      stale_candidates: [],
      errors: [],
    })
    expect(existsSync(join(home, 'skills', 'bundle-demo', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(home, 'skills', 'bundle-demo', 'scripts', 'bundle.py'), 'utf8')).toBe('print(1)')
  })
})
