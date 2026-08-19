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
import type { Session } from '@deepseek-ai/dsh-session'
import { HARNESS_REFINEMENT_EVENT } from './domain.ts'
import { applyRefinementProposal, rollbackProposal } from './refine.ts'
import { buildQueryFromSession, DEFAULT_ENTRIES_PER_KIND, formatHarnessStateForPromptStructured } from './render.ts'
import { reconcileSkillFiles } from './skills.ts'
import {
  appendGlobalRefinement,
  appendUsageEvent,
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
import type { HarnessState, RefinementKind, RefinementProposal, RefinementResult, SkillEntry } from './types.ts'

/** Default tail-biased trajectory window for planning. */
export const DEFAULT_TRAJECTORY_MAX_CHARS = 80_000

/** Options for a store commit. */
export interface CommitOptions {
  /** Commit to the cross-session global store instead of the session store. */
  global?: boolean
  /** When set, the commit is recorded as the rollback of this refinement id. */
  rollbackOf?: string
  /** Marks the commit as riding the automatic path (gate), enabling protected-layer checks. */
  automatic?: boolean
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
      maxInjectedEntriesPerKind?: number
    } = {},
  ) {
    this.home = options.harnessRoot ?? defaultHarnessHome()
    this.skillsDir = options.skillsDir ?? dshHomePath('skills')
    this.maxEntryGrowth = options.maxEntryGrowth
    this.protectedKinds = options.protectedKinds
    this.maxInjectedEntriesPerKind = options.maxInjectedEntriesPerKind ?? DEFAULT_ENTRIES_PER_KIND
  }

  /** The session-local state for an agent. */
  localState(agent: Agent): HarnessState {
    return loadHarnessState(getLocalHarnessStateDir(this.home, String(agent.session.id)))
  }

  /** The cross-session global state. */
  globalState(): HarnessState {
    return loadHarnessState(getGlobalHarnessStateDir(this.home))
  }

  /** The merged view the model sees: local shadows same-id global entries. */
  state(agent: Agent): HarnessState {
    return mergeHarnessStates(this.globalState(), this.localState(agent))
  }

  /** Merged refinement history: session events first, then global history. */
  history(agent: Agent): RefinementResult[] {
    const local = agent.session.events
      .filter(event => event.type === HARNESS_REFINEMENT_EVENT)
      .map(event => event.data)
    return mergeRefinementHistory(local, loadGlobalRefinementHistory(this.home))
  }

  /** Structured overview + injected keys for prompt injection. */
  render(agent: Agent): { overview: string; injectedKeys: string[] } {
    const state = this.state(agent)
    const local = this.localState(agent)
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

  /** Record one injection per key: append the event and update memory; never blocks injection. */
  recordInjections(agent: Agent, injectedKeys: string[]): void {
    void agent
    if (injectedKeys.length === 0) return
    const now = new Date().toISOString()
    const stats = this.usageStats()
    for (const key of injectedKeys) {
      try {
        appendUsageEvent(this.home, { key, at: now })
      } catch (error) {
        this.ctx.logger('harness').warn(`usage append failed: ${String(error)}`)
      }
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
   */
  applyRefinement(agent: Agent, plan: RefinementProposal, options: CommitOptions = {}): RefinementResult {
    const global = options.global === true
    const baseline = global ? this.globalState() : this.localState(agent)
    const { result, state } = applyRefinementProposal(baseline, plan, {
      id: plan.id,
      scope: global ? 'global' : 'local',
      baselineState: baseline,
      ...(this.maxEntryGrowth === undefined ? {} : { maxEntryGrowth: this.maxEntryGrowth }),
      ...(this.protectedKinds === undefined ? {} : { protectedKinds: this.protectedKinds }),
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
    agent.session.append(HARNESS_REFINEMENT_EVENT, result)
    this.materializeSkills(agent, result)
    agentEvents(this.ctx, agent).emit('harness/refined', { result })
    return result
  }

  /** Promote a local entry to global by copy: local stays unchanged; a same-id
   * global is a deterministic conflict. Not a cross-store transaction. */
  promoteEntry(agent: Agent, id: string): { applied: boolean; error?: string } {
    const local = this.localState(agent)
    const global = this.globalState()
    const hit = (Object.keys(local.entries) as RefinementKind[])
      .map(kind => ({ kind, entry: local.entries[kind][id] }))
      .find(candidate => candidate.entry !== undefined)
    if (hit === undefined) return { applied: false, error: `local entry not found: ${id}` }
    if (global.entries[hit.kind][id] !== undefined) return { applied: false, error: 'global id conflict' }
    const entry = hit.entry!
    this.applyRefinement(agent, {
      id: `promote_${Date.now()}`,
      summary: `Promote local ${hit.kind}:${id} to global`,
      edits: [{
        action: 'create', kind: hit.kind, id,
        content: entry.content,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(hit.kind === 'skill' && (entry as SkillEntry).description === undefined ? {} : { description: (entry as SkillEntry).description }),
        ...(hit.kind === 'skill' && (entry as SkillEntry).reference === undefined ? {} : { reference: (entry as SkillEntry).reference }),
        ...(hit.kind === 'skill' && (entry as SkillEntry).arguments === undefined ? {} : { arguments: (entry as SkillEntry).arguments }),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
        reason: 'promote from session wrap-up',
      }],
    }, { global: true })
    return { applied: true }
  }

  /**
   * Materialize the SKILL.md bundles for skill ids touched by a committed
   * refinement, from the effective merged view, so dsh's filesystem skill
   * provider picks the generated skills up live. A materialization failure
   * logs and never fails the already-persisted commit.
   */
  private materializeSkills(agent: Agent, result: RefinementResult): void {
    const touched = result.appliedEdits
      .filter(edit => edit.applied && edit.kind === 'skill')
      .map(edit => edit.id)
    if (touched.length === 0) return
    try {
      const effective = this.state(agent).entries.skill
      const activeSkills: typeof effective = {}
      for (const [id, entry] of Object.entries(effective)) {
        if (entry.metadata?.lifecycleState !== 'archived') activeSkills[id] = entry
      }
      reconcileSkillFiles(this.skillsDir, activeSkills, touched)
    } catch (error) {
      this.ctx.logger('harness').warn(`skill materialization failed: ${String(error)}`)
    }
  }

  /** Roll back a committed refinement by id from the merged history. */
  rollbackRefinement(agent: Agent, rollbackId: string, options: CommitOptions = {}): RefinementResult {
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
