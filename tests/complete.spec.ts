import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { completeViaModel } from '../src/complete.ts'
import type { Complete } from '../src/planner.ts'

function ctxWith(llm: unknown): Context {
  const ctx = new Context()
  ctx.provide('llm', llm as never)
  return ctx
}

describe('completeViaModel deadline', () => {
  it('times out a hanging stream with a clear error', async () => {
    const ctx = ctxWith({
      async *stream() {
        await new Promise(() => {}) // never settles
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete = completeViaModel(ctx, 'prov', 'model', 1000, { deadlineMs: 20 })
    await expect(complete('system', 'user')).rejects.toThrow(/timed out after 20ms/)
  })

  it('aborts the underlying stream when the deadline fires', async () => {
    let observed: AbortSignal | undefined
    const ctx = ctxWith({
      async *stream(request: { signal?: AbortSignal }) {
        observed = request?.signal
        await new Promise(() => {}) // never settles
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete = completeViaModel(ctx, 'prov', 'model', 1000, { deadlineMs: 20 })
    await expect(complete('system', 'user')).rejects.toThrow(/timed out after 20ms/)
    // the deadline must cancel the stream, not merely abandon it
    expect(observed?.aborted).toBe(true)
  })
})

describe('completeViaModel finish handling', () => {
  it('treats an aborted finish as a failure, not a partial reply', async () => {
    const ctx = ctxWith({
      async *stream() {
        yield { type: 'text-delta', text: 'partial' }
        yield { type: 'finish', reason: { kind: 'aborted' } }
      },
    })
    const complete = completeViaModel(ctx, 'prov', 'model')
    await expect(complete('system', 'user')).rejects.toThrow(/aborted/)
  })

  it('still succeeds on a stop finish', async () => {
    const ctx = ctxWith({
      async *stream() {
        yield { type: 'text-delta', text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete = completeViaModel(ctx, 'prov', 'model')
    await expect(complete('system', 'user')).resolves.toBe('{"ok":true}')
  })
})

describe('completeViaModel prefix messages', () => {
  it('places prefix messages before the trailing user message', async () => {
    let seen: unknown[] | undefined
    const ctx = ctxWith({
      async *stream(request: { messages?: unknown[] }) {
        seen = request.messages
        yield { type: 'text-delta', text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const prefix = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old turn' }] })]
    const complete = completeViaModel(ctx, 'prov', 'model')
    await complete('system', 'plan now', undefined, prefix)
    expect(seen).toHaveLength(2)
    expect(seen?.[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'old turn' }] })
    expect(seen?.[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'plan now' }] })
  })

  it('omits prefix when not provided (legacy behavior unchanged)', async () => {
    let seen: unknown[] | undefined
    const ctx = ctxWith({
      async *stream(request: { messages?: unknown[] }) {
        seen = request.messages
        yield { type: 'text-delta', text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete = completeViaModel(ctx, 'prov', 'model')
    await complete('system', 'user only')
    expect(seen).toHaveLength(1)
  })
})

describe('completeViaModel request context', () => {
  it('forwards tools, sessionId, and caps maxTokens by the dynamic budget', async () => {
    let seen: { maxTokens?: number; tools?: readonly unknown[]; sessionId?: unknown; messages?: readonly unknown[] } = {}
    const ctx = ctxWith({
      async *stream(request: { maxTokens?: number; tools?: readonly unknown[]; sessionId?: unknown; messages?: readonly unknown[] }) {
        seen = request
        yield { type: 'text-delta', text: '{"id":"r","summary":"s","edits":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete: Complete = completeViaModel(ctx, 'prov', 'model', 32_000)
    const reply = await complete('sys', 'user', undefined, undefined, {
      tools: [{ name: 'read' }],
      sessionId: 'session-1' as never,
      maxTokens: 8_000,
    })
    expect(reply).toContain('"edits"')
    expect(seen.maxTokens).toBe(8_000)
    expect(seen.tools).toEqual([{ name: 'read' }])
    expect(seen.sessionId).toBe('session-1')
  })

  it('keeps the configured budget when no dynamic maxTokens is given', async () => {
    let seenMax = 0
    const ctx = ctxWith({
      async *stream(request: { maxTokens?: number }) {
        seenMax = request.maxTokens ?? 0
        yield { type: 'text-delta', text: '{"id":"r","summary":"s","edits":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const complete: Complete = completeViaModel(ctx, 'prov', 'model', 32_000)
    await complete('sys', 'user')
    expect(seenMax).toBe(32_000)
  })
})
