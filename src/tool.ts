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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendReview } from './audit.ts'
import {
  appendBenchmarkRun,
  buildSnapshot,
  captureReferenceSnapshot,
  createBenchmarkCase,
  freezeBenchmarkCase,
  loadBenchmark,
  loadReferenceSnapshot,
  saveBenchmarkCases,
  scopeLayerPair,
  validateCandidateDelta,
} from './benchmark.ts'
import type { BenchmarkCase, CellScore, ExecutorEvidence, HarnessSnapshot } from './benchmark.ts'
import { executionSummary } from './coordinator.ts'
import type { RefineCoordinator, RefineExecutionResult } from './coordinator.ts'
import { BENCHMARK_DIR_NAME, BENCHMARK_RUNS_FILE_NAME, BENCHMARK_SNAPSHOTS_DIR_NAME } from './domain.ts'
import { runCellEvaluation } from './evaluate.ts'
import type { CellEvaluation } from './evaluate.ts'
import { decideBenchmark } from './score.ts'
import { mergeHarnessStates } from './storage.ts'
import type { HarnessStore } from './store.ts'
import type { HarnessState, DiagnosticReport, MaterializationResult, RefinementResult } from './types.ts'
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

/** The `harness_benchmark` tool's options, resolved from BenchmarkConfig (§5). */
export interface BenchmarkToolOptions {
  /** Iterations per case per side when the run omits `runs`. */
  defaultRuns: number
  /** Upper bound for `runs`; a larger explicit value is refused. */
  maxRuns: number
  /** Report-only pass line; never gates acceptance (§4.5). */
  passThreshold: number
  /** How far the candidate may fall below the reference before regressing. */
  regressionTolerance: number
  /** Maximum failed candidate cells a run may still accept. */
  maxFailedCells: number
}

const BENCHMARK_DESCRIPTION = 'Run explicit continual-harness benchmark actions: `new` initializes the benchmark store, `add-case` adds a draft case, `freeze` freezes a draft, `capture-reference` persists a pre-refinement snapshot of the merged harness state (capture it BEFORE applying the refinement you want to validate), `status` lists cases/snapshots/recent runs, and `run` evaluates one named refinement A/B: the candidate is derived as the captured reference plus exactly that refinement delta, both sides run the same frozen cases/runs/provider/model, the decision is aggregated in code, and the record is appended to benchmark/runs.jsonl. A benchmark run never auto-triggers a refinement and a REJECTED decision never auto-rolls back. `reset` is intentionally not exposed to model callers.'

const BENCHMARK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    benchmark_dir: { type: 'string' },
    case: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        statement: { type: 'string', required: true },
        rubric: { type: 'string', required: true },
        capability: { type: 'string' },
        state: { type: 'string', required: true, enum: ['draft', 'frozen'] },
        created_at: { type: 'string', required: true },
        frozen_at: { type: 'string' },
      },
    },
    snapshot_id: { type: 'string' },
    state_hash: { type: 'string' },
    captured_at: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['draft', 'frozen'] },
        },
      },
    },
    snapshots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot_id: { type: 'string', required: true },
          refinement_id: { type: 'string' },
          captured_at: { type: 'string', required: true },
          state_hash: { type: 'string', required: true },
        },
      },
    },
    recent_runs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          run_id: { type: 'string', required: true },
          refinement_id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['ACCEPTED', 'REJECTED'] },
          reference_overall: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          candidate_overall: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          created_at: { type: 'string', required: true },
        },
      },
    },
    run_id: { type: 'string' },
    refinement_id: { type: 'string' },
    status: { type: 'string', enum: ['ACCEPTED', 'REJECTED'] },
    reference_overall: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    candidate_overall: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    regression_cases: { type: 'array', items: { type: 'string' } },
    failed_cells: { type: 'integer' },
    feedback: { type: 'array', items: { type: 'string' } },
    auto_rollback: { type: 'boolean' },
    runs: { type: 'integer' },
    cells: { type: 'integer' },
  },
} as const

/**
 * Register the single `harness_benchmark` action tool over the store. One tool
 * entry dispatches on `action`; `reset` is deliberately absent from the action
 * enum so it can never be model-called. Every action validates its own
 * arguments first and throws a structured `benchmark:<action>:<code>` error
 * before touching the store, so a malformed call never mutates state.
 */
