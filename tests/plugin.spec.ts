import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('plugin registration', () => {
  it('mounts the plugin and registers the harness_refine tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { defaultGlobal: true, harnessRoot: tempHome() })
    expect(ctx.tools.get('harness_refine')?.name).toBe('harness_refine')
  })

  it('rolls back a prior global refinement through the tool without an LLM', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { defaultGlobal: true, harnessRoot: home })

    const seeder = new HarnessStore(new Context(), { harnessRoot: home })
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

    const fresh = new HarnessStore(new Context(), { harnessRoot: home })
    expect(fresh.globalState().entries.memory['seed']).toBeUndefined()
  })
})

describe('harness-state projection', () => {
  it('injects the overview when the digest changes and skips when it does not', async () => {
    const home = tempHome()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { defaultGlobal: true, harnessRoot: home })

    const { agent, session } = stubAgent('projected')
    const seeder = new HarnessStore(ctx, { harnessRoot: home })
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
})
