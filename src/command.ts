/**
 * Optional `/refine` slash-command adapter: parses raw input into a coordinator
 * request, executes it detached, and renders the result as plain text.
 * Registered only when the host provides a `commands` capability
 * (`@deepseek-ai/dsh-commands`). The host contract is a single-definition
 * `register()` and a result carrying a `kind` discriminator; this adapter
 * speaks that contract so the command works against the real dsh host without
 * a shim.
 *
 * Detached, not awaited: the host `commands` executor awaits the handler for
 * the whole RPC round-trip, and the UI keeps the submitted draft visible until
 * that settle. The handler therefore acknowledges immediately with a
 * `status: started` result and runs the coordinator in the background; the
 * outcome is delivered through the optional outcome reporter (by default a
 * plugin-source session message plus a harness log line) when it settles. The
 * invocation's `signal` is deliberately not forwarded: it belongs to the UI
 * request and may abort once the handler settles, which would kill the very
 * refinement the user just started.
 * @module dsh-continual-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { executionSummary } from './coordinator.ts'
import type { RefineCoordinator, RefineExecutionResult, RefineRequest } from './coordinator.ts'
import { PLUGIN_NAME } from './domain.ts'
import type { HarnessScope } from './types.ts'

/**
 * One command invocation from a host `commands` capability. The host passes
 * the raw input without the command name and `/` prefix; the adapter also
 * accepts the full `/refine ...` form.
 */
export interface CommandInvocation {
  rawInput: string
  agent?: Agent
  signal?: AbortSignal
}

/** A command handler result in the host's discriminated shape. */
export type CommandResult =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

/** A command definition accepted by the host `commands.register()`. */
export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string; images?: boolean }
  handler: (invocation: CommandInvocation) => Promise<CommandResult>
}

/**
 * Async outcome reporter for a detached `/refine` execution. Called exactly
 * once per admitted invocation, after the coordinator settles (or throws),
 * with the requested scope so failures of `--global` runs still render the
 * truth. Sync or async; `runDetached` awaits it inside its own containment,
 * so a throwing reporter never surfaces as an unhandled rejection.
 */
export type RefineOutcomeReporter = (
  invocation: CommandInvocation,
  execution: RefineExecutionResult,
  scope: HarnessScope,
) => void | Promise<void>

/** Options for the `/refine` command adapter. */
export interface CommandAdapterOptions {
  /** Scope used by a normal plan that omits `--global`/`--local`. */
  defaultGlobal: boolean
  /** Optional outcome reporter; defaults to {@link reportRefineOutcome}. */
  report?: RefineOutcomeReporter
}

/**
 * Optional host capability that registers slash commands. The coordinator
 * plugin never requires this service; when the host provides it, the
 * `/refine` command registers through the returned disposable handle.
 */
export interface CommandsCapability {
  register(definition: CommandDefinition): { dispose(): void }
}

/** Parser output for one validated `/refine` invocation. */
export type ParsedRefineCommand =
  | { mode: 'plan'; scope: 'local' | 'global'; instructions?: string }
  | { mode: 'rollback'; scope: 'local' | 'global'; rollbackId: string }

const SCOPE_FLAGS = ['--global', '--local'] as const
type ScopeFlag = (typeof SCOPE_FLAGS)[number]

function isScopeFlag(token: string): token is ScopeFlag {
  return (SCOPE_FLAGS as readonly string[]).includes(token)
}

function scopeOf(flag: ScopeFlag): 'local' | 'global' {
  return flag === '--global' ? 'global' : 'local'
}

/** Strip one leading `/refine` or `refine` token; a bare remainder passes through. */
function stripRefineToken(rawInput: string): string {
  return rawInput.trim().replace(/^\/?refine(?=\s|$)/, '').trim()
}

function parsePlan(tokens: string[], defaultGlobal: boolean): ParsedRefineCommand | { error: string } {
  let scope: 'local' | 'global' | undefined
  const focus: string[] = []
  for (const token of tokens) {
    if (isScopeFlag(token)) {
      if (scope !== undefined) return { error: `duplicate scope flag ${token}` }
      scope = scopeOf(token)
    } else if (token.startsWith('--')) {
      return { error: `unknown flag ${token}` }
    } else {
      focus.push(token)
    }
  }
  const result: ParsedRefineCommand = { mode: 'plan', scope: scope ?? (defaultGlobal ? 'global' : 'local') }
  if (focus.length > 0) result.instructions = focus.join(' ')
  return result
}