export function registerBenchmarkTool(ctx: Context, store: HarnessStore, options: BenchmarkToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'harness_benchmark',
    description: BENCHMARK_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['new', 'add-case', 'freeze', 'capture-reference', 'status', 'run'],
        description: 'The benchmark operation to run.',
      },
      case_id: { type: 'string', description: 'add-case/freeze: the benchmark case id.' },
      title: { type: 'string', description: 'add-case: the case title.' },
      statement: { type: 'string', description: 'add-case: the task statement the executor completes.' },
      rubric: { type: 'string', description: 'add-case: the plaintext rubric the reviewer scores against.' },
      capability: { type: 'string', description: 'add-case: optional capability tag.' },
      snapshot_id: { type: 'string', description: 'capture-reference: snapshot id to persist.' },
      reference_snapshot_id: { type: 'string', description: 'run: reference snapshot id captured before the refinement.' },
      refinement_id: { type: 'string', description: 'run: the refinement id to validate.' },
      runs: { type: 'integer', description: 'run: iterations per case per side (defaults to config.defaultRuns, capped at config.maxRuns).' },
      provider: { type: 'string', description: 'run: executor/reviewer provider (defaults to the agent provider).' },
      model: { type: 'string', description: 'run: executor/reviewer model (defaults to the agent model).' },
    },
    output: {
      schema: BENCHMARK_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = args.action
      if (typeof action !== 'string') throw benchmarkError('unknown-action', 'action is required')
      switch (action) {
        case 'new':
          return actionNew(store)
        case 'add-case':
          return actionAddCase(store, args)
        case 'freeze':
          return actionFreeze(store, args)
        case 'capture-reference':
          return actionCaptureReference(store, args, exec)
        case 'status':
          return actionStatus(store)
        case 'run':
          return actionRun(ctx, store, args, exec, options)
        default:
          throw benchmarkError('unknown-action', `unknown action: ${action}`)
      }
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Run benchmark action', kind: 'other' as const }),
  }))
}

/** Initialize the benchmark store directory. */
function actionNew(store: HarnessStore): { action: string; ok: boolean; benchmark_dir: string } {
  mkdirSync(join(store.home, BENCHMARK_DIR_NAME), { recursive: true })
  return { action: 'new', ok: true, benchmark_dir: join(store.home, BENCHMARK_DIR_NAME) }
}

/** Add a draft case and persist the cases file atomically. */
function actionAddCase(store: HarnessStore, args: Record<string, unknown>): { action: string; ok: boolean; case: CaseOutput } {
  const caseId = stringArg(args.case_id)
  const title = stringArg(args.title)
  const statement = stringArg(args.statement)
  const rubric = stringArg(args.rubric)
  const capability = stringArg(args.capability)
  if (caseId === undefined || title === undefined || statement === undefined || rubric === undefined) {
    throw benchmarkError('add-case:missing-argument', 'add-case requires case_id, title, statement, and rubric')
  }
  const existing = loadBenchmark(store.home)
  if (existing.some(benchmarkCase => benchmarkCase.id === caseId)) {
    throw benchmarkError('add-case:duplicate-id', `benchmark case id already exists: ${caseId}`)
  }
  const draft = createBenchmarkCase({
    id: caseId,
    title,
    statement,
    rubric,
    ...(capability === undefined ? {} : { capability }),
  }, new Set(existing.map(benchmarkCase => benchmarkCase.id)))
  saveBenchmarkCases(store.home, [...existing, draft])
  return { action: 'add-case', ok: true, case: caseToOutput(draft) }
}

/** Freeze a draft case in place. */
function actionFreeze(store: HarnessStore, args: Record<string, unknown>): { action: string; ok: boolean; case: CaseOutput } {
  const caseId = stringArg(args.case_id)
  if (caseId === undefined) throw benchmarkError('freeze:missing-argument', 'freeze requires case_id')
  const existing = loadBenchmark(store.home)
  const index = existing.findIndex(benchmarkCase => benchmarkCase.id === caseId)
  if (index < 0) throw benchmarkError('freeze:not-found', `no benchmark case with id: ${caseId}`)
  const target = existing[index]!
  if (target.state !== 'draft') throw benchmarkError('freeze:not-draft', `benchmark case is not in draft state: ${caseId}`)
  const frozen = freezeBenchmarkCase(target)
  const next = [...existing]
  next[index] = frozen
  saveBenchmarkCases(store.home, next)
  return { action: 'freeze', ok: true, case: caseToOutput(frozen) }
}

