import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { HarnessStore } from '../src/store.ts'
import { registerHarnessProjection } from '../src/projection.ts'
import { USAGE_EVENTS_FILE_NAME } from '../src/domain.ts'

const tempDirs: string[] = []
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-proj-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAgent(rawId: string): Agent {
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
  return agent
}

describe('projection telemetry', () => {
  it('records injectedKeys after a real injection and not on digest dedup', async () => {
    const ctx = new Context()
    const home = tempHome()
    const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
    const agent = stubAgent('p1')
    store.applyRefinement(agent, {
      id: 'r1', summary: 'seed',
      edits: [{ action: 'create', kind: 'memory', id: 'fact', content: 'pin versions' }],
    }, {})
    registerHarnessProjection(ctx, store)

    const signal = new AbortController().signal
    const claimed = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt' }] })]

    const first = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed, turn: 1, step: 2, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )
    expect(first.kind).toBe('enter')

    const file = join(home, USAGE_EVENTS_FILE_NAME)
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ key: `local:${String(agent.session.id)}:memory:fact` })

    // Same digest again -> no new injection, no new event.
    const second = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: claimed, turn: 1, step: 3, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )
    expect(second.kind).toBe('enter')
    const after = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(after).toHaveLength(1)
  })
})
