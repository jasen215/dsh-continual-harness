/**
 * Invariant companion of the plugin: audits the durable harness/refinement
 * event stream and the on-disk store after every commit, so a corrupt record
 * cannot silently poison the refinement history.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { HARNESS_REFINEMENT_EVENT } from './domain.ts'

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
 * Install the companion: defer a validation check until the session's commit
 * feed settles, then fail the invariant when any committed refinement record
 * is malformed. On-disk state is self-healing (storage.ts degrades corrupt
 * files to empty), so only the durable event stream needs the audit.
 */
export const install: InvariantInstaller = Object.assign((_ctx: Context, fail: InvariantFailure) => {
  const pending: Array<{ sessionId: string; event: { type: string; data: unknown } }> = []

  _ctx.on('session/event', (session, event) => {
    if (event.type !== HARNESS_REFINEMENT_EVENT) return
    pending.push({ sessionId: String(session.id), event })
    queueMicrotask(() => {
      const staged = pending.splice(0)
      for (const record of staged) {
        const problem = validateRefinement(record.event.data)
        if (problem) {
          fail(`session ${record.sessionId} committed a malformed ${HARNESS_REFINEMENT_EVENT} event: ${problem}`)
        }
      }
    })
  })
}, { inject: [] })

/**
 * Register the continual-harness invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
