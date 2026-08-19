/**
 * The model-facing `harness_refine` tool: plans small evidence-backed edits
 * through the agent's own model, applies them via the store, or rolls back a
 * prior refinement. UI render intent is generic (JSON text result).
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireGlobalApproval } from './approval.ts'
import { completeViaAgent } from './complete.ts'
import { planRefinement, scopeInstruction } from './planner.ts'
import { overviewForPrompt, historyForPrompt } from './render.ts'
import type { HarnessStore } from './store.ts'
import type { BlastRadius, RefinementAction, RefinementKind } from './types.ts'

const DESCRIPTION = 'Refine the continual harness: persist small, evidence-backed prompt notes, memories, skill contracts, or subagent specs from the current trajectory, or roll back a prior refinement. The base system prompt is immutable; only this supplemental layer changes. Use after a repeated failure, a reusable tactic, a repeated delegation role, or a durable fact or preference. Pass instructions to focus the planner. Keep edits small and evidence-backed.'

/** Tool-facing options resolved by the plugin. */
export interface ToolOptions {
  /** Store the tool targets when the call omits `global`. */
  defaultGlobal: boolean
  /** Trajectory window fed to the planner. */
  maxTrajectoryChars: number
  /** Output budget for the planning call. */
  plannerMaxTokens: number
  /** Require explicit human approval before a global write commits. */
  requireGlobalApproval: boolean
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refinement_id: { type: 'string', required: true },
    scope: { type: 'string', required: true, enum: ['local', 'global'] },
    summary: { type: 'string', required: true },
    applied: { type: 'integer', required: true },
    failed: { type: 'integer', required: true },
    edits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'update', 'delete'] },
          kind: { type: 'string', required: true, enum: ['prompt', 'memory', 'skill', 'subagent'] },
          id: { type: 'string', required: true },
          applied: { type: 'boolean', required: true },
          error: { type: 'string' },
          reason: { type: 'string' },
          blastRadius: { type: 'string', enum: ['general', 'project', 'session'] },
        },
      },
    },
  },
} as const

/** Register the `harness_refine` tool over the store. */
export function registerHarnessTool(ctx: Context, store: HarnessStore, options: ToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'harness_refine',
    description: DESCRIPTION,
    parameters: {
      instructions: {
        type: 'string',
        description: 'Optional focus instructions for the planner, e.g. "save the error-handling pattern as a global skill".',
      },
      global: {
        type: 'boolean',
        description: 'Target the cross-session global store instead of the session-local one. Omit for the deployment default.',
      },
      rollback_id: {
        type: 'string',
        description: 'Roll back the refinement with this id instead of planning new edits.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('harness_refine requires a live agent')
      const global = args.global ?? options.defaultGlobal
      if (args.rollback_id) {
        const result = store.rollbackRefinement(agent, args.rollback_id, { global })
        return summarize(result.id, result.scope, result.summary, result.appliedEdits)
      }
      const plan = await planRefinement({
        stateOverview: overviewForPrompt(store.state(agent)),
        historyText: historyForPrompt(store.history(agent)),
        trajectoryText: store.trajectory(agent, options.maxTrajectoryChars),
        scopeInstruction: scopeInstruction(global),
        ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
      }, completeViaAgent(ctx, agent, options.plannerMaxTokens), exec.signal)
      // The conservative approval gate rides the plan path only: the user sees
      // the planner's own summary before any global write commits. Rollback
      // restores recorded state and never requires approval.
      if (options.requireGlobalApproval && global) {
        try {
          await requireGlobalApproval(ctx, agent, exec.signal,
            `目标：global store；planner 计划：${plan.summary}`)
        } catch (error) {
          return { refinement_id: 'none', scope: 'global' as const, summary: `global 写入未获批：${String(error)}`, applied: 0, failed: 0, edits: [] }
        }
      }
      const result = store.applyRefinement(agent, plan, { global })
      return summarize(result.id, result.scope, result.summary, result.appliedEdits)
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Refine continual harness', kind: 'other' as const }),
  }))
}

function summarize(
  id: string,
  scope: 'local' | 'global',
  summary: string,
  edits: ReadonlyArray<{
    action: RefinementAction
    kind: RefinementKind
    id: string
    applied: boolean
    error?: string
    reason?: string
    blastRadius?: BlastRadius
  }>,
) {
  return {
    refinement_id: id,
    scope,
    summary,
    applied: edits.filter(edit => edit.applied).length,
    failed: edits.filter(edit => !edit.applied).length,
    edits: edits.map(edit => ({
      action: edit.action,
      kind: edit.kind,
      id: edit.id,
      applied: edit.applied,
      ...(edit.error === undefined ? {} : { error: edit.error }),
      ...(edit.reason === undefined ? {} : { reason: edit.reason }),
      ...(edit.blastRadius === undefined ? {} : { blastRadius: edit.blastRadius }),
    })),
  }
}
