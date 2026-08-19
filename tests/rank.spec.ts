import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildQueryFromSession, formatHarnessStateForPromptStructured } from '../src/render.ts'
import { freshState } from '../src/refine.ts'

function userText(session: Session, text: string) {
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
}

describe('query construction', () => {
  it('takes the most recent direct-user message, ignoring harness-state sources', () => {
    const session = Session.create(SessionId('s1'))
    userText(session, 'first question')
    session.append('user/message', createUserMessage({ source: { kind: 'harness-state', digest: 'abc' }, content: [{ type: 'text', text: '<system-reminder>…' }] }), { surfaceOp: 'append' })
    userText(session, 'how do I pin versions?')
    expect(buildQueryFromSession(session)).toBe('how do I pin versions?')
  })
  it('drops empty, pure-punctuation, and ACK-phrase messages and falls back to recency', () => {
    const session = Session.create(SessionId('s2'))
    userText(session, '好的'); userText(session, '   '); userText(session, '!!!')
    expect(buildQueryFromSession(session)).toBe('')
  })
  it('keeps messages with task content even when they contain ACK words', () => {
    const session = Session.create(SessionId('s3')); userText(session, '好的，请继续修复这个 bug')
    expect(buildQueryFromSession(session)).toBe('好的，请继续修复这个 bug')
  })
  it('truncates to MAX_QUERY_CHARS', () => {
    const session = Session.create(SessionId('s4')); userText(session, 'x'.repeat(500))
    expect(buildQueryFromSession(session)?.length).toBe(400)
  })
})

describe('ranked injection', () => {
  function withEntries(overrides: Array<[string, Partial<import('../src/types.ts').HarnessEntry>]>) {
    const state = freshState()
    for (const [id, patch] of overrides) state.entries.memory[id] = { id, kind: 'memory', version: 1, content: 'default', updatedAt: '2026-01-01T00:00:00.000Z', ...patch }
    return state
  }
  it('ranks title hits over content hits, then updatedAt desc, then id asc', () => {
    const state = withEntries([['b', { title: 'pin versions', updatedAt: '2026-01-03T00:00:00.000Z' }], ['c', { content: 'pin versions please', updatedAt: '2026-01-02T00:00:00.000Z' }], ['a', { content: 'unrelated', updatedAt: '2026-01-01T00:00:00.000Z' }]])
    expect(formatHarnessStateForPromptStructured(state, 'pin versions', { sessionId: 's1', maxPerKind: 6, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:b', 'local:s1:memory:c', 'local:s1:memory:a'])
  })
  it('emits global keys for entries not shadowed by the local store', () => {
    const state = withEntries([['shared', { content: 'cross-session', updatedAt: '2026-01-02T00:00:00.000Z' }]])
    expect(formatHarnessStateForPromptStructured(state, 'cross', { sessionId: 's1', maxPerKind: 6, isLocal: () => false }).injectedKeys).toEqual(['global:memory:shared'])
  })
  it('excludes archived and shadowed (local:-prefixed) entries from injection', () => {
    const state = withEntries([['keep', { content: 'relevant keep', updatedAt: '2026-01-04T00:00:00.000Z' }], ['gone', { metadata: { lifecycleState: 'archived' }, updatedAt: '2026-01-05T00:00:00.000Z' }]])
    state.entries.memory['local:shadowed-global'] = { id: 'shadowed-global', kind: 'memory', version: 1, content: 'global dup', updatedAt: '2026-01-06T00:00:00.000Z' }
    expect(formatHarnessStateForPromptStructured(state, 'relevant', { sessionId: 's1', maxPerKind: 6, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:keep'])
  })
  it('caps per kind and falls back to pure recency on empty query', () => {
    const state = withEntries([['a', { updatedAt: '2026-01-01T00:00:00.000Z' }], ['b', { updatedAt: '2026-01-02T00:00:00.000Z' }], ['c', { updatedAt: '2026-01-03T00:00:00.000Z' }], ['d', { updatedAt: '2026-01-04T00:00:00.000Z' }]])
    expect(formatHarnessStateForPromptStructured(state, '', { sessionId: 's1', maxPerKind: 3, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:d', 'local:s1:memory:c', 'local:s1:memory:b'])
  })
  it('overview contains exactly the injected entries', () => {
    const state = withEntries([['a', { content: 'pin versions', updatedAt: '2026-01-01T00:00:00.000Z' }], ['b', { content: 'other', updatedAt: '2026-01-02T00:00:00.000Z' }]])
    const result = formatHarnessStateForPromptStructured(state, 'pin', { sessionId: 's1', maxPerKind: 1, isLocal: () => true })
    expect(result.overview).toContain('- a v1: pin versions'); expect(result.overview).not.toContain('- b v1: other'); expect(result.injectedKeys).toEqual(['local:s1:memory:a'])
  })
})
