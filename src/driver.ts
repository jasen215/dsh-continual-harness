/**
 * The automatic refinement gate: after enough assistant turns (or a
 * compaction), the driver runs the review gate through the model; on approval
 * it plans and applies a session-local refinement. Cooldown and an in-flight
 * guard prevent spam; per-session counters keep agents independent.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendReview, gateOutcome } from './audit.ts'
import type { ReviewRecord } from './audit.ts'
import { completeViaAgent } from './complete.ts'
import {
  autoRefineInstructions,
  planRefinement,
  reviewAutoRefine,
  scopeInstruction,
} from './planner.ts'
import { historyForPrompt, overviewForPrompt } from './render.ts'
import type { HarnessStore } from './store.ts'
import type { AutoRefineReason } from './types.ts'

/** Default turn interval between automatic refinement passes. */
export const DEFAULT_TURN_INTERVAL = 25
/** Default cooldown between automatic refinement attempts. */
export const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000

/** Driver options resolved by the plugin. */
export interface DriverOptions {
  enabled: boolean
  turnInterval: number
  cooldownMs: number
  compact: boolean
  plannerMaxTokens: number
  maxTrajectoryChars: number
  /** Persist every gate verdict to `reviews.jsonl` under the harness home. */
  auditReviews: boolean
}

interface SessionGateState {
  turnCount: number
  lastAttemptAt: number
  inFlight: boolean
}

/** Register the automatic refinement gate over the store. */
export function registerHarnessDriver(ctx: Context, store: HarnessStore, options: DriverOptions): void {
  const gates = new Map<string, SessionGateState>()

  function gateState(sessionId: string): SessionGateState {
    let state = gates.get(sessionId)
    if (!state) {
      state = { turnCount: 0, lastAttemptAt: 0, inFlight: false }
      gates.set(sessionId, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    if (!options.enabled) return
    const state = gateState(String(session.id))
    if (event.type === 'turn/end') {
      state.turnCount += 1
      if (state.turnCount >= options.turnInterval) {
        void attemptGate(session, state, 'turn-interval')
      }
      return
    }
    // The session event map is merge-extensible: `compaction/end` is declared
    // by the compaction capability, so it falls outside this package's union.
    const rawType = (event as { type: string }).type
    if (rawType === 'compaction/end' && options.compact) {
      void attemptGate(session, state, 'compact')
    }
  })

  async function attemptGate(
    session: import('@deepseek-ai/dsh-session').Session,
    state: SessionGateState,
    reason: AutoRefineReason,
  ): Promise<void> {
    const now = Date.now()
    if (state.inFlight || now - state.lastAttemptAt < options.cooldownMs) return
    state.inFlight = true
    state.lastAttemptAt = now
    try {
      const agent = ctx.agents.get(session.id)
      if (!agent) return
      await runGate(agent, reason, state.turnCount)
      state.turnCount = 0
    } catch {
      // a failed gate (e.g. no model configured) is non-fatal; the cooldown
      // keeps the loop from hammering the seam
    } finally {
      state.inFlight = false
    }
  }

  async function runGate(agent: Agent, reason: AutoRefineReason, turnsSinceLastReview: number): Promise<void> {
    const complete = completeViaAgent(ctx, agent, options.plannerMaxTokens)
    // Persist one verdict line per gate pass; an audit write failure never
    // breaks the gate loop (and auditing can be switched off entirely).
    const record = (
      outcome: ReviewRecord['outcome'],
      extra: Pick<ReviewRecord, 'rationale' | 'refinementId' | 'rejectedEdits'> = {},
    ): void => {
      if (!options.auditReviews) return
      try {
        appendReview(store.home, {
          timestamp: new Date().toISOString(),
          sessionId: String(agent.session.id),
          trigger: reason,
          turnsSinceLastReview,
          outcome,
          ...extra,
        })
      } catch {
        // audit write failure never breaks the loop
      }
    }
    try {
      const review = await reviewAutoRefine({
        stateOverview: overviewForPrompt(store.state(agent)),
        historyText: historyForPrompt(store.history(agent)),
        trajectoryText: store.trajectory(agent, options.maxTrajectoryChars),
        reason,
      }, complete)
      if (!review.approved) {
        record('declined', { rationale: review.rationale })
        return
      }
      const plan = await planRefinement({
        stateOverview: overviewForPrompt(store.state(agent)),
        historyText: historyForPrompt(store.history(agent)),
        trajectoryText: store.trajectory(agent, options.maxTrajectoryChars),
        scopeInstruction: scopeInstruction(false),
        instructions: autoRefineInstructions(reason, review),
      }, complete)
      if (plan.edits.length === 0) {
        record('assessed', { rationale: review.rationale })
        return
      }
      const result = store.applyRefinement(agent, plan, { global: false, automatic: true })
      const applied = result.appliedEdits.filter(edit => edit.applied).length
      const rejected = result.appliedEdits.filter(edit => !edit.applied)
      record(gateOutcome(true, plan.edits.length, applied), {
        rationale: review.rationale,
        ...(result.id ? { refinementId: result.id } : {}),
        ...(rejected.length > 0
          ? {
              rejectedEdits: rejected.map(edit => ({
                kind: edit.kind,
                id: edit.id,
                action: edit.action,
                error: edit.error ?? 'rejected',
              })),
            }
          : {}),
      })
    } catch (error) {
      record('failed', { rationale: String(error) })
      throw error
    }
  }
}
