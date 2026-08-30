/**
 * The harness store: read/merge/apply/rollback over local and global state
 * files, trajectory serialization, and the commit path that persists each
 * refinement and emits the scoped `harness/refined` event. A plain class
 * owned by the plugin's `apply`; not a Cordis service.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildSnapshot } from './benchmark.ts'
import type { HarnessSnapshot } from './benchmark.ts'
import { applyRefinementProposal, entryToEditFields, rollbackProposal, touchedSkillIds } from './refine.ts'
import { buildQueryFromSession, DEFAULT_ENTRIES_PER_KIND, formatHarnessStateForPromptStructured } from './render.ts'
import { DEFAULT_SKILL_BUNDLE_LIMITS, defaultSkillFsOps, inspectSkillBundle, reconcileSkillFiles } from './skills.ts'
import type { SkillBundleLimits } from './skills.ts'
import {
  appendGlobalRefinement,
  appendLocalRefinement,
  appendUsageEvents,
  defaultHarnessHome,
  getGlobalHarnessStateDir,
  getLocalHarnessStateDir,
  loadGlobalRefinementHistory,
  loadHarnessState,
  loadSessionRefinementHistory,
  loadUsageEvents,
  mergeHarnessStates,
  mergeRefinementHistory,
  saveHarnessState,
} from './storage.ts'
import { aggregateUsage } from './usage.ts'
import type { HarnessState, MaterializationResult, RefinementKind, RefinementProposal, RefinementResult } from './types.ts'

/** Default tail-biased trajectory window for planning (spec §2.3: 12k). */
export const DEFAULT_TRAJECTORY_MAX_CHARS = 12_000

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

  /**
   * Merged refinement history: the session journal (full records, first for
   * dedupe-by-id fidelity), then the session state copy (conclusion-only),
   * then the cross-session history (full records).
   */
  history(agent: Agent): RefinementResult[] {
    const sessionKey = String(agent.session.id)
    const local = [
      ...loadSessionRefinementHistory(this.home, sessionKey),
      ...this.localState(agent).refinements,
    ]
    return mergeRefinementHistory(local, loadGlobalRefinementHistory(this.home))
  }

  /** fs-backed create-conflict gate: a create onto a non-harness-owned bundle is rejected (spec §7.4). */
  private createConflictError(id: string): string | undefined {
    const inspected = inspectSkillBundle(defaultSkillFsOps, this.skillsDir, id)
    if (inspected.state === 'missing' || (inspected.state === 'present' && inspected.harnessOwned)) return undefined
    return `skill directory "${id}" exists and is not harness-owned; pick another id`
  }

  /** Structured overview + injected keys + the merged state behind them, so one read serves both. */
  render(agent: Agent): { overview: string; injectedKeys: string[]; state: HarnessState } {
    const local = this.localState(agent)
    const state = mergeHarnessStates(this.globalState(), local)
    const rendered = formatHarnessStateForPromptStructured(state, buildQueryFromSession(agent.session), {
      maxPerKind: this.maxInjectedEntriesPerKind,
      sessionId: String(agent.session.id),
      isLocal: (kind, id) => local.entries[kind][id] !== undefined,
    })
    return { ...rendered, state }
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
  trajectory(agent: Agent, maxChars: number = DEFAULT_TRAJECTORY_MAX_CHARS, signalRatio = 0.5): string {
    return serializeTrajectory(agent.session, maxChars, signalRatio)
  }

  /**
   * Commit a planned refinement: apply to the target store with baseline
   * conflict detection, persist, append the global history when global, and
   * emit the scoped `harness/refined` event.
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
      appendLocalRefinement(this.home, String(agent.session.id), result)
    }
    // No informational session event is appended for the commit: an
    // out-of-repo append would make the whole log refuse a cold read (see
    // `registerSessionEventType` in domain.ts for the vocabulary constraint
    // and why the legacy type stays registered). Durable facts already ride
    // known vocabulary (`tool/result` for tool commits, `command/done` for
    // `/refine`) plus the on-disk store. The scoped `harness/refined` emit
    // below still fires, so live observers and the invariant companion are
    // unaffected.
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
      return { status: 'completed', written: [], unchanged: [], skipped: [], removed: [], errors: [] }
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
        removed: [],
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

// messageText() is defined in Task 4 Step 4 (exported, shared with the
// coordinator's prefix truncation). Reuse it here — do not define a second
// textOf.

function digestOf(role: 'user' | 'assistant', blocks: ReadonlyArray<{ type: string; text?: unknown; name?: unknown }>): string {
  const text = messageText({ role, content: blocks } as Message)
  const toolNames = blocks
    .filter(block => block.type === 'tool-call' && typeof block.name === 'string')
    .map(block => block.name as string)
  const limit = role === 'user' ? 300 : 200
  const cut = text.length > limit ? `${text.slice(0, limit)}…` : text
  const tools = toolNames.length > 0 ? ` [tools: ${[...new Set(toolNames)].join(', ')}]` : ''
  return `[${role}] ${cut}${tools}`
}

/**
 * Two-layer tail-biased trajectory (spec §2.3): the signal layer keeps the
 * most recent messages verbatim up to `maxChars * signalRatio`; the digest
 * layer truncates everything older (user 300 / assistant 200 chars + tool
 * names). Input is the surface-ordered derived history — the same messages
 * the host loop already sent — so no event-structure re-parsing is needed.
 *
 * Compatibility: the signal layer labels lines `[user/message]` /
 * `[assistant/message]` exactly like the pre-refactor serializer, so the
 * existing store.spec assertions keep passing; the digest layer uses the
 * shorter `[user]` / `[assistant]` tags.
 */
export function serializeTrajectory(session: Session, maxChars: number, signalRatio = 0.5): string {
  if (maxChars <= 0) return ''
  const messages = session.deriveMessages()
  const signalBudget = Math.floor(maxChars * Math.min(1, Math.max(0, signalRatio)))
  const digestBudget = maxChars - signalBudget

  // Signal layer: verbatim tail, newest last, labelled with the legacy
  // event-style tags so existing tests and downstream consumers are stable.
  // tool/result messages (role 'user', first block 'tool-result') carry no
  // planner-relevant text — skip them entirely instead of calling messageText.
  // A message longer than the digest's per-role cap is digested instead of
  // kept verbatim: it would burn the signal budget without adding readable
  // context, and the digest already carries its truncated form.
  const signalLines: string[] = []
  let signalUsed = 0
  let split = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.content[0]?.type === 'tool-result') continue
    const text = messageText(message)
    if (!text.trim()) continue
    const cap = message.role === 'assistant' ? 200 : 300
    if (text.length > cap) break
    const tag = message.role === 'assistant' ? 'assistant/message' : 'user/message'
    const line = `[${tag}] ${text}`
    if (signalUsed + line.length > signalBudget) break
    signalLines.unshift(line)
    signalUsed += line.length
    split = i
  }
  // tool/result messages (role 'user', first block 'tool-result') carry no
  // planner text — messageText yields '' — so their `[user] ` digest lines
  // are dropped rather than kept as empty noise.
  const digestLines = messages.slice(0, split)
    .map(m => digestOf(m.role as 'user' | 'assistant', m.content))
    .filter(line => line.trim() !== '')
  let digest = digestLines.join('\n')
  if (digest.length > digestBudget) {
    // Reserve the cut marker (and its newline separator) before slicing the
    // body, so the digest layer stays within digestBudget and the spec's
    // "total ≤ maxChars" guarantee holds even when the signal layer uses its
    // full share (spec §2.3). `markerFor(digestBudget)` has the longest digit
    // count the body can take, so one refinement pass bounds the marker.
    const total = digest.length
    const markerFor = (body: number) => `… (truncated, showing the first ${body} characters of ${total})`
    const body = Math.max(0, digestBudget - markerFor(digestBudget).length - 2)
    digest = body > 0
      ? `${markerFor(body)}\n\n${digest.slice(0, body)}`
      : markerFor(0).length <= digestBudget ? markerFor(0) : ''
  }
  const signal = signalLines.join('\n\n')
  if (!signal) return digest
  return digest ? `${digest}\n\n${signal}` : signal
}

