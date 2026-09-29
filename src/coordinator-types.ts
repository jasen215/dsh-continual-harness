/**
 * Contract types for the refine coordinator: requests, the execution result and
 * phase/error vocabulary, the coordinator interface and its options.
 * Split out of `coordinator.ts` (2026-09-29): that module keeps the pipeline
 * implementation; this one owns the shared vocabulary.
 * @module dsh-continual-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Complete } from './planner.ts'
import type { HostRequestRegistry } from './request-snapshot.ts'
import type { PlannerPrefixCacheMode } from './cache-detect.ts'
import type { HarnessStore } from './store.ts'
import type { DiagnosticRunner } from './diagnostics.ts'
import type {
  AutoRefineReason,
  DiagnosticReport,
  HarnessScope,
  MaterializationResult,
  RefinementResult,
} from './types.ts'

export type PlanRequest = {
  mode: 'plan'
  agent: Agent
  scope: HarnessScope
  source: 'tool' | 'command'
  instructions?: string
  signal?: AbortSignal
}

export type AutomaticPlanRequest = {
  mode: 'plan'
  agent: Agent
  scope: 'local'
  source: 'automatic'
  instructions?: string
  automaticContext: { reason: AutoRefineReason; reviewRationale: string }
  signal?: AbortSignal
}

export type RollbackRequest = {
  mode: 'rollback'
  agent: Agent
  scope: HarnessScope
  source: 'tool' | 'command'
  rollbackId: string
  signal?: AbortSignal
}

export type RefineRequest = PlanRequest | AutomaticPlanRequest | RollbackRequest

export type CommitStatus = 'not-committed' | 'committed' | 'committed-with-rejected-edits'
export type ExecutionPhase = 'validation' | 'planning' | 'approval' | 'commit' | 'materialization' | 'diagnostics'
export type RefineErrorCode =
  | 'invalid-request'
  | 'planning-failed'
  | 'invalid-proposal'
  | 'approval-unavailable'
  | 'approval-rejected'
  | 'rollback-target-not-found'
  | 'rollback-scope-mismatch'
  | 'rollback-already-rolled-back'
  | 'aborted'
  | 'commit-failed'
  | 'materialization-failed'
  | 'diagnostics-failed'
  | 'unexpected-error'

export interface RefineExecutionResult {
  commitStatus: CommitStatus
  approval: 'not-required' | 'approved' | 'rejected'
  appliedCount: number
  rejectedCount: number
  refinement?: RefinementResult
  materialization?: MaterializationResult
  diagnostics?: DiagnosticReport
  failedAt?: ExecutionPhase
  error?: { code: RefineErrorCode; message: string }
}

export interface RefineCoordinator {
  execute(request: RefineRequest): Promise<RefineExecutionResult>
}

export interface RefineCoordinatorOptions {
  store: HarnessStore
  completeFor: (agent: Agent) => Complete
  maxTrajectoryChars?: number
  requireGlobalApproval?: (agent: Agent, signal: AbortSignal | undefined, summary: string) => Promise<void>
  requireGlobalApprovalForTool?: boolean
  diagnostics?: DiagnosticRunner
  /** Planner prefix-cache routing: auto-detect, force session prefix, or off. */
  plannerPrefixCache?: PlannerPrefixCacheMode
  /** Route B: fraction of the trajectory budget reserved for the verbatim signal layer. */
  trajectorySignalRatio?: number
  /** Optional plugin logger for route-selection observability. */
  logger?: { info(message: string): void; warn(message: string): void }
  /** Route A: per-session host-loop request snapshots captured from `llm/stream`. */
  hostRequests?: HostRequestRegistry
  /** Resolve the model context window (tokens) for the output budget; absent → no dynamic cap. */
  resolveContextWindow?: (provider: string, model: string, signal?: AbortSignal) => Promise<number | undefined>
  /** Shared char→token estimate ratio for A and B. */
  plannerTokenPerCharRatio?: number
  /** Tokens reserved inside the context window for safety. */
  plannerSafetyReserveTokens?: number
  /** Minimum output tokens a planner route must be able to produce. */
  minPlannerOutputTokens?: number
  /** Configured planner output cap; used as the budget's upper bound. */
  plannerMaxTokens?: number
}
