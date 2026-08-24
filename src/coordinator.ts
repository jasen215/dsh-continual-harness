/**
 * Protocol-independent refine execution pipeline: validates requests, plans
 * through the Complete seam, gates global tool writes behind approval, and
 * commits through the HarnessStore — shared by the harness_refine tool, the
 * automatic driver gate, and the optional /refine command. Post-apply
 * diagnostics run after every committed refinement.
 * @module dsh-continual-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { planRefinement, scopeInstruction } from './planner.ts'
import type { Complete } from './planner.ts'
import { rollbackProposal, touchedSkillIds, validateEdit } from './refine.ts'
import type { RefinementEdit } from './types.ts'
import type { HarnessStore } from './store.ts'
import { historyForPrompt, overviewForPrompt } from './render.ts'
import { mergeHarnessStates } from './storage.ts'
import type { DiagnosticRunner } from './diagnostics.ts'
import type {
  AutoRefineReason,
  DiagnosticReport,
  HarnessScope,
  MaterializationResult,
  RefinementProposal,
  RefinementResult,
  SkillEntry,
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
}

/** One-line summary for a refinement result; shared by the tool and command renderers. */
export function executionSummary(execution: RefineExecutionResult): string {
  return execution.refinement?.summary ?? execution.error?.message ?? 'no refinement produced'
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

/** Rollback target validation shared by the fast-fail phase and the in-mutex re-check. */
function rollbackErrorFor(
  history: RefinementResult[],
  rollbackId: string,
  scope: HarnessScope,
): { target: RefinementResult } | { error: { code: RefineErrorCode; message: string } } {
  const target = history.find(item => item.id === rollbackId)
  if (!target) return { error: { code: 'rollback-target-not-found', message: `no refinement found with id ${rollbackId}` } }
  if (target.scope !== scope) return { error: { code: 'rollback-scope-mismatch', message: `refinement ${rollbackId} belongs to ${target.scope} scope` } }
  if (target.rollbackOf !== undefined || history.some(item => item.rollbackOf === target.id)) {
    return { error: { code: 'rollback-already-rolled-back', message: `refinement ${rollbackId} has already been rolled back` } }
  }
  return { target }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.tails.set(key, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.tails.get(key) === current) this.tails.delete(key)
    }
  }
}

function executionFromCommit(
  result: RefinementResult & { materialization: MaterializationResult },
  approval: RefineExecutionResult['approval'],
): RefineExecutionResult {
  const editCounts = counts(result.appliedEdits ?? [])
  return {
    commitStatus: editCounts.rejectedCount > 0 ? 'committed-with-rejected-edits' : 'committed',
    approval,
    ...editCounts,
    refinement: result,
    materialization: result.materialization,
    ...(result.materialization.status === 'failed' ? {
      failedAt: 'materialization' as const,
      error: { code: 'materialization-failed' as const, message: 'skill materialization failed' },
    } : {}),
  }
}

/**
 * Post-apply diagnostics hook (spec §4): runs at most once after a committed
 * refinement. Derives touched skill ids from the applied skill edits, reads
 * the effective post-apply skill entries once, and hands the runner a request
 * with those entries plus the commit's materialization report. A runner throw
 * becomes `failedAt: 'diagnostics'` with `diagnostics-failed` without touching
 * the already-produced commit status, counts, refinement, or materialization.
 * An abort immediately before diagnostics begins returns `aborted` with the
 * existing commit retained; an abort during the runner surfaces as the
 * runner's partial report instead.
 */
async function attachDiagnostics(
  options: RefineCoordinatorOptions,
  request: RefineRequest,
  committed: RefineExecutionResult,
): Promise<RefineExecutionResult> {
  if (options.diagnostics === undefined || committed.refinement === undefined) return committed
  if (request.signal?.aborted) {
    return { ...committed, failedAt: 'diagnostics', error: { code: 'aborted', message: 'refinement request aborted' } }
  }
  const touched = touchedSkillIds(committed.refinement.appliedEdits)
  // Providers iterate only touched ids; skip the merged-state read when nothing was touched.
  const entries = touched.length === 0
    ? {} as Record<string, SkillEntry>
    : options.store.state(request.agent).entries.skill as Record<string, SkillEntry>
  try {
    const diagnostics = await options.diagnostics.run({
      refinementId: committed.refinement.id,
      touchedSkillIds: touched,
      entries,
      ...(committed.materialization === undefined ? {} : { materialization: committed.materialization }),
      // The coordinator itself never requests security; the runner's
      // construction decides whether its security provider is enabled.
      enableSecurity: false,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    return { ...committed, diagnostics }
  } catch (error) {
    return {
      ...committed,
      failedAt: 'diagnostics',
      error: { code: 'diagnostics-failed', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

export function createRefineCoordinator(options: RefineCoordinatorOptions): RefineCoordinator {
  const maxTrajectoryChars = options.maxTrajectoryChars ?? 12_000
  const mutex = new KeyedMutex()
  return {
    async execute(request) {
      const validationError = validateRequest(request)
      if (validationError) {
        return { ...errorResult('validation', 'invalid-request', validationError) }
      }
      if (request.signal?.aborted) return errorResult('validation', 'aborted', 'refinement request aborted')

      if (request.mode === 'rollback') {
        const history = options.store.history(request.agent)
        const resolved = rollbackErrorFor(history, request.rollbackId, request.scope)
        if ('error' in resolved) return errorResult('validation', resolved.error.code, resolved.error.message)
        const key = request.scope === 'global' ? 'global' : `local:${String(request.agent.session.id)}`
        return mutex.run(key, async () => {
          if (request.signal?.aborted) return errorResult('commit', 'aborted', 'refinement request aborted')
          const commitHistory = options.store.history(request.agent)
          const commitResolved = rollbackErrorFor(commitHistory, request.rollbackId, request.scope)
          if ('error' in commitResolved) return errorResult('commit', commitResolved.error.code, commitResolved.error.message)
          const commitTarget = commitResolved.target
          const commitState = request.scope === 'global' ? options.store.globalState() : options.store.localState(request.agent)
          const proposal = rollbackProposal(commitTarget)
          try {
            const result = await options.store.applyRefinement(request.agent, proposal, {
              global: request.scope === 'global',
              rollbackOf: commitTarget.id,
              baseline: commitState,
            })
            return attachDiagnostics(options, request, executionFromCommit(result, 'not-required'))
          } catch (error) {
            return errorResult('commit', 'commit-failed', error instanceof Error ? error.message : String(error))
          }
        })
      }

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

      const key = request.scope === 'global' ? 'global' : `local:${String(request.agent.session.id)}`
      return mutex.run(key, async () => {
        if (request.signal?.aborted) return errorResult('commit', 'aborted', 'refinement request aborted', approval)
        // The Store re-reads the target state inside applyRefinement for
        // commit-time conflict detection (spec §5.1/§6.3); the coordinator
        // captured its planner baseline once and does not re-read here.
        let result: RefinementResult & { materialization: MaterializationResult }
        try {
          result = await options.store.applyRefinement(request.agent, proposal as RefinementProposal, {
            global: request.scope === 'global',
            baseline,
            automatic: request.source === 'automatic',
          })
        } catch (error) {
          return errorResult('commit', 'commit-failed', error instanceof Error ? error.message : String(error), approval)
        }
        const committed = executionFromCommit(result, approval)
        return attachDiagnostics(options, request, committed)
      })
    },
  }
}