/** The execution slice the benchmark actions need: the live agent and the abort signal. */
interface BenchmarkExecution {
  agent?: Agent
  signal?: AbortSignal
}

/** Capture the merged local/global state BEFORE a refinement is applied and persist it. */
function actionCaptureReference(
  store: HarnessStore,
  args: Record<string, unknown>,
  exec: BenchmarkExecution,
): { action: string; ok: boolean; snapshot_id: string; state_hash: string; captured_at: string } {
  const agent = exec.agent
  if (!agent) throw benchmarkError('capture-reference:no-agent', 'harness_benchmark capture-reference requires a live agent')
  const snapshotId = stringArg(args.snapshot_id)
  if (snapshotId === undefined) throw benchmarkError('capture-reference:missing-argument', 'capture-reference requires snapshot_id')
  const snapshot = store.captureSnapshot(agent, snapshotId)
  captureReferenceSnapshot(store.home, snapshot)
  return {
    action: 'capture-reference',
    ok: true,
    snapshot_id: snapshot.snapshotId,
    state_hash: snapshot.stateHash,
    captured_at: snapshot.capturedAt,
  }
}

/** List cases, persisted snapshots, and recent run records. */
function actionStatus(store: HarnessStore): {
  action: string
  ok: boolean
  cases: Array<{ id: string; title: string; state: 'draft' | 'frozen' }>
  snapshots: SnapshotSummary[]
  recent_runs: RunSummary[]
} {
  const cases = loadBenchmark(store.home)
  return {
    action: 'status',
    ok: true,
    cases: cases.map(benchmarkCase => ({ id: benchmarkCase.id, title: benchmarkCase.title, state: benchmarkCase.state })),
    snapshots: listSnapshots(store.home),
    recent_runs: listRecentRuns(store.home),
  }
}

/**
 * Run the A/B benchmark for one named refinement against a captured reference.
 * The candidate is derived from the reference state plus the refinement's
 * recorded applied edits (never from the possibly-drifted live store), and
 * `validateCandidateDelta` must prove the candidate is reference plus exactly
 * that refinement — otherwise the run refuses with a structured error before
 * any evaluation. Both sides evaluate the same frozen cases in stored order
 * with the same iterations/provider/model, the decision is code-aggregated via
 * `src/score.ts`, and the full record (cells with executor evidence + decision)
 * is appended to `benchmark/runs.jsonl`.
 */
