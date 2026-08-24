/**
 * The automatic refinement gate: after enough assistant turns (or a
 * compaction), the driver runs the review gate through the model; on approval
 * it delegates an `AutomaticPlanRequest` to the shared `RefineCoordinator`,
 * which owns planning, approval, and the store commit. Cooldown and an
 * in-flight guard prevent spam; per-session counters keep agents independent.
 * When a session leaves the store, a best-effort final drain awaits in-flight
 * review work and starts due-but-unstarted gates so scheduled refinement is
 * not lost.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { appendReview } from './audit.ts'
import type { ReviewRecord } from './audit.ts'
import { completeViaAgent } from './complete.ts'
import type { AutomaticPlanRequest, RefineCoordinator, RefineExecutionResult } from './coordinator.ts'
import { autoRefineInstructions, reviewAutoRefine } from './planner.ts'
import { historyForPrompt, overviewForPrompt } from './render.ts'
import { mergeHarnessStates } from './storage.ts'
import type { HarnessStore } from './store.ts'
import type { AutoRefineReason } from './types.ts'

/** Default turn interval between automatic refinement passes. */
export const DEFAULT_TURN_INTERVAL = 25
/** Default cooldown between automatic refinement attempts. */
export const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000
/** Upper bound the final drain waits on pending/in-flight review work. */
export const FINAL_DRAIN_TIMEOUT_MS = 1_000

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

/**
 * Per-session gate bookkeeping. Pending and in-flight are separate: pending
 * means the threshold (or compaction) was reached but the attempt has not
 * started yet, so the final drain can still pick it up; in-flight means an
 * attempt is currently running and its promise can be awaited.
 */
interface SessionGateState {
  /** Assistant turns since the last attempt reached a terminal result. */
  turnCount: number
  /** When the last attempt started; the cooldown anchor. */
  lastAttemptAt: number
  /** A gate is due (threshold or compaction) but its attempt has not started. */
  pending: boolean
  /** Why the due gate was scheduled; the final drain replays this at teardown. */
  pendingReason: AutoRefineReason | null
  /** The running gate attempt, if any; the final drain awaits this promise. */
  inFlight: Promise<void> | null
  /** The per-session final drain has run; late events cannot start new work. */
  closed: boolean
}

/** The drainable driver surface returned to the plugin. */
export interface HarnessDriver {
  /**
   * Best-effort final drain for one session: awaits in-flight review work and
   * starts a due-but-unstarted gate, bounded by a short timeout. Idempotent;
   * never throws out of the disposal path.
   */
  finalize(sessionId: string): Promise<void>
}

