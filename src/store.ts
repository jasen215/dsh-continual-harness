/**
 * The harness store: read/merge/apply/rollback over local and global state
 * files, trajectory serialization, and the durable session event/emit commit
 * path. A plain class owned by the plugin's `apply`; not a Cordis service.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildSnapshot } from './benchmark.ts'
import type { HarnessSnapshot } from './benchmark.ts'
import { HARNESS_REFINEMENT_EVENT } from './domain.ts'
import { applyRefinementProposal, entryToEditFields, rollbackProposal, touchedSkillIds } from './refine.ts'
import { buildQueryFromSession, DEFAULT_ENTRIES_PER_KIND, formatHarnessStateForPromptStructured } from './render.ts'
import { DEFAULT_SKILL_BUNDLE_LIMITS, defaultSkillFsOps, inspectSkillBundle, reconcileSkillFiles } from './skills.ts'
import type { SkillBundleLimits } from './skills.ts'
import {
  appendGlobalRefinement,
  appendUsageEvents,
  defaultHarnessHome,
  getGlobalHarnessStateDir,
  getLocalHarnessStateDir,
  loadGlobalRefinementHistory,
  loadHarnessState,
  loadUsageEvents,
  mergeHarnessStates,
  mergeRefinementHistory,
  saveHarnessState,
} from './storage.ts'
import { aggregateUsage } from './usage.ts'
import type { HarnessState, MaterializationResult, RefinementKind, RefinementProposal, RefinementResult } from './types.ts'

/** Default tail-biased trajectory window for planning. */
export const DEFAULT_TRAJECTORY_MAX_CHARS = 80_000

/**
 * Runtime shape of `Session.append` once upstream AppendOptions lands: a
 * non-surface event append that may carry the `ignorable` envelope marker.
 * `Session.append` currently types non-surface events with no third
 * argument, so the capability is reached through an explicit escape hatch.
 */
type IgnorableAppend = (type: string, data: unknown, opts?: { ignorable?: true }) => { ignorable?: true }

/**
 * Whether the running dsh-session's `Session.append` can emit the
 * `ignorable` envelope marker on a non-surface event. The harness core
 * currently rejects unknown out-of-repo event types at read time unless the
 * event carries `ignorable: true`, but `append` has no such writer option
 * yet (upstream AppendOptions is pending); probing the returned envelope
 * detects the capability exactly, so the plugin writes the informational
 * session event only when a reader can actually skip it.
 */
let appendSupportsIgnorable: boolean | undefined

function probeAppendIgnorable(): boolean {
  if (appendSupportsIgnorable === undefined) {
    try {
      const probe = Session.create(SessionId('__harness-ignorable-probe__'))
      const append = probe.append as unknown as IgnorableAppend
      const event = append('todo/write', { todos: [] }, { ignorable: true })
      appendSupportsIgnorable = event.ignorable === true
    } catch {
      appendSupportsIgnorable = false
    }
  }
  return appendSupportsIgnorable
}

/**
 * Append a non-surface session event carrying the `ignorable` envelope
 * marker, but only when the running dsh-session supports it; no-op
 * otherwise. Use for out-of-repo informational events so every reader may
 * safely skip them.
 */
function appendIgnorableSessionEvent(session: Session, type: string, data: unknown): void {
  if (!probeAppendIgnorable()) return
  const append = session.append as unknown as IgnorableAppend
  append(type, data, { ignorable: true })
}

/** Options for a store commit. */
export interface CommitOptions {
  /** Commit to the cross-session global store instead of the session store. */
  global?: boolean
  /** When set, the commit is recorded as the rollback of this refinement id. */
  rollbackOf?: string
  /** Marks the commit as riding the automatic path (gate), enabling protected-layer checks. */
  automatic?: boolean
  /**
   * Target-store state captured at planning time, used for baseline conflict
   * detection: an edit whose target entry changed between planning and commit
   * is rejected. When absent (rollback/promote), the commit-time read is used.
   */
  baseline?: HarnessState
}