/** Serialized text of one derived message (text blocks only; skips tool-result). */
export function messageText(message: Message): string {
  if (message.content[0]?.type === 'tool-result') return ''
  return message.content
    // explicit predicate: the `typeof` guard survives the merge-extensible
    // ContentBlock union (a plugin-added 'text' block may carry non-string text)
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Tail-biased prefix truncation: keep the most recent messages whose
 * serialized text fits under `maxChars`. Walk from the end summing
 * `messageText` lengths; drop older messages until the running total fits.
 * The newest message is always kept even when it alone exceeds the cap.
 */
export function truncatePrefix(messages: readonly Message[], maxChars: number): Message[] {
  const prefix: Message[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messageText(messages[i]!)
    if (prefix.length > 0 && used + text.length > maxChars) break
    prefix.unshift(messages[i]!)
    used += text.length
  }
  return prefix
}

/**
 * Route A prefix sanitization: strip assistant narration (text/reasoning
 * blocks) from derived session messages so the planning model does not treat
 * the call as a conversation continuation and echo its own recent tool-call
 * narration (see Ruling 11). User text, tool-call and tool-result blocks are
 * preserved — the prefix keeps its context and cache value.
 */
export function sanitizePrefix(messages: readonly Message[]): Message[] {
  return messages
    .map(message => {
      const content = message.content.flatMap(block => {
        if (block.type === 'reasoning') return []
        if (message.role === 'assistant' && block.type === 'text') return []
        return [block]
      })
      return content.length === message.content.length
        ? message
        : { ...message, content }
    })
    .filter(message => message.content.length > 0)
}
