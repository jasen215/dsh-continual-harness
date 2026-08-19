import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  questionServiceOf,
  requireGlobalApproval,
  type QuestionService,
} from '../src/approval.ts'

/** The exact service-missing error message from the controller ruling. */
const SERVICE_MISSING = 'userQuestions 服务未加载；安装 dsh-user-questions 以启用保守审批模式'

function stubService(value?: string): QuestionService & { ask: ReturnType<typeof vi.fn> } {
  return { ask: vi.fn(async () => (value === undefined ? {} : { value })) }
}

function attach(ctx: Context, service: unknown): void {
  ;(ctx as { userQuestions?: unknown }).userQuestions = service
}

describe('questionServiceOf', () => {
  it('returns undefined when no userQuestions service is attached', () => {
    expect(questionServiceOf(new Context())).toBeUndefined()
  })

  it('returns the attached stub when one is set on the context', () => {
    const ctx = new Context()
    const stub = stubService('approve')
    attach(ctx, stub)
    expect(questionServiceOf(ctx)).toBe(stub)
  })
})

describe('requireGlobalApproval', () => {
  it('resolves when the user approves', async () => {
    const ctx = new Context()
    attach(ctx, stubService('approve'))
    await expect(requireGlobalApproval(ctx, undefined, undefined, 'a plan')).resolves.toBeUndefined()
  })

  it('throws `rejected by the user` when the user rejects', async () => {
    const ctx = new Context()
    attach(ctx, stubService('reject'))
    await expect(requireGlobalApproval(ctx, undefined, undefined, 'a plan'))
      .rejects.toThrow('rejected by the user')
  })

  it('throws `rejected by the user` when the answer carries no value', async () => {
    const ctx = new Context()
    attach(ctx, stubService(undefined))
    await expect(requireGlobalApproval(ctx, undefined, undefined, 'a plan'))
      .rejects.toThrow('rejected by the user')
  })

  it('throws the service-missing message when no service is available', async () => {
    await expect(requireGlobalApproval(new Context(), undefined, undefined, 'a plan'))
      .rejects.toThrow(SERVICE_MISSING)
  })

  it('passes the prompt and the signal through to the service', async () => {
    const ctx = new Context()
    const stub = stubService('approve')
    attach(ctx, stub)
    const signal = new AbortController().signal

    await requireGlobalApproval(ctx, undefined, signal, 'approve this global write')

    expect(stub.ask).toHaveBeenCalledOnce()
    const payload = stub.ask.mock.calls[0]?.[0]
    expect(payload?.prompt).toContain('批准写入跨会话全局 store？')
    expect(payload?.prompt).toContain('approve this global write')
    expect(payload?.signal).toBe(signal)
    expect(payload?.options).toEqual([
      { label: '批准', value: 'approve' },
      { label: '拒绝', value: 'reject' },
    ])
  })
})
