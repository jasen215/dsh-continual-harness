/**
 * Digest-tracked harness-state projection: keeps exactly one compact overview
 * in the model's context as a durable user message, republished only when the
 * state digest changes. The overview is model-visible and logged as a
 * `harness-state` source user message, so it satisfies the model-visible ⟺
 * logged rule.
 *
 * Replacement, not accumulation: on a digest change the previously injected
 * block is shadowed in place through a session surface `replace`, so the
 * transcript never holds a stale harness-state snapshot. The first injection
 * lands at the tail of the step's messages (after the assembled system-prompt
 * context), so the current-state reminder is the most recent system-level
 * content before the model call; subsequent updates keep that stable position.
 * @module dsh-continual-harness
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
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

/** Seq of the last visible harness-state message, or undefined when none. */
function findHarnessStateSeq(session: Session): SessionSeq | undefined {
  const surface = new Set(session.surface.nodes)
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event.data.source?.kind !== HARNESS_STATE_SOURCE) continue
    // Only nodes still on the model-visible surface count; a block shadowed by
    // a previous replace or by compaction is already gone.
    if (!surface.has(event.seq)) continue
    return event.seq
  }
  return undefined
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
    const existingSeq = findHarnessStateSeq(agent.session)
    if (existingSeq !== undefined) {
      agent.session.append('user/message', desired, {
        surfaceOp: { op: 'replace', start: existingSeq, end: existingSeq },
        sourceEventSeqs: [existingSeq],
      })
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
