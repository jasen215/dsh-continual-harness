import { describe, expect, it } from 'vitest'
import {
  applyRefinementProposal,
  freshState,
  rollbackProposal,
  validateEdit,
} from '../src/refine.ts'
import type { RefinementProposal } from '../src/types.ts'

describe('validateEdit', () => {
  it('accepts a well-formed create edit', () => {
    expect(validateEdit({ action: 'create', kind: 'memory', id: 'deploy-failure', content: 'remember to pin versions' }))
      .toBeUndefined()
  })

  it('rejects unknown kinds and actions', () => {
    expect(validateEdit({ action: 'create', kind: 'bogus', id: 'x', content: 'y' })).toContain('unknown kind')
    expect(validateEdit({ action: 'rename', kind: 'memory', id: 'x', content: 'y' })).toContain('unknown action')
  })

  it('treats the base system prompt as immutable', () => {
    expect(validateEdit({ action: 'update', kind: 'prompt', id: 'base_system_prompt', content: 'x' }))
      .toBe('the base system prompt is immutable')
  })

  it('validates skill edits: kebab-case id, content required, description optional', () => {
    expect(validateEdit({ action: 'create', kind: 'skill', id: 'Not Kebab', content: 'c' })).toContain('kebab-case')
    expect(validateEdit({ action: 'create', kind: 'skill', id: 's', content: 'c', description: 'summary' }))
      .toBeUndefined()
    expect(validateEdit({ action: 'delete', kind: 'skill', id: 's', reason: 'why' })).toBeUndefined()
    // legacy python-contract fields remain tolerated for state compatibility
    expect(validateEdit({ action: 'create', kind: 'skill', id: 's', content: 'c', reference: 'r', arguments: '{}' }))
      .toBeUndefined()
  })

  it('requires content for non-delete edits', () => {
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'x', reason: 'why' })).toContain('content')
  })
})

describe('applyRefinementProposal', () => {
  const proposal: RefinementProposal = {
    id: 'refine_1',
    summary: 'remember the pattern',
    edits: [
      { action: 'create', kind: 'memory', id: 'pin-versions', content: 'always pin versions' },
      { action: 'create', kind: 'skill', id: 'repro', content: 'repro skill', description: 'reproduce a bug fast' },
      { action: 'update', kind: 'memory', id: 'missing', reason: 'why', content: 'x' },
      { action: 'delete', kind: 'memory', id: 'stale', reason: 'why', content: '' },
    ],
  }

  it('applies valid edits, reports failures, and bumps versions', () => {
    const state = freshState()
    state.entries.memory['stale'] = { id: 'stale', kind: 'memory', version: 3, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }
    const { result, state: next } = applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
    })
    expect(result.id).toBe('refine_1')
    expect(result.scope).toBe('local')
    expect(next.entries.memory['pin-versions']?.content).toBe('always pin versions')
    expect(next.entries.skill['repro']?.description).toBe('reproduce a bug fast')
    expect(next.entries.memory['stale']).toBeUndefined()
    expect(next.refinements).toHaveLength(1)
    const applied = result.appliedEdits.filter(edit => edit.applied).map(edit => edit.id)
    expect(applied).toEqual(['pin-versions', 'repro', 'stale'])
    expect(result.appliedEdits.find(edit => edit.id === 'missing')?.error).toBe('entry not found')
  })

  it('rejects edits whose baseline entry changed during planning', () => {
    const baseline = freshState()
    baseline.entries.memory['pin-versions'] = { id: 'pin-versions', kind: 'memory', version: 1, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }
    const state = structuredClone(baseline)
    state.entries.memory['pin-versions'] = { id: 'pin-versions', kind: 'memory', version: 2, content: 'new', updatedAt: '2026-01-01T00:00:01.000Z' }
    const { result } = applyRefinementProposal(state, {
      id: 'refine_2',
      summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'pin-versions', reason: 'why', content: 'newest' }],
    }, { id: 'refine_2', scope: 'local', baselineState: baseline })
    const edit = result.appliedEdits[0]!
    expect(edit.applied).toBe(false)
    expect(edit.error).toBe('entry changed during refinement planning')
  })
})

describe('rollbackProposal', () => {
  it('reverses applied edits in reverse order', () => {
    const state = freshState()
    const proposal: RefinementProposal = {
      id: 'refine_3',
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
    expect(rollback.id).toBe('rollback_refine_3')
    expect(rollback.edits.map(edit => edit.id)).toEqual(['b', 'a'])
    const { state: reverted } = applyRefinementProposal(next, rollback, {
      id: rollback.id,
      rollbackOf: 'refine_3',
      scope: 'local',
      baselineState: next,
    })
    expect(reverted.entries.memory['a']).toBeUndefined()
    expect(reverted.entries.memory['b']).toBeUndefined()
  })
})
