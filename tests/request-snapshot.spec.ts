import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createUserMessage, deepFreeze, markAgentLoopRequest,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { installHostRequestSnapshot } from '../src/request-snapshot.ts'

/** Fire one request through the 'llm/stream' waterfall (probe-verified: a
 *  plain `ctx.emit('llm/stream', options, next)` reaches `ctx.on` listeners;
 *  no real llm service is required). */
function emitRequest(ctx: Context, session: Session, extra?: Partial<GenerateOptions>): void {
  const options = markAgentLoopRequest(deepFreeze({
    provider: 'test-provider',
    model: 'test-model',
    messages: session.deriveMessages(),
    sessionId: session.id,
    ...extra,
  }))
  const next = () => (async function* () {})()
  ctx.emit('llm/stream', options as never, next as never)
}

describe('installHostRequestSnapshot', () => {
  it('captures agent-loop requests keyed by session id', () => {
    const ctx = new Context()
    const registry = installHostRequestSnapshot(ctx)
    const session = Session.create(SessionId('snap-1'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
    emitRequest(ctx, session, { system: 'sys', tools: [{ name: 'read' }] })
    const snapshot = registry.latestFor(session.id)
    expect(snapshot?.provider).toBe('test-provider')
    expect(snapshot?.model).toBe('test-model')
    expect(snapshot?.system).toBe('sys')
    expect(snapshot?.tools).toEqual([{ name: 'read' }])
    expect(snapshot?.messages).toHaveLength(1)
    expect(snapshot?.sessionId).toBe(session.id)
  })

  it('returns undefined before any request or for unknown sessions', () => {
    const ctx = new Context()
    const registry = installHostRequestSnapshot(ctx)
    expect(registry.latestFor(SessionId('never-seen'))).toBeUndefined()
  })

  it('ignores requests without the agent-loop marker (planner/one-shot calls)', () => {
    const ctx = new Context()
    const registry = installHostRequestSnapshot(ctx)
    const session = Session.create(SessionId('snap-2'))
    // no markAgentLoopRequest — a one-shot/planner request must not be captured
    ctx.emit('llm/stream', {
      provider: 'p',
      model: 'm',
      messages: session.deriveMessages(),
      sessionId: session.id,
    } as never, (() => (async function* () {})()) as never)
    expect(registry.latestFor(session.id)).toBeUndefined()
  })

  it('keeps the latest request per session', () => {
    const ctx = new Context()
    const registry = installHostRequestSnapshot(ctx)
    const session = Session.create(SessionId('snap-3'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] }), { surfaceOp: 'append' })
    emitRequest(ctx, session, { system: 'old' })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }] }), { surfaceOp: 'append' })
    emitRequest(ctx, session, { system: 'new' })
    expect(registry.latestFor(session.id)?.system).toBe('new')
    expect(registry.latestFor(session.id)?.messages).toHaveLength(2)
  })
})