/** Persistent harness store owned by the plugin. */
export class HarnessStore {
  /** Harness home directory (defaults under the dsh home). */
  readonly home: string
  /** Skills directory where effective skill entries materialize as SKILL.md. */
  readonly skillsDir: string
  /** Per-commit entry growth fraction cap; 0 (default) disables the check. */
  private readonly maxEntryGrowth: number | undefined
  /** Kinds protected from the automatic path; plumbed for Config wiring. */
  private readonly protectedKinds: readonly RefinementKind[] | undefined
  /** Skill bundle limits used by L1 files validation (spec §7.10). */
  private readonly skillBundleLimits: SkillBundleLimits
  /** Per-kind cap for ranked prompt injection. */
  private readonly maxInjectedEntriesPerKind: number
  /** In-memory injection telemetry, loaded once from usage.events.jsonl. */
  private usage: Record<string, { injectionCount: number; lastInjectedAt?: string }> | undefined

  constructor(
    private readonly ctx: Context,
    options: {
      harnessRoot?: string
      skillsDir?: string
      maxEntryGrowth?: number
      protectedKinds?: readonly RefinementKind[]
      skillBundleLimits?: SkillBundleLimits
      maxInjectedEntriesPerKind?: number
    } = {},
  ) {
    this.home = options.harnessRoot ?? defaultHarnessHome()
    this.skillsDir = options.skillsDir ?? dshHomePath('skills')
    this.maxEntryGrowth = options.maxEntryGrowth
    this.protectedKinds = options.protectedKinds
    this.skillBundleLimits = options.skillBundleLimits ?? DEFAULT_SKILL_BUNDLE_LIMITS
    this.maxInjectedEntriesPerKind = options.maxInjectedEntriesPerKind ?? DEFAULT_ENTRIES_PER_KIND
  }

  /** The session-local state for an agent; migration diagnostics are logged. */
  localState(agent: Agent): HarnessState {
    return loadHarnessState(
      getLocalHarnessStateDir(this.home, String(agent.session.id)),
      diagnostics => this.logMigration(diagnostics),
    )
  }

  /** The cross-session global state; migration diagnostics are logged. */
  globalState(): HarnessState {
    return loadHarnessState(getGlobalHarnessStateDir(this.home), diagnostics => this.logMigration(diagnostics))
  }

  private logMigration(diagnostics: string[]): void {
    for (const diagnostic of diagnostics) this.ctx.logger('harness').warn(`state migration: ${diagnostic}`)
  }

  /** The merged view the model sees: local shadows same-id global entries. */
  state(agent: Agent): HarnessState {
    return mergeHarnessStates(this.globalState(), this.localState(agent))
  }

  /**
   * Capture a read-only snapshot of the merged local/global state without
   * persisting anything: no files are written, no entries are mutated or
   * stamped, and no injection or usage tracking is triggered. The returned
   * snapshot's `state` is a structured-clone copy of the merged view and its
   * `layers` retain the two source stores, so a candidate can be derived by
   * applying a refinement to its own layer; persist it with
   * `captureReferenceSnapshot`.
   */
  captureSnapshot(agent: Agent, snapshotId: string, refinementId?: string): HarnessSnapshot {
    // read each layer once; the merged state is derived from them, so no
    // interleaved writer can persist layers that do not merge to the state
    const local = this.localState(agent)
    const global = this.globalState()
    return buildSnapshot(mergeHarnessStates(global, local), snapshotId, refinementId, { local, global })
  }

  /** Merged refinement history: session store refinements first, then global history. */
  history(agent: Agent): RefinementResult[] {
    const local = this.localState(agent).refinements
    return mergeRefinementHistory(local, loadGlobalRefinementHistory(this.home))
  }

  /** fs-backed create-conflict gate: a create onto a non-harness-owned bundle is rejected (spec §7.4). */
  private createConflictError(id: string): string | undefined {
    const inspected = inspectSkillBundle(defaultSkillFsOps, this.skillsDir, id)
    if (inspected.state === 'missing' || (inspected.state === 'present' && inspected.harnessOwned)) return undefined
    return `skill directory "${id}" exists and is not harness-owned; pick another id`
  }

