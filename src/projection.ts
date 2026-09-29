/**
 * Gated harness-state projection: keeps exactly one compact overview in the
 * model's context as a durable user message, republished only when it is
 * actually needed (see {@link registerHarnessProjection}). The overview is
 * model-visible and logged as a `plugin:dsh-continual-harness`-source user
 * message, so it satisfies the model-visible ⟺ logged rule and stays readable
 * across Session format migrations.
 *
 * Replacement, not accumulation: on a republish the previously injected block
 * is shadowed in place through a session surface `replace`, so the transcript
 * never holds a stale harness-state snapshot. The first injection lands at the
 * tail of the step's messages (after the assembled system-prompt context), so
 * the current-state reminder is the most recent system-level content before the
 * model call; subsequent updates keep that stable position. The block's
 * sequence is tracked as it commits (see session-state.ts), so locating the
 * block never scans the event log.
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
import type { HarnessState } from './types.ts'

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
 * What the model currently sees: the digest of the injected overview, the keys
 * it carries, which of those actually matched the query, and whether it carried
 * any content at all (so an emptied store can retire its names exactly once).
 */
interface InjectedBlock {
  digest: string
  keys: readonly string[]
  /** Selection-independent state stamp: a refinement landed since this block. */
  refinements: string
  hadContent: boolean
}

/** Selection-independent stamp of the state: refinement count and newest id. */
function refinementStamp(refinements: HarnessState['refinements']): string {
  return `${refinements.length}\u0000${refinements.at(-1)?.id ?? ''}`
}

/**
 * Register the pre-step projection. The overview is republished when it is
 * needed and only then — a plain digest change is not enough:
 *
 * - the first injection lands once the store has content;
 * - a refinement landing (or the store emptying) always republishes, so the
 *   block never shows stale versions or a retired entry;
 * - a query change republishes only when it surfaces an evidence-backed entry
 *   that the current block does not already carry. Follow-up messages that
 *   match nothing ("1", "继续" after the acknowledgement phrases are skipped)
 *   merely reorder the selection toward recency, and replacing relevant
 *   experience with the newest entries is worse than leaving the block alone.
 *
 * An existing block is replaced in place; otherwise the block is appended at
 * the tail of the step's messages, after the assembled system-prompt context.
 */
export function registerHarnessProjection(ctx: Context, store: HarnessStore): void {
  const injectedBlocks = new WeakMap<Agent, InjectedBlock>()

  ctx.on('agent/pre-step', async (
    { agent, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const rendered = store.render(agent)
    const hasContent = Object.values(rendered.state.entries).some(records => Object.keys(records).length > 0)
      || rendered.state.refinements.length > 0
    const { overview, injectedKeys, matchedKeys } = rendered
    const digest = digestOf(overview)
    const previous = injectedBlocks.get(agent)
    const refinements = refinementStamp(rendered.state.refinements)
    const shouldPublish = previous === undefined
      ? hasContent
      : refinements !== previous.refinements
        || (!hasContent && previous.hadContent)
        || (digest !== previous.digest && matchedKeys.some(key => !previous.keys.includes(key)))
    if (!shouldPublish) return decision
    if (signal.aborted) return decision
    const desired = harnessMessage(overview, digest)
    const record: InjectedBlock = {
      digest,
      keys: injectedKeys,
      refinements,
      hadContent: hasContent,
    }

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
      injectedBlocks.set(agent, record)
      return decision
    }

    // First injection: skip a vacuous first step, then land the block at the
    // tail of the step's messages — after the claimed batch and the assembled
    // system-prompt context — so it reads as the most recent system-level
    // reminder before the model call. Nothing has been shown yet, so the block
    // is deliberately not recorded as injected: the next step must publish it.
    if (step === 1 && decision.messages.length === 0) return decision
    store.recordInjections(agent, injectedKeys)
    injectedBlocks.set(agent, record)
    return { kind: 'enter', messages: [...decision.messages, desired] }
  })
}
