import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Complete } from './planner.ts'
import type { HarnessStore } from './store.ts'
import type {
  AutoRefineReason,
  HarnessScope,
  HarnessState,
  MaterializationResult,
  RefinementResult,
} from './types.ts'

type DiagnosticReport = Record<string, unknown>
type PostApplyDiagnostics = { run(...args: never[]): Promise<DiagnosticReport> }

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
  requireGlobalApprovalForTool?: boolean
  plannerContext?: (agent: Agent, scope: HarnessScope) => {
    baseline: HarnessState
    stateOverview: string
    historyText: string
    trajectoryText: string
  }
  diagnostics?: PostApplyDiagnostics
}

function validateRequest(request: RefineRequest): string | undefined {
  if (!request || typeof request !== 'object' || !request.agent) return 'agent is required'
  if (request.mode === 'plan') {
    if (request.source === 'automatic') {
      if (request.scope !== 'local') return 'automatic refinement must target local scope'
      if (!request.automaticContext) return 'automaticContext is required for automatic refinement'
    } else if (request.source !== 'tool' && request.source !== 'command') {
      return 'invalid plan source'
    }
    return undefined
  }
  if (request.mode === 'rollback') {
    if ((request.source !== 'tool' && request.source !== 'command') || typeof request.rollbackId !== 'string' || request.rollbackId.trim() === '') {
      return 'rollbackId and an explicit tool/command source are required'
    }
    return undefined
  }
  return 'invalid request mode'
}

function emptyResult(approval: RefineExecutionResult['approval'] = 'not-required'): RefineExecutionResult {
  return { commitStatus: 'not-committed', approval, appliedCount: 0, rejectedCount: 0 }
}

export function createRefineCoordinator(_options: RefineCoordinatorOptions): RefineCoordinator {
  return {
    async execute(request) {
      const validationError = validateRequest(request)
      if (validationError) {
        return {
          ...emptyResult(),
          failedAt: 'validation',
          error: { code: 'invalid-request', message: validationError },
        }
      }

      // Planning and execution are introduced by later coordinator phases.
      return emptyResult()
    },
  }
}

