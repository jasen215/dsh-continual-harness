// tests/cache-detect.spec.ts
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { detectPlannerRoute, hasCacheEvidence } from '../src/cache-detect.ts'

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: { provider: 'p', model: 'm' },
    session,
    inbox: undefined as never,
    get status() { return 'running' },
    ctx: new Context(),
    send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {}, cancel() {}, runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** A session whose most recent assistant/message carries cacheReadTokens > 0. */
function cachedSession(): Session {
  const session = Session.create(SessionId('cached-1'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({ source: { kind: 'model', provider: 'p' }, content: [{ type: 'text', text: 'ok' }] }),
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 },
  } as never, { surfaceOp: 'append' })
  return session
}

/** A session whose assistant/message has usage but zero cacheReadTokens. */
function uncachedSession(): Session {
  const session = Session.create(SessionId('uncached-1'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({ source: { kind: 'model', provider: 'p' }, content: [{ type: 'text', text: 'ok' }] }),
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
  } as never, { surfaceOp: 'append' })
  return session
}

describe('hasCacheEvidence', () => {
  it('is true when an assistant/message carries cacheReadTokens > 0', () => {
    expect(hasCacheEvidence(cachedSession().events)).toBe(true)
  })
  it('is false when all cacheReadTokens are 0', () => {
    expect(hasCacheEvidence(uncachedSession().events)).toBe(false)
  })
  it('is false when no assistant/message has a usage record', () => {
    const session = Session.create(SessionId('no-usage'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
    expect(hasCacheEvidence(session.events)).toBe(false)
  })
  it('reads cacheReadTokens from assistant/chunk usage events as a fallback source', () => {
    const session = Session.create(SessionId('chunk-usage'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
    session.append('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 } },
    } as never)
    expect(hasCacheEvidence(session.events)).toBe(true)
  })
})

describe('detectPlannerRoute', () => {
  it('routes auto mode to A when the session has cache evidence', () => {
    expect(detectPlannerRoute(stubAgent(cachedSession()), 'auto')).toBe('A')
  })
  it('routes auto mode to B when the session lacks cache evidence', () => {
    expect(detectPlannerRoute(stubAgent(uncachedSession()), 'auto')).toBe('B')
  })
  it('routes auto mode to B for a fresh session with no history', () => {
    expect(detectPlannerRoute(stubAgent(Session.create(SessionId('fresh'))), 'auto')).toBe('B')
  })
  it('force-routes session mode to A regardless of evidence', () => {
    expect(detectPlannerRoute(stubAgent(Session.create(SessionId('forced'))), 'session')).toBe('A')
  })
  it('force-routes off mode to B regardless of evidence', () => {
    expect(detectPlannerRoute(stubAgent(cachedSession()), 'off')).toBe('B')
  })
})
