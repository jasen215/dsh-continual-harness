// tests/cache-detect.spec.ts
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { detectPlannerRoute, isCacheEvidenceEvent } from '../src/cache-detect.ts'

/**
 * One committed assistant turn whose recorded usage reports `cacheReadTokens`.
 * The event, not the message, is the only carrier: the session-state module
 * observes `assistant/message` as it commits, and a derived `AssistantMessage`
 * holds no usage at all.
 */
function assistantEvent(rawId: string, cacheReadTokens: number | undefined): SessionEvent {
  const session = Session.create(SessionId(rawId))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
  const data = {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] }),
    ...(cacheReadTokens === undefined ? {} : { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens } }),
  }
  return session.append('assistant/message', data as never, { surfaceOp: 'append' }) as SessionEvent
}

describe('isCacheEvidenceEvent', () => {
  it('is true when an assistant/message carries cacheReadTokens > 0', () => {
    expect(isCacheEvidenceEvent(assistantEvent('cached-1', 60))).toBe(true)
  })
  it('is false when all cacheReadTokens are 0', () => {
    expect(isCacheEvidenceEvent(assistantEvent('uncached-1', 0))).toBe(false)
  })
  it('is false when the recorded call carries no usage record', () => {
    // dsh 0.1.5 removed the separate `assistant/chunk` event: its `usage` chunk
    // now folds into `assistant/message.usage`, so an assistant event without
    // usage is the only remaining "no accounting" shape.
    expect(isCacheEvidenceEvent(assistantEvent('no-usage', undefined))).toBe(false)
  })
  it('is false for a non-assistant event', () => {
    const session = Session.create(SessionId('user-only'))
    const event = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }), { surfaceOp: 'append' })
    expect(isCacheEvidenceEvent(event as SessionEvent)).toBe(false)
  })
})

describe('detectPlannerRoute', () => {
  it('routes auto mode to A when the session has cache evidence', () => {
    expect(detectPlannerRoute(true, 'auto')).toBe('A')
  })
  it('routes auto mode to B when the session lacks cache evidence', () => {
    // A fresh session with no history has no evidence, so auto mode is B.
    expect(detectPlannerRoute(false, 'auto')).toBe('B')
  })
  it('force-routes session mode to A regardless of evidence', () => {
    expect(detectPlannerRoute(false, 'session')).toBe('A')
  })
  it('force-routes off mode to B regardless of evidence', () => {
    expect(detectPlannerRoute(true, 'off')).toBe('B')
  })
})
