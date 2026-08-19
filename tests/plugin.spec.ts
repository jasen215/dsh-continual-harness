import { mkdtempSync, rmSync } from 'node:fs'
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
import { HARNESS_STATE_SOURCE } from '../src/domain.ts'
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

describe('conservative global approval mode', () => {
  it('default mode performs a global write without consulting the approval service', async () => {
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

  it('conservative mode blocks a global write the user rejects', async () => {
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
    expect(json.summary).toContain('未获批')
    expect(json.applied).toBe(0)
    expect(stub.ask).toHaveBeenCalledOnce()

    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().entries.memory['m1']).toBeUndefined()
  })

  it('conservative mode allows a global write the user approves', async () => {
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
