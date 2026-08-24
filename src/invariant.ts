/**
 * Invariant companion of the plugin: audits every committed refinement
 * result, so a corrupt record cannot silently poison the refinement history.
 * The audit rides the plugin's own scoped `harness/refined` emit (which fires
 * on every commit regardless of whether the optional `harness/refinement`
 * session event was written), so it works whether or not the running harness
 * recognizes the plugin's out-of-repo event type.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-continual-harness'

/** Cordis companion plugin name. */
export const name = 'continual-harness-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateRefinement(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'refinement result is not an object'
  const result = value as Record<string, unknown>
  if (typeof result.id !== 'string' || result.id.length === 0) return 'refinement result id must be a non-empty string'
  if (typeof result.summary !== 'string') return 'refinement result summary must be a string'
  if (!Array.isArray(result.appliedEdits)) return 'refinement result appliedEdits must be an array'
  for (const edit of result.appliedEdits) {
    if (typeof edit !== 'object' || edit === null) return 'refinement edit must be an object'
    const record = edit as Record<string, unknown>
    if (typeof record.action !== 'string' || !['create', 'update', 'delete'].includes(record.action)) {
      return 'refinement edit action must be create|update|delete'
    }
    if (typeof record.kind !== 'string' || !['prompt', 'memory', 'skill', 'subagent'].includes(record.kind)) {
      return 'refinement edit kind must be prompt|memory|skill|subagent'
    }
    if (typeof record.id !== 'string') return 'refinement edit id must be a string'
    if (typeof record.applied !== 'boolean') return 'refinement edit applied must be a boolean'
  }
  if (result.rollbackOf !== undefined && typeof result.rollbackOf !== 'string') {
    return 'refinement result rollbackOf must be a string'
  }
  return undefined
}

/**
 * Install the companion: defer a validation check until the commit feed
 * settles, then fail the invariant when any committed refinement result is
 * malformed. The scoped `harness/refined` event is emitted by the store on
 * every commit (session event write or not), so `global: true` listens across
 * all agents; on-disk state is self-healing (storage.ts degrades corrupt
 * files to empty), so the live result is the audit target.
 */
export const install: InvariantInstaller = Object.assign((_ctx: Context, fail: InvariantFailure) => {
  const pending: Array<{ sessionId: string; result: unknown }> = []

  _ctx.on('harness/refined', (payload) => {
    const { agent, result } = payload
    pending.push({ sessionId: String(agent.session.id), result })
    queueMicrotask(() => {
      const staged = pending.splice(0)
      for (const record of staged) {
        const problem = validateRefinement(record.result)
        if (problem) {
          fail(`session ${record.sessionId} committed a malformed refinement result: ${problem}`)
        }
      }
    })
  }, { global: true })
}, { inject: [] })

/**
 * Register the continual-harness invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
