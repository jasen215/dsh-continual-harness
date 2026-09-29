/**
 * The model-facing harness tools: `harness_refine` (plans small
 * evidence-backed edits through the agent's own model, applies them via the
 * store, or rolls back a prior refinement), `harness_wrapup` (mechanical
 * keep/promote/archive advice), and `harness_benchmark` (one explicit
 * action-dispatched tool for the validation layer: fixed cases, reference
 * snapshots, and same-round A/B runs). UI render intent is generic (JSON text
 * result).
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendReview } from './audit.ts'
import { executionSummary } from './coordinator.ts'
import type { RefineCoordinator, RefineExecutionResult } from './coordinator-types.ts'
import type { HarnessStore } from './store.ts'
import type { DiagnosticReport, MaterializationResult } from './types.ts'
import { suggestWrapup } from './wrapup.ts'

const DESCRIPTION = 'Refine the continual harness: persist small, evidence-backed prompt notes, memories, skill contracts, or subagent specs from the current trajectory, or roll back a prior refinement. Prefer this tool over any standalone skill-authoring skill whenever the user asks to turn what we just did into a reusable skill — e.g. "把xxx流程做成skill", "save our process as a skill", "create a skill from this workflow". The base system prompt is immutable; only this supplemental layer changes. Use after a repeated failure, a reusable tactic, a repeated delegation role, or a durable fact or preference. Pass instructions to focus the planner. Keep edits small and evidence-backed.'

/** Tool-facing options resolved by the plugin. */
export interface ToolOptions {
  /** Store the tool targets when the call omits `global`. */
  defaultGlobal: boolean
}

/** The top-level materialization output shape (snake_case keys). */
const MATERIALIZATION_OUTPUT_PROPERTIES = {
  status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
  written: { type: 'array', items: { type: 'string' } },
  unchanged: { type: 'array', items: { type: 'string' } },
  skipped: { type: 'array', items: { type: 'string' } },
  removed: { type: 'array', items: { type: 'string' } },
  errors: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        code: { type: 'string' },
        retryable: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
} as const

/** The post-apply diagnostics summary (spec §5): status, findings, provider errors. */
const DIAGNOSTICS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'partial', 'disabled'] },
    structural: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill_id: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    security: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill_id: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          evidence: { type: 'string' },
        },
      },
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
} as const

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
          files: { type: 'object', additionalProperties: true },
        },
      },
    },
    materialization: {
      type: 'object',
      additionalProperties: false,
      properties: MATERIALIZATION_OUTPUT_PROPERTIES,
    },
    diagnostics: DIAGNOSTICS_OUTPUT_SCHEMA,
  },
} as const

const WRAPUP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['prompt', 'memory', 'skill', 'subagent'] },
          fate: { type: 'string', required: true, enum: ['keep', 'promote', 'archive'] },
          reason: { type: 'string', required: true },
        },
      },
    },
    promoted: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        applied: { type: 'boolean', required: true },
        error: { type: 'string' },
      },
    },
  },
} as const