async function actionRun(
  ctx: Context,
  store: HarnessStore,
  args: Record<string, unknown>,
  exec: BenchmarkExecution,
  options: BenchmarkToolOptions,
): Promise<{
  action: string
  ok: boolean
  run_id: string
  refinement_id: string
  status: 'ACCEPTED' | 'REJECTED'
  reference_overall: number | null
  candidate_overall: number | null
  regression_cases: string[]
  failed_cells: number
  feedback: string[]
  auto_rollback: boolean
  runs: number
  cells: number
}> {
  const agent = exec.agent
  if (!agent) throw benchmarkError('run:no-agent', 'harness_benchmark run requires a live agent')
  const referenceId = stringArg(args.reference_snapshot_id)
  if (referenceId === undefined) {
    throw benchmarkError('run:missing-argument', 'run requires reference_snapshot_id')
  }
  const refinementId = stringArg(args.refinement_id)
  if (refinementId === undefined) {
    throw benchmarkError('run:missing-argument', 'run requires refinement_id')
  }
  const runs = resolveRuns(args.runs, options)

  const frozenCases = loadBenchmark(store.home).filter(benchmarkCase => benchmarkCase.state === 'frozen')
  if (frozenCases.length === 0) {
    throw benchmarkError('run:no-frozen-cases', 'run requires at least one frozen benchmark case')
  }
  const reference = loadReferenceSnapshot(store.home, referenceId)
  if (reference === undefined) {
    throw benchmarkError('run:no-reference', `reference snapshot not found: ${referenceId}`)
  }
  const refinement = store.history(agent).find(result => result.id === refinementId)
  if (refinement === undefined) {
    throw benchmarkError('run:refinement-not-found', `no refinement with id ${refinementId} in the store history`)
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const candidate = deriveCandidateSnapshot(reference, refinement, `candidate-${runId}`)
  const delta = validateCandidateDelta(reference, candidate, refinementId)
  if (!delta.ok) {
    throw benchmarkError('run:candidate-delta', `candidate is not reference plus the single refinement ${refinementId}: ${delta.reason}`)
  }

  const provider = resolveModelOption(args.provider, agent.options.provider)
  const model = resolveModelOption(args.model, agent.options.model)
  if (provider === undefined || model === undefined) {
    throw benchmarkError('run:model-options', 'run requires a provider and model: pass provider/model or configure the agent')
  }

  const evaluations: CellEvaluation[] = []
  const cellOptions = { ...(exec.signal === undefined ? {} : { signal: exec.signal }) }
  for (const benchmarkCase of frozenCases) {
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      evaluations.push(await runCellEvaluation(ctx, {
        runId,
        side: 'reference',
        iteration,
        benchmarkCase,
        snapshot: reference,
        provider,
        model,
      }, cellOptions))
      evaluations.push(await runCellEvaluation(ctx, {
        runId,
        side: 'candidate',
        iteration,
        benchmarkCase,
        snapshot: candidate,
        provider,
        model,
      }, cellOptions))
    }
  }

  const cells: Array<CellScore & { evidence: ExecutorEvidence | null }> = evaluations.map(cellFromEvaluation)
  const decision = decideBenchmark({
    runId,
    refinementId,
    cells,
    options: {
      passThreshold: options.passThreshold,
      regressionTolerance: options.regressionTolerance,
      maxFailedCells: options.maxFailedCells,
    },
  })
  appendBenchmarkRun(store.home, { runId, cells, decision, createdAt: decision.createdAt })

  return {
    action: 'run',
    ok: true,
    run_id: runId,
    refinement_id: refinementId,
    status: decision.status,
    reference_overall: decision.referenceOverall,
    candidate_overall: decision.candidateOverall,
    regression_cases: decision.regressionCases,
    failed_cells: decision.failedCells,
    feedback: decision.feedback,
    auto_rollback: decision.autoRollback,
    runs,
    cells: cells.length,
  }
}

/**
 * Derive the candidate snapshot: reference plus exactly the named
 * refinement's applied edits, with the refinement appended to the history. The
 * caller must then prove the delta with `validateCandidateDelta`. When the
 * reference carries `layers`, the edits are applied to the refinement's own
 * layer (by `scope`) and the merged state is re-derived, so a shadowed global
 * entry (`local:<id>` in the merged view) is never overwritten by a global
 * refinement; snapshots without layers (persisted before the layering change)
 * use the legacy single-layer path.
 */
function deriveCandidateSnapshot(reference: HarnessSnapshot, refinement: RefinementResult, snapshotId: string): HarnessSnapshot {
  if (reference.layers !== undefined) {
    const { scope, other } = scopeLayerPair(refinement.scope)
    const layer = structuredClone(reference.layers[scope])
    applyEditsToEntries(layer.entries, refinement)
    layer.refinements.push(structuredClone(refinement))
    // the untouched other layer is passed through; buildSnapshot clones it
    const layers = scope === 'global' ? { global: layer, local: reference.layers[other] } : { global: reference.layers[other], local: layer }
    return buildSnapshot(mergeHarnessStates(layers.global, layers.local), snapshotId, refinement.id, layers)
  }
  const state = structuredClone(reference.state)
  applyEditsToEntries(state.entries, refinement)
  state.refinements.push(structuredClone(refinement))
  return buildSnapshot(state, snapshotId, refinement.id)
}

/** Apply a refinement's applied edits to one entries map (shared by both derivation paths). */
function applyEditsToEntries(entries: HarnessState['entries'], refinement: RefinementResult): void {
  for (const edit of refinement.appliedEdits) {
    if (!edit.applied) continue
    // No else: a conclusion-only record carries no replayable content, and
    // history() always serves the full journal record, so this is unreachable.
    if (edit.action === 'delete') {
      delete entries[edit.kind][edit.id]
    } else if (edit.afterEntry !== undefined) {
      entries[edit.kind][edit.id] = structuredClone(edit.afterEntry)
    }
  }
}

