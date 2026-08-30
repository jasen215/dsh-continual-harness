import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { completeViaModel } from '../src/complete.ts'

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