  /** Structured overview + injected keys for prompt injection. */
  render(agent: Agent): { overview: string; injectedKeys: string[] } {
    const local = this.localState(agent)
    const state = mergeHarnessStates(this.globalState(), local)
    return formatHarnessStateForPromptStructured(state, buildQueryFromSession(agent.session), {
      maxPerKind: this.maxInjectedEntriesPerKind,
      sessionId: String(agent.session.id),
      isLocal: (kind, id) => local.entries[kind][id] !== undefined,
    })
  }

  /** Lazy-load injection telemetry into memory. */
  private usageStats(): Record<string, { injectionCount: number; lastInjectedAt?: string }> {
    if (this.usage === undefined) {
      try {
        this.usage = aggregateUsage(loadUsageEvents(this.home))
      } catch (error) {
        this.ctx.logger('harness').warn(`usage load failed: ${String(error)}`)
        this.usage = {}
      }
    }
    return this.usage
  }

  /** Record one injection per key: batch-append the events and update memory; never blocks injection. */
  recordInjections(agent: Agent, injectedKeys: string[]): void {
    void agent
    if (injectedKeys.length === 0) return
    const now = new Date().toISOString()
    const stats = this.usageStats()
    const events = injectedKeys.map(key => ({ key, at: now }))
    try {
      appendUsageEvents(this.home, events)
    } catch (error) {
      this.ctx.logger('harness').warn(`usage append failed: ${String(error)}`)
    }
    for (const { key } of events) {
      const current = stats[key] ?? { injectionCount: 0 }
      current.injectionCount += 1
      current.lastInjectedAt = now
      stats[key] = current
    }
  }

  /** Aggregate stats for one usage key (for wrap-up suggestions). */
  usageStatsFor(key: string): { injectionCount: number; lastInjectedAt?: string } | undefined {
    return this.usageStats()[key]
  }

  /** Tail-biased trajectory serialization for the planner. */
  trajectory(agent: Agent, maxChars: number = DEFAULT_TRAJECTORY_MAX_CHARS): string {
    return serializeTrajectory(agent.session, maxChars)
  }

  /**
   * Commit a planned refinement: apply to the target store with baseline
   * conflict detection, persist, append the durable session event, append the
   * global history when global, and emit the scoped `harness/refined` event.
   * The baseline defaults to the commit-time read; callers that planned
   * against an earlier snapshot pass it via `options.baseline` so edits over
   * entries changed during planning are rejected.
   */
  applyRefinement(
    agent: Agent,
    plan: RefinementProposal,
    options: CommitOptions = {},
  ): RefinementResult & { materialization: MaterializationResult } {
    const global = options.global === true
    const target = global ? this.globalState() : this.localState(agent)
    const baseline = options.baseline ?? target
    const { result, state } = applyRefinementProposal(target, plan, {
      id: plan.id,
      scope: global ? 'global' : 'local',
      baselineState: baseline,
      ...(this.maxEntryGrowth === undefined ? {} : { maxEntryGrowth: this.maxEntryGrowth }),
      ...(this.protectedKinds === undefined ? {} : { protectedKinds: this.protectedKinds }),
      skillBundleLimits: this.skillBundleLimits,
      editGate: edit => edit.action === 'create' && edit.kind === 'skill' ? this.createConflictError(edit.id) : undefined,
      // local commits see the global store read-only through the rule layer
      ...(global ? {} : { globalEntries: this.globalState().entries }),
      ...(options.automatic === undefined ? {} : { automatic: options.automatic }),
      ...(options.rollbackOf === undefined ? {} : { rollbackOf: options.rollbackOf }),
      sourceSession: String(agent.session.id),
    })
    if (global) {
      saveHarnessState(getGlobalHarnessStateDir(this.home), state)
      appendGlobalRefinement(this.home, result)
    } else {
      saveHarnessState(getLocalHarnessStateDir(this.home, String(agent.session.id)), state)
    }
    // The `harness/refinement` session event is out-of-repo vocabulary: the
    // harness core's generated KNOWN_SESSION_EVENT_TYPES does not include it,
    // and a reader meeting an unrecognized non-ignorable type refuses the
    // whole log (SessionFormatUnsupportedError). The event is purely
    // informational — history() reads the on-disk store, which already
    // persists every result — so write it only when the running harness can
    // emit `ignorable: true` (then every reader may safely skip it); otherwise
    // omit it to keep every session readable, including after this plugin is
    // unmounted. The scoped `harness/refined` emit below still fires
    // regardless, so live observers and the invariant companion are
    // unaffected.
    appendIgnorableSessionEvent(agent.session, HARNESS_REFINEMENT_EVENT, result)
    const materialization = this.materializeSkills(agent, result)
    agentEvents(this.ctx, agent).emit('harness/refined', { result })
    return Object.assign(result, { materialization })
  }