/** Project a CellEvaluation (a `CellScore` plus evidence) onto the persisted shape. */
function cellFromEvaluation(evaluation: CellEvaluation): CellScore & { evidence: ExecutorEvidence | null } {
  const { evidence, ...score } = evaluation
  return { ...score, evidence }
}

/** Resolve the iterations count: explicit positive integer capped by maxRuns. */
function resolveRuns(runs: unknown, options: BenchmarkToolOptions): number {
  if (runs === undefined) return Math.min(Math.max(options.defaultRuns, 1), options.maxRuns)
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    throw benchmarkError('run:runs-invalid', 'runs must be a positive integer')
  }
  if (runs > options.maxRuns) {
    throw benchmarkError('run:runs-exceeds-max', `runs (${runs}) exceeds maxRuns (${options.maxRuns})`)
  }
  return runs
}

/** Resolve a provider/model option: explicit non-empty string, else the given fallback. */
function resolveModelOption(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  return value === undefined ? fallback : undefined
}

/** One status-listing entry for a persisted snapshot. */
interface SnapshotSummary {
  snapshot_id: string
  refinement_id?: string
  captured_at: string
  state_hash: string
}

/** One status-listing entry for a recent run record. */
interface RunSummary {
  run_id: string
  refinement_id: string
  status: 'ACCEPTED' | 'REJECTED'
  reference_overall: number | null
  candidate_overall: number | null
  created_at: string
}

/** List persisted snapshots (best effort per file). */
function listSnapshots(home: string): SnapshotSummary[] {
  const dir = join(home, BENCHMARK_DIR_NAME, BENCHMARK_SNAPSHOTS_DIR_NAME)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const snapshots: SnapshotSummary[] = []
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue
    try {
      const snapshot = loadReferenceSnapshot(home, file.slice(0, -'.json'.length))
      if (snapshot === undefined) continue
      snapshots.push({
        snapshot_id: snapshot.snapshotId,
        ...(snapshot.refinementId === undefined ? {} : { refinement_id: snapshot.refinementId }),
        captured_at: snapshot.capturedAt,
        state_hash: snapshot.stateHash,
      })
    } catch {
      // a broken snapshot file never hides the rest of the listing
    }
  }
  return snapshots
}

/** List the most recent run records (best effort per line). */
function listRecentRuns(home: string): RunSummary[] {
  const file = join(home, BENCHMARK_DIR_NAME, BENCHMARK_RUNS_FILE_NAME)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const runs: RunSummary[] = []
  for (const line of text.trim().split('\n').reverse()) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as {
        runId: string
        decision: { refinementId: string; status: 'ACCEPTED' | 'REJECTED'; referenceOverall: number | null; candidateOverall: number | null; createdAt: string }
      }
      runs.push({
        run_id: record.runId,
        refinement_id: record.decision.refinementId,
        status: record.decision.status,
        reference_overall: record.decision.referenceOverall,
        candidate_overall: record.decision.candidateOverall,
        created_at: record.decision.createdAt,
      })
    } catch {
      // a torn line never hides the rest of the listing
    }
    if (runs.length >= 10) break
  }
  return runs
}

/** The output projection of a case: snake_case keys with optional fields omitted. */
interface CaseOutput {
  id: string
  title: string
  statement: string
  rubric: string
  capability?: string
  state: 'draft' | 'frozen'
  created_at: string
  frozen_at?: string
}

function caseToOutput(benchmarkCase: BenchmarkCase): CaseOutput {
  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    statement: benchmarkCase.statement,
    rubric: benchmarkCase.rubric,
    ...(benchmarkCase.capability === undefined ? {} : { capability: benchmarkCase.capability }),
    state: benchmarkCase.state,
    created_at: benchmarkCase.createdAt,
    ...(benchmarkCase.frozenAt === undefined ? {} : { frozen_at: benchmarkCase.frozenAt }),
  }
}

/** A non-empty string argument, or undefined when absent or blank. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Structured tool error: `benchmark:<action>:<code>: <message>`. */
function benchmarkError(code: string, message: string): Error {
  return new Error(`benchmark:${code}: ${message}`)
}