function parseRollback(tokens: string[]): ParsedRefineCommand | { error: string } {
  let scope: 'local' | 'global' | undefined
  const ids: string[] = []
  for (const token of tokens) {
    if (isScopeFlag(token)) {
      if (scope !== undefined) return { error: `duplicate scope flag ${token}` }
      scope = scopeOf(token)
    } else if (token.startsWith('--')) {
      return { error: `unknown flag ${token}` }
    } else {
      ids.push(token)
    }
  }
  if (scope === undefined) return { error: 'rollback requires an explicit --local or --global scope' }
  if (ids.length === 0) return { error: 'rollback requires a non-empty id' }
  if (ids.length > 1) return { error: 'rollback accepts exactly one id and no focus text' }
  return { mode: 'rollback', scope, rollbackId: ids[0]! }
}

/**
 * Parse one `/refine` raw input into a domain request shape. Pure: never
 * touches the coordinator, the store, or any live agent.
 * @param rawInput - full command input, with or without the `/refine` prefix.
 * @param defaultGlobal - scope used by a normal plan that omits `--global`/`--local`.
 */
export function parseRefineCommand(rawInput: string, defaultGlobal: boolean): ParsedRefineCommand | { error: string } {
  const tokens = stripRefineToken(rawInput).split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) return { mode: 'plan', scope: defaultGlobal ? 'global' : 'local' }
  if (tokens[0] === 'rollback') return parseRollback(tokens.slice(1))
  return parsePlan(tokens, defaultGlobal)
}

function renderExecution(result: RefineExecutionResult, scope: 'local' | 'global'): string {
  const lines = [
    `status: ${result.commitStatus === 'not-committed' ? 'not-committed' : 'committed'}`,
    `scope: ${result.refinement?.scope ?? scope}`,
    `refinement: ${result.refinement?.id ?? 'none'}`,
    `applied: ${result.appliedCount}`,
    `rejected: ${result.rejectedCount}`,
    `summary: ${executionSummary(result)}`,
  ]
  if (result.error) lines.push(`error: ${result.error.code} ${result.error.message}`)
  // Concise post-apply diagnostics: one status line, then one line per
  // provider error (provider/code/message) — never the full skill content.
  if (result.diagnostics) {
    lines.push(`diagnostics: ${result.diagnostics.status}`)
    for (const error of result.diagnostics.errors) {
      lines.push(`diagnostics-error: ${error.provider} ${error.code} ${error.message}`)
    }
  }
  return lines.join('\n')
}

function usageError(message: string): string {
  return [
    'status: not-committed',
    'refinement: none',
    'applied: 0',
    'rejected: 0',
    'summary: usage error',
    `error: invalid-request ${message}`,
  ].join('\n')
}

/**
 * Build the `/refine` command handler: parse the raw input, translate it into
 * one coordinator request (`source: 'command'`), start the execution detached
 * on a later tick, and acknowledge immediately with a `status: started`
 * result — the ack path is parse-only, so the submit RPC settles at once. A
 * missing live agent or a parse error returns usage text without any
 * coordinator call. The invocation signal is never forwarded to the detached
 * execution (see the module header). One execution per session may be in
 * flight; a second submit while one runs is acknowledged `already-running`
 * and skipped.
 */
export function createRefineCommandAdapter(
  coordinator: RefineCoordinator,
  options: CommandAdapterOptions,
): (invocation: CommandInvocation) => Promise<CommandResult> {
  const report = options.report ?? reportRefineOutcome
  // Per-session in-flight guard: the coordinator serializes only the commit
  // phase, so rapid re-submits would otherwise stack concurrent planner calls
  // and an unbounded commit queue. Mirrors the driver's own in-flight guard.
  const pending = new Set<string>()
  return async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (!invocation.agent) {
      return { kind: 'success', text: usageError('no live agent available for the /refine command') }
    }
    const parsed = parseRefineCommand(invocation.rawInput, options.defaultGlobal)
    if ('error' in parsed) {
      return { kind: 'success', text: usageError(parsed.error) }
    }
    const request: RefineRequest = parsed.mode === 'plan'
      ? {
          mode: 'plan',
          agent: invocation.agent,
          scope: parsed.scope,
          source: 'command',
          ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
        }
      : {
          mode: 'rollback',
          agent: invocation.agent,
          scope: parsed.scope,
          source: 'command',
          rollbackId: parsed.rollbackId,
        }
    const sessionKey = String(invocation.agent.session.id)
    if (pending.has(sessionKey)) {
      return { kind: 'success', text: alreadyRunningAck(parsed) }
    }
    pending.add(sessionKey)
    // Defer the start past the current macrotask so the coordinator's
    // synchronous prologue (store reads, trajectory scan) does not run inside
    // the submit RPC round-trip the change exists to shorten.
    setImmediate(() => {
      runDetached(coordinator, invocation, request, report, () => pending.delete(sessionKey))
    })
    return { kind: 'success', text: startedAck(parsed) }
  }
}