  /** Promote a local entry to global by copy: local stays unchanged; a same-id
   * global is a deterministic conflict. Not a cross-store transaction. */
  promoteEntry(agent: Agent, id: string): { applied: boolean; error?: string } {
    const local = this.localState(agent)
    const global = this.globalState()
    const hits = (Object.keys(local.entries) as RefinementKind[])
      .map(kind => ({ kind, entry: local.entries[kind][id] }))
      .filter(candidate => candidate.entry !== undefined)
    if (hits.length === 0) return { applied: false, error: `local entry not found: ${id}` }
    if (hits.length > 1) return { applied: false, error: `ambiguous local id: ${id}` }
    const { kind, entry } = hits[0]!
    if (global.entries[kind][id] !== undefined) return { applied: false, error: 'global id conflict' }
    this.applyRefinement(agent, {
      id: `promote_${Date.now()}`,
      summary: `Promote local ${kind}:${id} to global`,
      edits: [{ action: 'create', kind, id, ...entryToEditFields(entry!), reason: 'promote from session wrap-up' }],
    }, { global: true })
    return { applied: true }
  }

  /**
   * Materialize the SKILL.md bundles for skill ids touched by a committed
   * refinement, from the effective merged view, so dsh's filesystem skill
   * provider picks the generated skills up live. Write faults are collected
   * into the returned MaterializationResult; the already-persisted commit is
   * never failed (spec §7.5/§7.7).
   */
  private materializeSkills(agent: Agent, result: RefinementResult): MaterializationResult {
    const touched = touchedSkillIds(result.appliedEdits)
    if (touched.length === 0) {
      return { status: 'completed', written: [], unchanged: [], skipped: [], staleCandidates: [], errors: [] }
    }
    const effective = this.state(agent).entries.skill
    const activeSkills: typeof effective = {}
    for (const id of touched) {
      const entry = effective[id]
      if (entry !== undefined && entry.metadata?.lifecycleState !== 'archived') activeSkills[id] = entry
    }
    try {
      return reconcileSkillFiles(this.skillsDir, activeSkills, touched)
    } catch (error) {
      return {
        status: 'failed',
        written: [],
        unchanged: [],
        skipped: [],
        staleCandidates: [],
        errors: [{ code: 'materialize-failed', retryable: true, message: String(error) }],
      }
    }
  }

  /** Roll back a committed refinement by id from the merged history. */
  rollbackRefinement(
    agent: Agent,
    rollbackId: string,
    options: CommitOptions = {},
  ): RefinementResult & { materialization: MaterializationResult } {
    const global = options.global === true
    const history = global ? loadGlobalRefinementHistory(this.home) : this.history(agent)
    const target = history.find(result => result.id === rollbackId)
    if (!target) throw new Error(`no refinement found with id ${rollbackId}`)
    const plan = rollbackProposal(target)
    return this.applyRefinement(agent, { ...plan, id: `rollback_${rollbackId}` }, {
      ...options,
      rollbackOf: rollbackId,
    })
  }
}

/** Serialize a session's user/assistant text turns, tail-biased. */
export function serializeTrajectory(session: Session, maxChars: number): string {
  const lines: string[] = []
  for (const event of session.events) {
    let text = ''
    if (event.type === 'user/message') {
      text = textOf(event.data.content)
    } else if (event.type === 'assistant/message') {
      text = textOf(event.data.message.content)
    } else {
      continue
    }
    if (!text.trim()) continue
    lines.push(`[${event.type}] ${text}`)
  }
  const joined = lines.join('\n\n')
  if (joined.length <= maxChars) return joined
  const cut = joined.slice(-maxChars)
  return `… (truncated, showing the last ${maxChars} characters of ${joined.length})\n\n${cut}`
}

function textOf(blocks: ReadonlyArray<{ type: string; text?: unknown }>): string {
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}
