/**
 * The default `Complete` seam: one non-reasoning LLM call through the
 * context's `llm` service, collected to text. Consumers may inject any other
 * `Complete` implementation (e.g. a test double).
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from './domain.ts'
import type { Complete } from './planner.ts'

/** Default planning output budget for the refiner. */
export const DEFAULT_PLANNER_MAX_TOKENS = 32_000

/** One `ctx.llm.stream` call collected to text, non-reasoning. */
async function streamToText(
  ctx: Context,
  params: {
    provider: string
    model: string
    system: string
    user: string
    maxTokens: number
    signal: AbortSignal | undefined
    errorPrefix: string
  },
): Promise<string> {
  const llm = ctx.get('llm')
  if (!llm) {
    throw new Error(`${params.errorPrefix} requires the llm service on the context`)
  }
  let text = ''
  let failed = false
  for await (const chunk of llm.stream({
    provider: params.provider,
    model: params.model,
    system: params.system,
    maxTokens: params.maxTokens,
    messages: [createUserMessage({
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
      content: [{ type: 'text', text: params.user }],
    })],
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failed = true
  }
  if (failed) throw new Error(`${params.errorPrefix} failed: model request failed`)
  return text
}

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
    return streamToText(ctx, {
      provider,
      model,
      system,
      user,
      maxTokens: Math.min(maxTokens, agent.options.maxTokens ?? maxTokens),
      signal,
      errorPrefix: 'harness refinement planning',
    })
  }
}

/**
 * Build the `Complete` seam over an explicit provider/model pair through
 * `ctx.llm.stream` — the benchmark evaluator's default, mirroring
 * `completeViaAgent`'s routing with the evaluator's output budget.
 * @param ctx - context carrying the llm service.
 * @param provider - the provider to route the evaluation calls to.
 * @param model - the model to route the evaluation calls to.
 * @param maxTokens - output budget for one evaluator call.
 * @returns the seam.
 */
export function completeViaModel(
  ctx: Context,
  provider: string,
  model: string,
  maxTokens: number = DEFAULT_PLANNER_MAX_TOKENS,
): Complete {
  return async (system, user, signal) => streamToText(ctx, {
    provider,
    model,
    system,
    user,
    maxTokens,
    signal,
    errorPrefix: 'harness benchmark evaluation',
  })
}
