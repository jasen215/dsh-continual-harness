/**
 * Digest-tracked harness-state projection: keeps exactly one compact overview
 * in the model's context as a durable user message, republished only when the
 * state digest changes. The overview is model-visible and logged as a
 * `plugin:dsh-continual-harness`-source user message, so it satisfies the
 * model-visible ⟺ logged rule and stays readable across Session format
 * migrations.
 *
 * Replacement, not accumulation: on a digest change the previously injected
 * block is shadowed in place through a session surface `replace`, so the
 * transcript never holds a stale harness-state snapshot. The first injection
 * lands at the tail of the step's messages (after the assembled system-prompt
 * context), so the current-state reminder is the most recent system-level
 * content before the model call; subsequent updates keep that stable position.
 * The block's sequence is tracked as it commits (see session-state.ts), so
 * locating the block never scans the event log.
 * @module dsh-continual-harness
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type UserMessage } from '@deepseek-ai/dsh-session'
import { HARNESS_STATE_FORM, HARNESS_STATE_KIND } from './domain.ts'
import { harnessStateSeqToReplace } from './session-state.ts'
import type { HarnessStore } from './store.ts'

/** Digest length of the overview content hash. */
export const DIGEST_LENGTH = 16

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, DIGEST_LENGTH)
}

function harnessMessage(overview: string, digest: string): UserMessage {
  return createUserMessage({
    source: { kind: HARNESS_STATE_KIND, form: HARNESS_STATE_FORM },
    content: [{
      type: 'text',
      text: `<system-reminder>\n<harness_state digest="${digest}">\n${overview}\n</harness_state>\n</system-reminder>`,
    }],
  })
}

/**
 * Register the pre-step projection. The overview is injected when the digest
 * differs from the last injected one and the store has content (or content
 * was previously shown, so an emptied store retires its names). An existing
 * block is replaced in place; otherwise the block is appended at the tail of
 * the step's messages, after the assembled system-prompt context.
 */
export function registerHarnessProjection(ctx: Context, store: HarnessStore): void {
  const injectedDigests = new WeakMap<Agent, string>()

  ctx.on('agent/pre-step', async (
    { agent, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const rendered = store.render(agent)
    const hasContent = Object.values(rendered.state.entries).some(records => Object.keys(records).length > 0)
      || rendered.state.refinements.length > 0
    const { overview, injectedKeys } = rendered
    const digest = digestOf(overview)
    const lastDigest = injectedDigests.get(agent)
    if (digest === lastDigest || (!hasContent && lastDigest === undefined)) return decision
    if (signal.aborted) return decision
    injectedDigests.set(agent, digest)
    const desired = harnessMessage(overview, digest)

    // A committed block already exists: shadow it in place with the fresh
    // snapshot. The replacement is appended to the session log immediately,
    // so it is part of this step's derived transcript without re-entering the
    // decision messages (no double block).
    const existingSeq = harnessStateSeqToReplace(agent.session, store)
    if (existingSeq !== undefined) {
      const replaced = agent.session.append('user/message', desired, {
        surfaceOp: { op: 'replace', startSeq: existingSeq, endSeq: existingSeq },
        sourceEventSeqs: [existingSeq],
      })
      // The replacement copy is the node a later update must shadow, so record
      // it from the append itself rather than waiting for the event to come back
      // through the observer.
      store.recordSessionProjection(agent.session, { harnessStateSeq: replaced.seq })
      store.recordInjections(agent, injectedKeys)
      return decision
    }

    // First injection: skip a vacuous first step, then land the block at the
    // tail of the step's messages — after the claimed batch and the assembled
    // system-prompt context — so it reads as the most recent system-level
    // reminder before the model call.
    if (step === 1 && decision.messages.length === 0) return decision
    store.recordInjections(agent, injectedKeys)
    return { kind: 'enter', messages: [...decision.messages, desired] }
  })
}
