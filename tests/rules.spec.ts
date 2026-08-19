import { describe, expect, it } from 'vitest'
import {
  applyRefinementProposal,
  freshState,
  rollbackProposal,
  validateEdit,
} from '../src/refine.ts'
import type { RefinementProposal } from '../src/types.ts'

describe('edit reason contract', () => {
  it('accepts create without reason', () => {
    expect(validateEdit({ action: 'create', kind: 'memory', id: 'fact', content: 'x' }))
      .toBeUndefined()
  })

  it('rejects update/delete without reason with the exact message', () => {
    const message = (id: string) => `edit "${id}"缺 reason被拒绝，请补充 reason后重新提交`
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', content: 'x' }))
      .toBe(message('m'))
    expect(validateEdit({ action: 'delete', kind: 'memory', id: 'm' }))
      .toBe(message('m'))
    // empty-string reason is also rejected
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', reason: '', content: 'x' }))
      .toBe(message('m'))
  })

  it('accepts update/delete with a reason', () => {
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'x' }))
      .toBeUndefined()
    expect(validateEdit({ action: 'delete', kind: 'memory', id: 'm', reason: 'why' }))
      .toBeUndefined()
  })
})

describe('edit blastRadius contract', () => {
  it('rejects an unknown blastRadius value', () => {
    expect(validateEdit({ action: 'create', kind: 'memory', id: 'm', content: 'x', blastRadius: 'bogus' }))
      .toBe('invalid blastRadius: bogus')
  })

  it('accepts every valid blastRadius value', () => {
    for (const blastRadius of ['general', 'project', 'session'] as const) {
      expect(validateEdit({ action: 'create', kind: 'memory', id: 'm', content: 'x', blastRadius }))
        .toBeUndefined()
    }
  })
})

describe('applied edit persistence', () => {
  it('persists blastRadius defaulting to general and reason only when given', () => {
    const state = freshState()
    state.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }
    state.entries.memory['m2'] = { id: 'm2', kind: 'memory', version: 1, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }
    const proposal: RefinementProposal = {
      id: 'refine_rules_1',
      summary: 'persistence',
      edits: [
        { action: 'create', kind: 'memory', id: 'new', content: 'fresh' },
        { action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'new' },
        { action: 'update', kind: 'memory', id: 'm2', reason: 'why', blastRadius: 'project', content: 'new' },
      ],
    }
    const { result, state: next } = applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
    })
    // create: blastRadius defaults to general, reason absent
    const created = result.appliedEdits.find(edit => edit.id === 'new')!
    expect(created.applied).toBe(true)
    expect(created.blastRadius).toBe('general')
    expect('reason' in created).toBe(false)
    // update: reason persists, blastRadius defaults to general
    const updated = result.appliedEdits.find(edit => edit.id === 'm')!
    expect(updated.applied).toBe(true)
    expect(updated.reason).toBe('why')
    expect(updated.blastRadius).toBe('general')
    // explicit blastRadius persists as-is
    const explicit = result.appliedEdits.find(edit => edit.id === 'm2')!
    expect(explicit.blastRadius).toBe('project')
    expect(explicit.reason).toBe('why')
    // the committed result record persists the same fields
    const committed = next.refinements[0]!.appliedEdits.find(edit => edit.id === 'm')!
    expect(committed.blastRadius).toBe('general')
    expect(committed.reason).toBe('why')
  })

  it('stamps blastRadius on rejected edits too', () => {
    const state = freshState()
    const proposal: RefinementProposal = {
      id: 'refine_rules_2',
      summary: 'rejected',
      edits: [
        { action: 'update', kind: 'memory', id: 'missing', reason: 'why', content: 'x' },
      ],
    }
    const { result } = applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
    })
    const rejected = result.appliedEdits[0]!
    expect(rejected.applied).toBe(false)
    expect(rejected.error).toBe('entry not found')
    expect(rejected.blastRadius).toBe('general')
  })
})

describe('rollback reason stamping', () => {
  it('stamps rollback reason on every generated edit and survives validation', () => {
    const state = freshState()
    const proposal: RefinementProposal = {
      id: 'refine_rules_3',
      summary: 'two creates',
      edits: [
        { action: 'create', kind: 'memory', id: 'a', content: 'A' },
        { action: 'create', kind: 'memory', id: 'b', content: 'B' },
      ],
    }
    const { result, state: next } = applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
    })
    const rollback = rollbackProposal(result)
    expect(rollback.edits.length).toBeGreaterThan(0)
    for (const edit of rollback.edits) {
      expect(edit.reason).toBe(`rollback:${result.id}`)
      // every generated edit passes validation (reason present)
      expect(validateEdit(edit)).toBeUndefined()
    }
    // applying the rollback is not rejected by the reason check
    const { result: rollbackResult } = applyRefinementProposal(next, rollback, {
      id: rollback.id,
      rollbackOf: result.id,
      scope: 'local',
      baselineState: next,
    })
    for (const edit of rollbackResult.appliedEdits) {
      expect(edit.error).toBeUndefined()
    }
  })
})