/** Register the `harness_wrapup` tool: mechanical keep/promote/archive advice. */
export function registerHarnessWrapup(ctx: Context, store: HarnessStore): void {
  ctx.tools.register(defineTool({
    name: 'harness_wrapup',
    description: 'Review session-local harness entries and suggest keep/promote/archive. Optionally promote one local entry to the global store by copy (local stays unchanged).',
    parameters: {
      promote: {
        type: 'string',
        description: 'Local entry id to promote to the global store by copy.',
      },
    },
    output: {
      schema: WRAPUP_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('harness_wrapup requires a live agent')
      const sessionId = String(agent.session.id)
      const local = store.localState(agent)
      const global = store.globalState()
      const suggestions = suggestWrapup(local, global, key => store.usageStatsFor(key), sessionId)
      try {
        if (typeof args.promote === 'string' && args.promote !== '') {
          const out = store.promoteEntry(agent, args.promote)
          return { suggestions, promoted: { id: args.promote, applied: out.applied, ...(out.error === undefined ? {} : { error: out.error }) } }
        }
        return { suggestions }
      } catch (error) {
        try {
          appendReview(store.home, {
            timestamp: new Date().toISOString(),
            sessionId,
            trigger: 'manual',
            turnsSinceLastReview: 0,
            outcome: 'failed',
            rationale: `harness_wrapup failed: ${String(error)}`,
          })
        } catch {
          // review append failure must not mask the original error
        }
        throw error
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Wrap up harness session', kind: 'other' as const }),
  }))
}

/** Register the `harness_refine` tool as a pure adapter over the coordinator. */
export function registerHarnessTool(ctx: Context, coordinator: RefineCoordinator, options: ToolOptions): void {
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
      const request = args.rollback_id
        ? { mode: 'rollback' as const, source: 'tool' as const, scope: global ? 'global' as const : 'local' as const, rollbackId: args.rollback_id, agent, signal: exec.signal }
        : { mode: 'plan' as const, source: 'tool' as const, scope: global ? 'global' as const : 'local' as const, agent, ...(args.instructions === undefined ? {} : { instructions: args.instructions }), signal: exec.signal }
      const execution = await coordinator.execute(request)
      return summarizeExecution(execution, global ? 'global' : 'local')
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Refine continual harness', kind: 'other' as const }),
  }))
}

/** Project a MaterializationResult into the tool-output shape (snake_case keys). */
function toToolMaterialization(materialization: MaterializationResult) {
  return {
    status: materialization.status,
    written: materialization.written,
    unchanged: materialization.unchanged,
    skipped: materialization.skipped,
    removed: materialization.removed,
    errors: materialization.errors,
  }
}

/**
 * Project a DiagnosticReport into the tool-output shape: snake_case issue
 * keys, optional severity kept only when present. Provider errors pass
 * through unchanged so a failed scan is never hidden. Materialization is not
 * part of the diagnostics report — it is projected once at the top level by
 * `summarizeExecution`.
 */
function toToolDiagnostics(diagnostics: DiagnosticReport) {
  return {
    status: diagnostics.status,
    structural: diagnostics.structural.map(issue => ({
      skill_id: issue.skillId,
      code: issue.code,
      message: issue.message,
    })),
    security: diagnostics.security.map(issue => ({
      skill_id: issue.skillId,
      code: issue.code,
      message: issue.message,
      ...(issue.severity === undefined ? {} : { severity: issue.severity }),
      ...(issue.file === undefined ? {} : { file: issue.file }),
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.evidence === undefined ? {} : { evidence: issue.evidence }),
    })),
    errors: diagnostics.errors,
  }
}

/**
 * Project a coordinator execution onto the tool's snake_case output schema.
 * Counts come only from the coordinator result; edits are projected without
 * recounting; `refinement_id` is `'none'` when nothing committed.
 */
function summarizeExecution(execution: RefineExecutionResult, scope: 'local' | 'global') {
  return {
    refinement_id: execution.refinement?.id ?? 'none',
    scope: execution.refinement?.scope ?? scope,
    summary: executionSummary(execution),
    applied: execution.appliedCount,
    failed: execution.rejectedCount,
    edits: (execution.refinement?.appliedEdits ?? []).map(edit => ({
      action: edit.action,
      kind: edit.kind,
      id: edit.id,
      applied: edit.applied,
      ...(edit.error === undefined ? {} : { error: edit.error }),
      ...(edit.reason === undefined ? {} : { reason: edit.reason }),
      ...(edit.blastRadius === undefined ? {} : { blastRadius: edit.blastRadius }),
    })),
    ...(execution.materialization === undefined ? {} : { materialization: toToolMaterialization(execution.materialization) }),
    ...(execution.diagnostics === undefined ? {} : { diagnostics: toToolDiagnostics(execution.diagnostics) }),
  }
}

