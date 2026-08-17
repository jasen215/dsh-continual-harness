/**
 * Digest-tracked harness-state projection: keeps a compact overview in the
 * model's context as a durable user message, republished only when the state
 * digest changes. The overview is model-visible and logged as a
 * `harness-state` source user message, so it satisfies the model-visible ⟺
 * logged rule.
 * @module dsh-continual-harness
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { HARNESS_STATE_SOURCE } from './domain.ts'
import type { HarnessStore } from './store.ts'

/** Digest length of the overview content hash. */
export const DIGEST_LENGTH = 16

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, DIGEST_LENGTH)
}

function harnessMessage(overview: string, digest: string): UserMessage {
  return createUserMessage({
    source: { kind: HARNESS_STATE_SOURCE, digest },
    content: [{
      type: 'text',
      text: `<system-reminder>\n<harness_state digest="${digest}">\n${overview}\n</harness_state>\n</system-reminder>`,
    }],
  })
}

/**
 * Register the pre-step projection. The overview is injected after the
 * claimed input batch of a step when the digest differs from the last
 * injected one and the store has content (or content was previously shown,
 * so an emptied store retires its names).
 */
export function registerHarnessProjection(ctx: Context, store: HarnessStore): void {
  const injectedDigests = new WeakMap<Agent, string>()

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const state = store.state(agent)
    const hasContent = Object.values(state.entries).some(records => Object.keys(records).length > 0)
      || state.refinements.length > 0
    const overview = store.render(agent)
    const digest = digestOf(overview)
    const lastDigest = injectedDigests.get(agent)
    if (digest === lastDigest || (!hasContent && lastDigest === undefined)) return decision
    if (signal.aborted) return decision
    injectedDigests.set(agent, digest)
    if (decision.messages.some(message => message.source.kind === HARNESS_STATE_SOURCE)) return decision
    if (step === 1 && decision.messages.length === 0) return decision
    const desired = harnessMessage(overview, digest)
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })
}
