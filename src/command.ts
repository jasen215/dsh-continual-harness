/**
 * Optional `/refine` slash-command adapter: parses raw input into a coordinator
 * request, executes once, and renders the result as plain text. Registered only
 * when the host provides a `commands` capability (`@deepseek-ai/dsh-commands`).
 * The host contract is a single-definition `register()` and a result carrying
 * a `kind` discriminator; this adapter speaks that contract so the command
 * works against the real dsh host without a shim.
 * @module dsh-continual-harness
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { executionSummary } from './coordinator.ts'
import type { RefineCoordinator, RefineExecutionResult, RefineRequest } from './coordinator.ts'

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
 * one coordinator request (`source: 'command'`), execute once, and render the
 * result as plain text. A missing live agent or a parse error returns usage
 * text without any coordinator call.
 */
export function createRefineCommandAdapter(
  coordinator: RefineCoordinator,
  options: { defaultGlobal: boolean },
): (invocation: CommandInvocation) => Promise<CommandResult> {
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
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        }
      : {
          mode: 'rollback',
          agent: invocation.agent,
          scope: parsed.scope,
          source: 'command',
          rollbackId: parsed.rollbackId,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        }
    const result = await coordinator.execute(request)
    return { kind: 'success', text: renderExecution(result, parsed.scope) }
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
  options: { defaultGlobal: boolean },
): { dispose(): void } {
  return commands.register({
    name: 'refine',
    description: 'Run a harness refinement plan or rollback through the shared coordinator',
    input: { hint: 'plan instructions, or "rollback <id> [--global|--local]"' },
    handler: createRefineCommandAdapter(coordinator, options),
  })
}
