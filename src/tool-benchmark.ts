/**
 * The `harness_benchmark` tool: one explicit action-dispatched tool for the
 * validation layer — fixed cases, reference snapshots, and same-round A/B runs.
 * Split out of `tool.ts` (2026-09-29) so each file owns one tool surface.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  actionAddCase,
  actionCaptureReference,
  actionFreeze,
  actionNew,
  actionRun,
  actionStatus,
  benchmarkError,
} from './benchmark-actions.ts'
import type { HarnessStore } from './store.ts'

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
