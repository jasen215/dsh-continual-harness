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
import { formatHarnessStateForPrompt } from './render.ts'
import { reconcileSkillFiles } from './skills.ts'
import {
  appendGlobalRefinement,
  defaultHarnessHome,
  getGlobalHarnessStateDir,
  getLocalHarnessStateDir,
  loadGlobalRefinementHistory,
  loadHarnessState,
  mergeHarnessStates,
  mergeRefinementHistory,
  saveHarnessState,
} from './storage.ts'
import type { HarnessState, RefinementProposal, RefinementResult } from './types.ts'

/** Default tail-biased trajectory window for planning. */
export const DEFAULT_TRAJECTORY_MAX_CHARS = 80_000

/** Options for a store commit. */
export interface CommitOptions {
  /** Commit to the cross-session global store instead of the session store. */
  global?: boolean
  /** When set, the commit is recorded as the rollback of this refinement id. */
  rollbackOf?: string
}

/** Persistent harness store owned by the plugin. */
export class HarnessStore {
  /** Harness home directory (defaults under the dsh home). */
  readonly home: string
  /** Skills directory where effective skill entries materialize as SKILL.md. */
  readonly skillsDir: string

  constructor(
    private readonly ctx: Context,
    options: { harnessRoot?: string; skillsDir?: string } = {},
  ) {
    this.home = options.harnessRoot ?? defaultHarnessHome()
    this.skillsDir = options.skillsDir ?? dshHomePath('skills')
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

  /** Compact overview for prompt injection. */
  render(agent: Agent): string {
    return formatHarnessStateForPrompt(this.state(agent))
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
      ...(options.rollbackOf === undefined ? {} : { rollbackOf: options.rollbackOf }),
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
      reconcileSkillFiles(this.skillsDir, this.state(agent).entries.skill, touched)
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
