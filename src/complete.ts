/**
 * The default `Complete` seam: one non-reasoning LLM call through the
 * context's `llm` service, collected to text. Consumers may inject any other
 * `Complete` implementation (e.g. a test double).
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Complete } from './planner.ts'

/** Default planning output budget for the refiner. */
export const DEFAULT_PLANNER_MAX_TOKENS = 32_000

/**
 * Build the `Complete` seam over the agent's own provider/model through
 * `ctx.llm.stream`, non-reasoning, collected to one text reply.
 * @param ctx - context carrying the llm service.
 * @param agent - the live agent whose model plans the refinement.
 * @param maxTokens - output budget for the planning call.
 * @returns the seam.
 */
export function completeViaAgent(ctx: Context, agent: Agent, maxTokens: number = DEFAULT_PLANNER_MAX_TOKENS): Complete {
  return async (system, user, signal) => {
    const provider = agent.options.provider
    const model = agent.options.model
    if (!provider || !model) {
      throw new Error('harness refinement requires an agent with a configured provider and model')
    }
    const llm = ctx.get('llm')
    if (!llm) {
      throw new Error('harness refinement requires the llm service on the context')
    }
    let text = ''
    let failed = false
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      maxTokens: Math.min(maxTokens, agent.options.maxTokens ?? maxTokens),
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-continual-harness' },
        content: [{ type: 'text', text: user }],
      })],
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failed = true
    }
    if (failed) throw new Error('harness refinement planning failed: model request failed')
    return text
  }
}