/** Register the automatic refinement gate over the shared coordinator. */
export function registerHarnessDriver(
  ctx: Context,
  coordinator: RefineCoordinator,
  store: HarnessStore,
  options: DriverOptions,
): HarnessDriver {
  const gates = new Map<string, SessionGateState>()

  function gateState(sessionId: string): SessionGateState {
    let state = gates.get(sessionId)
    if (!state) {
      state = { turnCount: 0, lastAttemptAt: 0, pending: false, pendingReason: null, inFlight: null, closed: false }
      gates.set(sessionId, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    if (!options.enabled) return
    const state = gateState(String(session.id))
    if (event.type === 'turn/end') {
      // Once a gate is parked (due but cooldown-blocked), further turns do
      // not inflate the count that parked gate will report; the next
      // interval only starts after that gate runs and resets the counter.
      if (!state.pending) state.turnCount += 1
      if (state.turnCount >= options.turnInterval) {
        scheduleGate(String(session.id), state, 'turn-interval')
      }
      return
    }
    // The session event map is merge-extensible: `compaction/end` is declared
    // by the compaction capability, so it falls outside this package's union.
    const rawType = (event as { type: string }).type
    if (rawType === 'compaction/end' && options.compact) {
      scheduleGate(String(session.id), state, 'compact')
    }
  })

  // `session/disposed` is the dsh-session first-class teardown boundary
  // (emitted once when an announced session leaves the store, per its typings);
  // there is no `session/end` event, so the final drain attaches here, keyed
  // off the session id from the payload. Cordis fibers dispose this listener
  // with the plugin, so it cannot leak across unload. Guarded like the event
  // listener: a disabled driver owns no gate state to drain.
  if (options.enabled) {
    ctx.on('session/disposed', (session) => {
      void finalizeSession(String(session.id))
    })
  }

  /**
   * Mark a gate due and (re)try the event-path attempt. Invoked on every
   * `turn/end` (or compaction) while a gate is due: `attemptGate` re-checks
   * the cooldown itself, so a due-but-blocked gate runs on the first event
   * after the cooldown elapses — the final drain stays a last-chance
   * recovery, not the only trigger (spec §3.2).
   */
  function scheduleGate(sessionId: string, state: SessionGateState, reason: AutoRefineReason): void {
    // A closed session (finalizer already ran) or an already-running attempt
    // must not start more work.
    if (state.closed || state.inFlight) return
    if (!state.pending) {
      state.pending = true
      state.pendingReason = reason
    }
    void attemptGate(sessionId, state)
  }

  /** The event-path attempt: the cooldown guards repeated triggers. */
  async function attemptGate(sessionId: string, state: SessionGateState): Promise<void> {
    // A due-but-blocked gate stays pending and is re-attempted on later
    // events once the cooldown elapses; the final drain is the last-chance
    // recovery at teardown.
    if (Date.now() - state.lastAttemptAt < options.cooldownMs) return
    const reason = state.pendingReason
    if (!reason) return
    await startAttempt(sessionId, state, reason)
  }

  /** Transition one due gate into flight and run it to a terminal result. */
  async function startAttempt(sessionId: string, state: SessionGateState, reason: AutoRefineReason): Promise<void> {
    const agent = ctx.agents.get(sessionId as SessionId)
    if (!agent) return
    state.pending = false
    state.pendingReason = null
    state.lastAttemptAt = Date.now()
    state.inFlight = runGate(agent, reason, state.turnCount)
    try {
      await state.inFlight
    } catch {
      // a failed gate (e.g. no model configured) is non-fatal; the cooldown
      // keeps the loop from hammering the seam
    } finally {
      // The counter resets only at a terminal result: the attempt settled,
      // whether the gate succeeded or failed. It never resets before the
      // attempt actually started (blocked or skipped attempts keep it).
      state.turnCount = 0
      state.inFlight = null
    }
  }

  /** The per-session final drain: idempotent, bounded, never throws. */
  async function finalizeSession(sessionId: string): Promise<void> {
    const state = gates.get(sessionId)
    if (!state || state.closed) return
    // Mark closed first so late events cannot start new work; repeated
    // finalizer calls then no-op instead of duplicating work.
    state.closed = true
    // Snapshot the work owed at teardown: an in-flight attempt is awaited
    // (its own verdict is already audited — never re-run), and a
    // due-but-unstarted gate is started now, bypassing the cooldown: the
    // drain is the last chance to run it before the session leaves the store.
    const work = state.inFlight ?? (
      state.pending && state.pendingReason ? startAttempt(sessionId, state, state.pendingReason) : null
    )
    if (!work) return
    try {
      await settleWithin(work, FINAL_DRAIN_TIMEOUT_MS)
    } catch (error) {
      // A failed or timed-out drain never throws out of the disposal path.
      ctx.logger('harness').warn(`[driver] final drain for session ${sessionId} failed: ${String(error)}`)
    }
  }

  /** One review → coordinator-delegated gate pass, auditing its own verdict once. */
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
      // The review gate reads the current (local) store context for its
      // verdict only. Planner context capture, approval, and the commit all
      // belong to the coordinator, which reads its own baseline inside
      // execute; the driver never plans or calls the store directly.
      const localState = store.localState(agent)
      const stateOverview = overviewForPrompt(mergeHarnessStates(store.globalState(), localState))
      const historyText = historyForPrompt(store.history(agent))
      const trajectoryText = store.trajectory(agent, options.maxTrajectoryChars)
      const review = await reviewAutoRefine({
        stateOverview,
        historyText,
        trajectoryText,
        reason,
      }, complete)
      if (!review.approved) {
        record('declined', { rationale: review.rationale })
        return
      }
      const request: AutomaticPlanRequest = {
        mode: 'plan',
        source: 'automatic',
        scope: 'local',
        agent,
        automaticContext: { reason, reviewRationale: review.rationale },
        instructions: autoRefineInstructions(reason, review),
      }
      const execution = await coordinator.execute(request)
      const verdict = auditForExecution(execution, review.rationale)
      record(verdict.outcome, verdict.extra)
    } catch (error) {
      record('failed', { rationale: String(error) })
      throw error
    }
  }

  return { finalize: finalizeSession }
}

/**
 * Map an approved gate's coordinator execution onto the durable verdict. A
 * `not-committed` result audits `failed` when the execution reported an error
 * and `assessed` when the approved request came back a no-op; any committed
 * result audits `approved` with rejected edit details taken from the
 * refinement record, never recomputed from `appliedCount`/`rejectedCount`. A
 * materialization or diagnostics failure stays visible in the rationale but
 * never demotes an already-committed refinement, and never adds a second
 * audit record.
 */
function auditForExecution(
  execution: RefineExecutionResult,
  reviewRationale: string,
): { outcome: ReviewRecord['outcome']; extra: Pick<ReviewRecord, 'rationale' | 'refinementId' | 'rejectedEdits'> } {
  const notes = [
    ...(execution.error ? [`${execution.error.code}: ${execution.error.message}`] : []),
    ...diagnosticsNotes(execution.diagnostics),
  ]
  if (execution.commitStatus === 'not-committed') {
    if (notes.length > 0) {
      return {
        outcome: 'failed',
        extra: { rationale: [reviewRationale, ...notes].join(' — ') },
      }
    }
    return { outcome: 'assessed', extra: { rationale: reviewRationale } }
  }
  const rejected = (execution.refinement?.appliedEdits ?? []).filter(edit => !edit.applied)
  return {
    outcome: 'approved',
    extra: {
      rationale: notes.length > 0 ? [reviewRationale, ...notes].join(' — ') : reviewRationale,
      ...(execution.refinement?.id ? { refinementId: execution.refinement.id } : {}),
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
    },
  }
}

/**
 * One rationale note per diagnostics provider error: `diagnostics: <provider>
 * <code>: <message>`. A partial report's provider failures must stay visible
 * in the audit even when the commit itself carries no domain error.
 */
function diagnosticsNotes(diagnostics: RefineExecutionResult['diagnostics']): string[] {
  if (diagnostics === undefined) return []
  return diagnostics.errors.map(error => `diagnostics: ${error.provider} ${error.code}: ${error.message}`)
}

/** Await `work` but bound the wait to `ms`; a timeout resolves as `undefined`. */
function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    void work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}
