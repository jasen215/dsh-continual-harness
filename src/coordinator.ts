/**
 * Protocol-independent refine execution pipeline: validates requests, plans
 * through the Complete seam, gates global tool writes behind approval, and
 * commits through the HarnessStore — shared by the harness_refine tool, the
 * automatic driver gate, and the optional /refine command. Post-apply
 * diagnostics run after every committed refinement.
 * @module dsh-continual-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { isTruncatedReply, planRefinement, REFINEMENT_SYSTEM_PROMPT, scopeInstruction } from './planner.ts'
import type { Complete, CompleteContext } from './planner.ts'
import {
  DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS,
  DEFAULT_TOKEN_PER_CHAR_RATIO,
  estimateCharsTokens,
  estimateMessagesChars,
  MIN_PLANNER_OUTPUT_TOKENS,
  plannerOutputBudget,
} from './budget.ts'
import { DEFAULT_PLANNER_MAX_TOKENS } from './complete.ts'
import type { HostRequestRegistry } from './request-snapshot.ts'
import { detectPlannerRoute, type PlannerPrefixCacheMode, type PlannerRoute } from './cache-detect.ts'
import { rollbackProposal, touchedSkillIds, validateEdit } from './refine.ts'
import type { RefinementEdit } from './types.ts'
import type { HarnessStore } from './store.ts'
import { DEFAULT_TRAJECTORY_MAX_CHARS, DEFAULT_TRAJECTORY_SIGNAL_RATIO } from './store.ts'
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
 * carrying those entries plus the refinement id, touched ids, and signal. An
 * effective-state read or runner throw becomes `failedAt: 'diagnostics'` with
 * `diagnostics-failed` without touching the already-produced commit status,
 * counts, refinement, or materialization. An abort immediately before
 * diagnostics begins returns `aborted` with the existing commit retained; an
 * abort during the runner surfaces as the runner's partial report instead.
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
  const touched = touchedSkillIds(committed.refinement.appliedEdits ?? [])
  try {
    // Providers iterate only touched ids; skip the merged-state read when nothing was touched.
    const entries = touched.length === 0
      ? {} as Record<string, SkillEntry>
      : options.store.state(request.agent).entries.skill as Record<string, SkillEntry>
    const diagnostics = await options.diagnostics.run({
      refinementId: committed.refinement.id,
      touchedSkillIds: touched,
      entries,
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
  const maxTrajectoryChars = options.maxTrajectoryChars ?? DEFAULT_TRAJECTORY_MAX_CHARS
  const mutex = new KeyedMutex()
  const plannerMaxTokens = options.plannerMaxTokens ?? DEFAULT_PLANNER_MAX_TOKENS
  const tokenPerCharRatio = options.plannerTokenPerCharRatio ?? DEFAULT_TOKEN_PER_CHAR_RATIO
  const safetyReserveTokens = options.plannerSafetyReserveTokens ?? DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS
  const minPlannerOutputTokens = options.minPlannerOutputTokens ?? MIN_PLANNER_OUTPUT_TOKENS

  /**
   * Output budget for a planner call plus the resolved context window; both
   * undefined when no window is resolvable. The window is surfaced so Route A
   * can run its prefix-inclusive feasibility check on the same resolution.
   */
  async function outputBudgetFor(inputChars: number, provider: string, model: string, signal: AbortSignal | undefined): Promise<{ outputBudget: number | undefined; contextWindow: number | undefined }> {
    if (options.resolveContextWindow === undefined) return { outputBudget: undefined, contextWindow: undefined }
    const contextWindow = await options.resolveContextWindow(provider, model, signal)
    if (contextWindow === undefined) return { outputBudget: undefined, contextWindow: undefined }
    return {
      contextWindow,
      outputBudget: plannerOutputBudget({
        contextWindow,
        inputChars,
        tokenPerCharRatio,
        configuredMaxTokens: plannerMaxTokens,
        safetyReserveTokens,
      }),
    }
  }
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

      if (request.signal?.aborted) return errorResult('planning', 'aborted', 'refinement request aborted')
      const route: PlannerRoute = detectPlannerRoute(request.agent.session.snapshotEvents(), options.plannerPrefixCache ?? 'auto')
      options.logger?.info(`harness refine planning route: ${route}`)
      const complete = options.completeFor(request.agent)
      const trajectorySignalRatio = options.trajectorySignalRatio ?? DEFAULT_TRAJECTORY_SIGNAL_RATIO
      const instructionOpts = request.instructions === undefined ? {} : { instructions: request.instructions }
      const planInput = (trajectoryText: string) => ({
        stateOverview,
        historyText,
        trajectoryText,
        scopeInstruction: scopeInstruction(request.scope === 'global'),
        ...instructionOpts,
      })
      const planWithTrajectory = async (): Promise<{ id: string; summary: string; edits: unknown[] }> => {
        const input = planInput(options.store.trajectory(request.agent, maxTrajectoryChars, trajectorySignalRatio))
        // The rules ride Route B's system slot (planRefinement falls back to
        // REFINEMENT_SYSTEM_PROMPT); count them so B treats the rules block
        // exactly like Route A does. Elements mirror the user-string shapes
        // planRefinement actually builds.
        const inputChars = [
          REFINEMENT_SYSTEM_PROMPT,
          `# Store scope\n${input.scopeInstruction}`,
          input.stateOverview,
          input.historyText,
          input.trajectoryText === '' ? '' : `# Current trajectory excerpt (tail-biased)\n${input.trajectoryText}`,
          input.instructions ? `# Focus instructions\n${input.instructions}` : '',
        ].filter(Boolean).join('\n\n').length
        const provider = request.agent.options.provider ?? ''
        const model = request.agent.options.model ?? ''
        const { outputBudget } = await outputBudgetFor(inputChars, provider, model, request.signal)
        // Minimum-output feasibility gate (spec §2.3.5): an infeasible request
        // is never sent — the throw lands in the outer catch and maps to
        // planning-failed instead of issuing a call that cannot fit.
        if (outputBudget !== undefined && outputBudget < minPlannerOutputTokens) {
          throw new Error('planner output budget below minimum viable proposal size')
        }
        const maxTokens = outputBudget
        const context: CompleteContext = maxTokens === undefined ? {} : { maxTokens }
        return planRefinement(input, complete, request.signal, undefined, undefined, context)
      }
      let proposal: { id: string; summary: string; edits: unknown[] }
      try {
        if (route === 'A') {
          // Route A (spec §2.2): reuse the actual host-loop request snapshot verbatim
          // (system/tools/messages/sessionId) so the provider can serve the warm
          // prefix; no sanitize, no truncate, no reorder — any rewrite would break
          // the cache key. Falls back to the official reconstruction path
          // (requestHeader + deriveMessages) when no snapshot was captured yet.
          const session = request.agent.session
          const snapshot = options.hostRequests?.latestFor(session.id)
          const header = session.requestHeader()
          const prefix = snapshot?.messages ?? session.deriveMessages()
          const system = snapshot?.system ?? header?.system
          const tools = snapshot?.tools ?? header?.tools
          const sessionId = snapshot?.sessionId ?? session.id

          // Only the NEW planner content is budgeted; the cached prefix is never
          // trimmed to fit (a prefix never reduces maxTokens). The total window
          // still bounds feasibility: the prefix-inclusive check below makes an
          // over-window prefix infeasible for Route A (→ B), never smaller output.
          const planInputContext = planInput('')
          const newInputChars = [
            REFINEMENT_SYSTEM_PROMPT, // rules move into the trailing user message
            `# Store scope\n${planInputContext.scopeInstruction}`,
            planInputContext.stateOverview,
            planInputContext.historyText,
            planInputContext.instructions ? `# Focus instructions\n${planInputContext.instructions}` : '',
          ].filter(Boolean).join('\n\n').length
          const provider = snapshot?.provider ?? request.agent.options.provider ?? ''
          const model = snapshot?.model ?? request.agent.options.model ?? ''
          const { outputBudget, contextWindow } = await outputBudgetFor(newInputChars, provider, model, request.signal)
          const maxTokens = outputBudget

          // Feasibility-only gate: Route A must leave at least
          // minPlannerOutputTokens of room for the planner output after the FULL
          // request — cached prefix (messages + system) plus new planner content
          // plus the safety reserve. The prefix is never shrunk to fit; an
          // over-window prefix makes A infeasible and we fall through to B.
          const prefixTokens = estimateCharsTokens(estimateMessagesChars(prefix) + (system?.length ?? 0), tokenPerCharRatio)
          const newInputTokens = estimateCharsTokens(newInputChars, tokenPerCharRatio)
          const feasible = outputBudget === undefined || (contextWindow !== undefined && contextWindow - prefixTokens - newInputTokens - safetyReserveTokens >= minPlannerOutputTokens)
          if (feasible) {
            try {
              const context: CompleteContext = {
                ...(tools === undefined ? {} : { tools }),
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(maxTokens === undefined ? {} : { maxTokens }),
              }
              proposal = await planRefinement(planInputContext, complete, request.signal, prefix, system, context)
            } catch (error) {
              // Silent fallback: an unusable Route A reply retries via Route B
              // (trajectory summary) without logging a fallback line (spec §2.2).
              if (!(error instanceof Error) || !isTruncatedReply(error.message)) throw error
              proposal = await planWithTrajectory()
            }
          } else {
            proposal = await planWithTrajectory()
          }
        } else {
          proposal = await planWithTrajectory()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = isTruncatedReply(message) ? 'invalid-proposal' : 'planning-failed'
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
