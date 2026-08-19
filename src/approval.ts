/**
 * Optional conservative approval gate for global store writes. The
 * `dsh-user-questions` package is not installed in this repo: this module
 * defines the minimal local contract and resolves the service lazily off the
 * context at call time, aligning with the real service once it lands.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One selectable answer to an interactive question. */
export interface QuestionOption {
  label: string
  value: string
}

/** The answer to an interactive question; `value` absent when unanswered. */
export interface QuestionAnswer {
  value?: string
}

/**
 * Minimal interactive-question contract mirroring `dsh-user-questions`.
 * Resolved lazily; never imported eagerly.
 */
export interface QuestionService {
  ask(payload: {
    prompt: string
    options: QuestionOption[]
    signal?: AbortSignal
  }): Promise<QuestionAnswer>
}

/** Resolve the user-questions service off the context, if attached. */
export function questionServiceOf(ctx: Context): QuestionService | undefined {
  return (ctx as { userQuestions?: unknown }).userQuestions as QuestionService | undefined
}

/**
 * Require explicit human approval before a global store write commits.
 * @param ctx - context that may carry the user-questions service.
 * @param agent - the requesting agent; kept for signature parity, currently
 * unused by the local service contract.
 * @param signal - abort signal passed through to the question.
 * @param what - human-readable summary of the pending global write.
 * @throws when no service is available or the user rejects.
 */
export async function requireGlobalApproval(
  ctx: Context,
  _agent: Agent | undefined,
  signal: AbortSignal | undefined,
  what: string,
): Promise<void> {
  const service = questionServiceOf(ctx)
  if (!service) throw new Error('userQuestions service is not loaded; install dsh-user-questions to enable the conservative approval mode')
  const answer = await service.ask({
    prompt: `Approve writing to the cross-session global store?\n\n${what}`,
    options: [{ label: 'Approve', value: 'approve' }, { label: 'Reject', value: 'reject' }],
    ...(signal === undefined ? {} : { signal }),
  })
  if (answer.value !== 'approve') throw new Error('rejected by the user')
}
