import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HARNESS_REFINEMENT_EVENT } from '../src/domain.ts'
import { install } from '../src/invariant.ts'

/** Session stand-in: the installer only reads `String(session.id)`. */
function sessionOf(id: string): Session {
  return { id: SessionId(id) } as unknown as Session
}

function emitRefinement(ctx: Context, id: string, data: unknown): void {
  ctx.emit('session/event', sessionOf(id), {
    type: HARNESS_REFINEMENT_EVENT,
    seq: 1,
    time: Date.now(),
    data,
  })
}

/** Settle the installer's queueMicrotask batch. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('continual-harness invariant', () => {
  it('passes a well-formed refinement result', async () => {
    const ctx = new Context()
    const fail = vi.fn()
    install(ctx, fail as never)
    emitRefinement(ctx, 'ok-1', {
      id: 'refine_1',
      summary: 'seed',
      appliedEdits: [{ action: 'create', kind: 'memory', id: 'm', applied: true }],
      committedAt: '2026-01-01T00:00:00.000Z',
      scope: 'local',
    })
    emitRefinement(ctx, 'ok-2', {
      id: 'rollback_refine_1',
      summary: 'undo',
      appliedEdits: [{ action: 'delete', kind: 'memory', id: 'm', applied: true }],
      committedAt: '2026-01-01T00:00:00.000Z',
      scope: 'local',
      rollbackOf: 'refine_1',
    })
    await settle()
    expect(fail).not.toHaveBeenCalled()
  })

  it.each([
    ['non-object', 42, 'not an object'],
    ['empty id', { id: '', summary: 's', appliedEdits: [] }, 'non-empty string'],
    ['missing summary', { id: 'x', appliedEdits: [] }, 'summary must be a string'],
    ['non-array edits', { id: 'x', summary: 's', appliedEdits: 'no' }, 'appliedEdits must be an array'],
    ['bad action', { id: 'x', summary: 's', appliedEdits: [{ action: 'upsert', kind: 'memory', id: 'm', applied: true }] }, 'action must be'],
    ['bad kind', { id: 'x', summary: 's', appliedEdits: [{ action: 'create', kind: 'note', id: 'm', applied: true }] }, 'kind must be'],
    ['missing edit id', { id: 'x', summary: 's', appliedEdits: [{ action: 'create', kind: 'memory', applied: true }] }, 'edit id must be a string'],
    ['non-boolean applied', { id: 'x', summary: 's', appliedEdits: [{ action: 'create', kind: 'memory', id: 'm', applied: 'yes' }] }, 'applied must be a boolean'],
    ['non-string rollbackOf', { id: 'x', summary: 's', appliedEdits: [], rollbackOf: 7 }, 'rollbackOf must be a string'],
  ])('fails a malformed record: %s', async (_label, data, fragment) => {
    const ctx = new Context()
    const fail = vi.fn()
    install(ctx, fail as never)
    emitRefinement(ctx, 'bad-session', data)
    await settle()
    expect(fail).toHaveBeenCalledTimes(1)
    const [message] = fail.mock.calls[0]
    expect(String(message)).toContain('bad-session')
    expect(String(message)).toContain(String(fragment))
  })

  it('ignores events of other types', async () => {
    const ctx = new Context()
    const fail = vi.fn()
    install(ctx, fail as never)
    ctx.emit('session/event', sessionOf('other'), {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'success' } },
    })
    await settle()
    expect(fail).not.toHaveBeenCalled()
  })

  it('batches a burst of malformed commits into per-record failures', async () => {
    const ctx = new Context()
    const fail = vi.fn()
    install(ctx, fail as never)
    emitRefinement(ctx, 'burst-1', { id: '', summary: 's', appliedEdits: [] })
    emitRefinement(ctx, 'burst-2', { id: 'x', summary: 5, appliedEdits: [] })
    await settle()
    expect(fail).toHaveBeenCalledTimes(2)
  })
})
