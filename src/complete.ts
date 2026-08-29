/**
 * The default `Complete` seam: one non-reasoning LLM call through the
 * context's `llm` service, collected to text. Consumers may inject any other
 * `Complete` implementation (e.g. a test double).
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bridgeAbortSignal, PhaseAbortError, PhaseTimeoutError, raceWithTimeout } from './async-safe.ts'
import { PLUGIN_NAME } from './domain.ts'
import type { Complete } from './planner.ts'

/** Default planning output budget for the refiner. */
export const DEFAULT_PLANNER_MAX_TOKENS = 32_000

/** Default deadline for one planning/review completion call (spec 项 3). */
export const DEFAULT_COMPLETE_DEADLINE_MS = 120_000

/** One `ctx.llm.stream` call collected to text, non-reasoning, raced against
 * the caller's abort signal and a per-call deadline: a timeout or an
 * `aborted` finish both fail instead of returning a partial reply. */
async function streamToText(
  ctx: Context,
  params: {
    provider: string
    model: string
    system: string
    user: string
    maxTokens: number
    signal: AbortSignal | undefined
    deadlineMs: number
    errorPrefix: string
  },
): Promise<string> {
  const llm = ctx.get('llm')
  if (!llm) {
    throw new Error(`${params.errorPrefix} requires the llm service on the context`)
  }
  const controller = new AbortController()
  const signal = params.signal
  const unbridge = signal === undefined ? undefined : bridgeAbortSignal(signal, controller)
  const work = (async (): Promise<string> => {
    let text = ''
    let failure: 'error' | 'aborted' | undefined
    for await (const chunk of llm.stream({
      provider: params.provider,
      model: params.model,
      system: params.system,
      maxTokens: params.maxTokens,
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
        content: [{ type: 'text', text: params.user }],
      })],
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failure = chunk.reason.kind
      }
    }
    if (failure === 'aborted') throw new Error(`${params.errorPrefix} aborted: model request aborted`)
    if (failure === 'error') throw new Error(`${params.errorPrefix} failed: model request failed`)
    return text
  })()
  try {
    // Race against the CALLER's signal, not `controller.signal`: the deadline's
    // own `controller.abort()` in `onTimeout` would otherwise win the race as a
    // PhaseAbortError, masking the timeout. The deadline must still cancel the
    // underlying stream, hence the internal-controller abort.
    return await raceWithTimeout(work, params.deadlineMs, signal, () => controller.abort())
  } catch (error) {
    if (error instanceof PhaseTimeoutError) {
      throw new Error(`${params.errorPrefix} timed out after ${params.deadlineMs}ms`)
    }
    if (error instanceof PhaseAbortError) {
      throw new Error(`${params.errorPrefix} aborted`)
    }
    throw error
  } finally {
    // The caller's signal outlives the call: drop the forward listener.
    unbridge?.()
  }
}

/**
 * Build the `Complete` seam over the agent's own provider/model through
 * `ctx.llm.stream`, non-reasoning, collected to one text reply.
 * @param ctx - context carrying the llm service.
 * @param agent - the live agent whose model plans the refinement.
 * @param maxTokens - output budget for the planning call.
 * @param options - deadline override for the planning call.
 * @returns the seam.
 */
export function completeViaAgent(
  ctx: Context,
  agent: Agent,
  maxTokens: number = DEFAULT_PLANNER_MAX_TOKENS,
  options: { deadlineMs?: number } = {},
): Complete {
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
      deadlineMs: options.deadlineMs ?? DEFAULT_COMPLETE_DEADLINE_MS,
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
 * @param options - deadline override for the evaluation calls.
 * @returns the seam.
 */
export function completeViaModel(
  ctx: Context,
  provider: string,
  model: string,
  maxTokens: number = DEFAULT_PLANNER_MAX_TOKENS,
  options: { deadlineMs?: number } = {},
): Complete {
  return async (system, user, signal) => streamToText(ctx, {
    provider,
    model,
    system,
    user,
    maxTokens,
    signal,
    deadlineMs: options.deadlineMs ?? DEFAULT_COMPLETE_DEADLINE_MS,
    errorPrefix: 'harness benchmark evaluation',
  })
}
