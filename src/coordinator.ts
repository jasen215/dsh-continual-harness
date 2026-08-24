import type { Agent } from '@deepseek-ai/dsh-agent'
import { planRefinement, scopeInstruction } from './planner.ts'
import type { Complete } from './planner.ts'
import { historyForPrompt, overviewForPrompt } from './render.ts'
import { mergeHarnessStates } from './storage.ts'
import type { HarnessStore } from './store.ts'
import type {
  AutoRefineReason,
  HarnessScope,
  HarnessState,
  MaterializationResult,
  RefinementResult,
} from './types.ts'

/** Optional post-apply diagnostics contract, supplied by the diagnostics phase. */
export interface PostApplyDiagnostics {
  run(...args: never[]): Promise<DiagnosticReport>
}

/** Optional diagnostics report contract, supplied by the diagnostics phase. */
export interface DiagnosticReport {
  [key: string]: unknown
}

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
  requireGlobalApproval?: (agent: Agent, signal: AbortSignal | undefined, summary: string) => Promise<void>
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
    if ((request.source !== 'tool' && request.source !== 'command') || request.rollbackId.trim() === '') {
      return 'rollbackId and an explicit tool/command source are required'
    }
    return undefined
  }
  return 'invalid request mode'
}

function emptyResult(approval: RefineExecutionResult['approval'] = 'not-required'): RefineExecutionResult {
  return { commitStatus: 'not-committed', approval, appliedCount: 0, rejectedCount: 0 }
}

export function createRefineCoordinator(options: RefineCoordinatorOptions): RefineCoordinator {
  const approval = options.requireGlobalApproval ?? (async () => {
    throw new Error('global approval is unavailable')
  })

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

      if (request.mode !== 'plan') return emptyResult()
      const context = options.plannerContext?.(request.agent, request.scope) ?? (() => {
        const local = options.store.localState(request.agent)
        const global = options.store.globalState()
        const baseline = mergeHarnessStates(global, local)
        return {
          baseline,
          stateOverview: overviewForPrompt(baseline),
          historyText: historyForPrompt(options.store.history(request.agent)),
          trajectoryText: options.store.trajectory(request.agent),
        }
      })()

      try {
        const instructions = request.source === 'automatic'
          ? `${request.instructions ? `${request.instructions}\n\n` : ''}Trigger: ${request.automaticContext.reason}. Gate rationale: ${request.automaticContext.reviewRationale}`
          : request.instructions
        const proposal = await planRefinement({
          stateOverview: context.stateOverview,
          historyText: context.historyText,
          trajectoryText: context.trajectoryText,
          scopeInstruction: scopeInstruction(request.scope === 'global'),
          ...(instructions === undefined ? {} : { instructions }),
        }, options.completeFor(request.agent), request.signal)
        if (proposal.edits.length === 0) return emptyResult()
      } catch (error) {
        return { ...emptyResult(), failedAt: 'planning', error: { code: 'planning-failed', message: String(error) } }
      }
          void approval
      return emptyResult()
    },
  }
}