/** Immediate acknowledgment text: the refine is running, not yet settled. */
function startedAck(parsed: ParsedRefineCommand): string {
  return [
    'status: started',
    `scope: ${parsed.scope}`,
    'summary: /refine is running in the background; the outcome will be reported when it settles',
  ].join('\n')
}

/** Acknowledgment for a submit that skipped because one execution is in flight. */
function alreadyRunningAck(parsed: ParsedRefineCommand): string {
  return [
    'status: already-running',
    `scope: ${parsed.scope}`,
    'summary: a /refine execution is already running for this session; the new request was skipped',
  ].join('\n')
}

/**
 * Fire-and-forget the coordinator execution and report its outcome. Never
 * awaited by the handler and never throws: a thrown execution is normalized
 * into an error result and the reporter is awaited inside its own try/catch,
 * so neither can surface an unhandled rejection from the detached path.
 * `onSettled` runs once the outcome has been reported.
 */
function runDetached(
  coordinator: RefineCoordinator,
  invocation: CommandInvocation,
  request: RefineRequest,
  report: RefineOutcomeReporter,
  onSettled?: () => void,
): void {
  void (async () => {
    try {
      let execution: RefineExecutionResult
      try {
        execution = await coordinator.execute(request)
      } catch (error) {
        execution = thrownResult(error)
      }
      try {
        await report(invocation, execution, request.scope)
      } catch {
        // a reporting failure must never break the agent loop
      }
    } finally {
      onSettled?.()
    }
  })()
}

/**
 * Normalize an unexpected coordinator throw into a renderable error result.
 * `execute` contains its own phase errors, so any throw here is an
 * unanticipated failure (store I/O, mutex internals); it is labeled
 * `unexpected-error` without a fabricated phase.
 */
function thrownResult(error: unknown): RefineExecutionResult {
  return {
    commitStatus: 'not-committed',
    approval: 'not-required',
    appliedCount: 0,
    rejectedCount: 0,
    error: {
      code: 'unexpected-error',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * Default async outcome reporter for a detached `/refine` execution: appends
 * one plugin-source `user/message` to the session carrying the rendered
 * outcome (so it shows in the transcript and satisfies the model-visible ⟺
 * logged rule), and mirrors the same text into the harness logger — the log
 * copy also survives a session that is disposed mid-execution. Fully
 * contained: an append or log failure never breaks the agent loop.
 */
export function reportRefineOutcome(
  invocation: CommandInvocation,
  execution: RefineExecutionResult,
  scope: HarnessScope,
): void {
  const agent = invocation.agent
  if (!agent) return
  const text = renderExecution(execution, scope)
  const message = createUserMessage({
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'notice',
      summary: boundContextSummary(executionSummary(execution)),
    },
    content: [{ type: 'text', text }],
  })
  try {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  } catch {
    // a session append failure must never break the agent loop
  }
  try {
    agent.ctx.logger('harness').info(`/refine settled:\n${text}`)
  } catch {
    // a logger failure must never break the agent loop
  }
}

/**
 * Register the `/refine` command through an optional `CommandsCapability`.
 * The returned disposable removes the registration through the capability's
 * own handle.
 */
export function registerRefineCommand(
  commands: CommandsCapability,
  coordinator: RefineCoordinator,
  options: CommandAdapterOptions,
): { dispose(): void } {
  return commands.register({
    name: 'refine',
    description: 'Run a harness refinement plan or rollback through the shared coordinator',
    input: { hint: 'plan instructions, or "rollback <id> [--global|--local]"' },
    handler: createRefineCommandAdapter(coordinator, options),
  })
}
