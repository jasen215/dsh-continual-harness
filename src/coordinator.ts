import type { Agent } from '@deepseek-ai/dsh-agent'
import { planRefinement, scopeInstruction } from './planner.ts'
import type { Complete } from './planner.ts'
import { validateEdit } from './refine.ts'
import type { RefinementEdit } from './types.ts'
import type { HarnessStore } from './store.ts'
import { historyForPrompt, overviewForPrompt } from './render.ts'
import { mergeHarnessStates } from './storage.ts'
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
  maxTrajectoryChars?: number
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

function errorResult(
  phase: ExecutionPhase,
  code: RefineErrorCode,
  message: string,
  approval: RefineExecutionResult['approval'] = 'not-required',
): RefineExecutionResult {
  return { ...emptyResult(approval), failedAt: phase, error: { code, message } }
}

function isProposal(value: unknown): value is { id: string; summary: string; edits: unknown[] } {
  if (typeof value !== 'object' || value === null) return false
  const proposal = value as Record<string, unknown>
  return typeof proposal.id === 'string' && proposal.id.trim() !== ''
    && typeof proposal.summary === 'string' && Array.isArray(proposal.edits)
}

function counts(appliedEdits: Array<{ applied: boolean }>): { appliedCount: number; rejectedCount: number } {
  return appliedEdits.reduce((result, edit) => {
    if (edit.applied) result.appliedCount += 1
    else result.rejectedCount += 1
    return result
  }, { appliedCount: 0, rejectedCount: 0 })
}

export function createRefineCoordinator(options: RefineCoordinatorOptions): RefineCoordinator {
  const maxTrajectoryChars = options.maxTrajectoryChars ?? 12_000
  return {
    async execute(request) {
      const validationError = validateRequest(request)
      if (validationError) {
        return { ...errorResult('validation', 'invalid-request', validationError) }
      }
      if (request.signal?.aborted) return errorResult('validation', 'aborted', 'refinement request aborted')
      if (request.mode !== 'plan') return emptyResult()

      const localState = options.store.localState(request.agent)
      const globalState = options.store.globalState()
      const baseline = request.scope === 'global' ? globalState : localState
      const stateOverview = overviewForPrompt(mergeHarnessStates(globalState, localState))
      const historyText = historyForPrompt(options.store.history(request.agent))
      const trajectoryText = options.store.trajectory(request.agent, maxTrajectoryChars)

      if (request.signal?.aborted) return errorResult('planning', 'aborted', 'refinement request aborted')
      let proposal: { id: string; summary: string; edits: unknown[] }
      try {
        const planned = await planRefinement({
          stateOverview,
          historyText,
          trajectoryText,
          scopeInstruction: scopeInstruction(request.scope === 'global'),
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        }, options.completeFor(request.agent), request.signal)
        proposal = planned
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = message === 'malformed refinement proposal' || message.includes('Unexpected token') || message.includes('Unexpected end')
          ? 'invalid-proposal'
          : 'planning-failed'
        return errorResult('planning', code, message)
      }
      if (!isProposal(proposal)) return errorResult('planning', 'invalid-proposal', 'malformed refinement proposal')
      const invalidEdit = proposal.edits.find(edit => {
        if (typeof edit !== 'object' || edit === null) return true
        try {
          return validateEdit(edit as RefinementEdit) !== undefined
        } catch {
          return true
        }
      })
      if (invalidEdit !== undefined) return errorResult('planning', 'invalid-proposal', 'malformed refinement edit')
      if (request.signal?.aborted) return errorResult('planning', 'aborted', 'refinement request aborted')
      if (proposal.edits.length === 0) return emptyResult()

      const requiresApproval = request.scope === 'global' && request.source === 'tool' && options.requireGlobalApprovalForTool === true
      let approval: RefineExecutionResult['approval'] = 'not-required'
      if (requiresApproval) {
        if (!options.requireGlobalApproval) return errorResult('approval', 'approval-unavailable', 'global approval service unavailable')
        if (request.signal?.aborted) return errorResult('approval', 'aborted', 'refinement request aborted')
        try {
          await options.requireGlobalApproval(request.agent, request.signal, proposal.summary)
          approval = 'approved'
        } catch (error) {
          return errorResult('approval', 'approval-rejected', error instanceof Error ? error.message : String(error), 'rejected')
        }
        if (request.signal?.aborted) return errorResult('approval', 'aborted', 'refinement request aborted', approval)
      }
      if (request.signal?.aborted) return errorResult('commit', 'aborted', 'refinement request aborted', approval)

      let result: RefinementResult & { materialization: MaterializationResult }
      try {
        result = await options.store.applyRefinement(request.agent, proposal as never, {
          global: request.scope === 'global',
          baseline,
          automatic: request.source === 'automatic',
        })
      } catch (error) {
        return errorResult('commit', 'commit-failed', error instanceof Error ? error.message : String(error), approval)
      }
      const editCounts = counts(result.appliedEdits ?? [])
      const committed: RefineExecutionResult = {
        commitStatus: editCounts.rejectedCount > 0 ? 'committed-with-rejected-edits' : 'committed',
        approval,
        ...editCounts,
        refinement: result,
        ...(result.materialization === undefined ? {} : { materialization: result.materialization }),
        ...(result.materialization?.status === 'failed' ? {
          failedAt: 'materialization' as const,
          error: { code: 'materialization-failed' as const, message: 'skill materialization failed' },
        } : {}),
      }
      return committed
    },
  }
}

