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

  it('stamps sourceSession on create and preserves it on update', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 's1', summary: 'create',
      edits: [{ action: 'create', kind: 'memory', id: 'm', content: 'x' }],
    }, { id: 's1', scope: 'local', baselineState: state, sourceSession: 'session-9' })
    expect(created.entries.memory['m']?.metadata?.sourceSession).toBe('session-9')

    const { state: updated } = applyRefinementProposal(created, {
      id: 's2', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'y' }],
    }, { id: 's2', scope: 'local', baselineState: created, sourceSession: 'session-9' })
    expect(updated.entries.memory['m']?.metadata?.sourceSession).toBe('session-9')
    expect(updated.entries.memory['m']?.content).toBe('y')
  })

  it('honors edit metadata precedence and sourceSession edge cases', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 'precedence-create', summary: 'create historical',
      edits: [{
        action: 'create', kind: 'memory', id: 'historical', content: 'x',
        metadata: { sourceSession: 'historical' },
      }],
    }, {
      id: 'precedence-create', scope: 'local', baselineState: state, sourceSession: 'current',
    })
    expect(created.entries.memory['historical']?.metadata?.sourceSession).toBe('historical')

    const { state: updated } = applyRefinementProposal(created, {
      id: 'precedence-update', summary: 'update historical',
      edits: [{
        action: 'update', kind: 'memory', id: 'historical', reason: 'restore', content: 'y',
        metadata: { sourceSession: 'historical-update' },
      }],
    }, {
      id: 'precedence-update', scope: 'local', baselineState: created, sourceSession: 'current',
    })
    expect(updated.entries.memory['historical']?.metadata?.sourceSession).toBe('historical-update')

    const archiveState = freshState()
    archiveState.entries.memory['m'] = {
      id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't',
      metadata: { sourceSession: 'original' },
    }
    const { state: archived } = applyRefinementProposal(archiveState, {
      id: 'archive', summary: 'archive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: true }],
    }, { id: 'archive', scope: 'local', baselineState: archiveState, sourceSession: 'current' })
    expect(archived.entries.memory['m']?.metadata?.sourceSession).toBe('original')

    const noMetadataState = freshState()
    noMetadataState.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't' }
    const { state: noMetadataUpdated } = applyRefinementProposal(noMetadataState, {
      id: 'old-entry', summary: 'update old entry',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'annotate', content: 'new' }],
    }, { id: 'old-entry', scope: 'local', baselineState: noMetadataState, sourceSession: 'current' })
    expect(noMetadataUpdated.entries.memory['m']?.metadata).toEqual({ sourceSession: 'current' })

    const { state: noSource } = applyRefinementProposal(freshState(), {
      id: 'no-source', summary: 'create without metadata',
      edits: [{ action: 'create', kind: 'memory', id: 'm', content: 'x' }],
    }, { id: 'no-source', scope: 'local', baselineState: freshState() })
    expect(noSource.entries.memory['m']).not.toHaveProperty('metadata')
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

describe('full entry snapshots and rollback', () => {
  it('records beforeEntry/afterEntry on update and restores metadata on rollback', () => {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'old title', metadata: { sourceSession: 's1', lifecycleState: 'active' },
    }
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'r1', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'new' }],
    }, { id: 'r1', scope: 'local', baselineState: state })
    const edit = result.appliedEdits[0]!
    expect(edit.applied).toBe(true)
    expect(edit.beforeEntry?.content).toBe('old')
    expect(edit.beforeEntry?.title).toBe('old title')
    expect(edit.afterEntry?.content).toBe('new')
    expect(edit.afterEntry?.version).toBe(2)

    const rollback = rollbackProposal(result)
    expect(rollback.edits[0]).toMatchObject({
      action: 'update', kind: 'memory', id: 'm', content: 'old', title: 'old title',
      metadata: { sourceSession: 's1', lifecycleState: 'active' },
    })
    const { state: reverted } = applyRefinementProposal(next, rollback, {
      id: rollback.id, rollbackOf: result.id, scope: 'local', baselineState: next,
    })
    expect(reverted.entries.memory['m']?.metadata).toEqual({ sourceSession: 's1', lifecycleState: 'active' })
  })

  it('restores metadata when rolling back a delete', () => {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't',
      metadata: { sourceSession: 's2', lifecycleState: 'archived', pinned: true },
    }
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'r-delete', summary: 'delete',
      edits: [{ action: 'delete', kind: 'memory', id: 'm', reason: 'remove' }],
    }, { id: 'r-delete', scope: 'local', baselineState: state })
    const rollback = rollbackProposal(result)
    expect(rollback.edits[0]).toMatchObject({
      action: 'create', id: 'm', content: 'old',
      metadata: { sourceSession: 's2', lifecycleState: 'archived', pinned: true },
    })
    const { state: reverted } = applyRefinementProposal(next, rollback, {
      id: rollback.id, rollbackOf: result.id, scope: 'local', baselineState: next,
    })
    expect(reverted.entries.memory['m']?.metadata).toEqual({ sourceSession: 's2', lifecycleState: 'archived', pinned: true })
  })

  it('flags rollbackDegraded when the source edit lacks full snapshots', () => {
    const legacy: RefinementResult = {
      id: 'r2', summary: 'legacy', scope: 'local', committedAt: 't',
      appliedEdits: [{ action: 'update', kind: 'memory', id: 'm', before: 'old', after: 'new', blastRadius: 'general', applied: true }],
    }
    const rollback = rollbackProposal(legacy)
    expect(rollback.edits[0]).toMatchObject({ action: 'update', kind: 'memory', id: 'm', content: 'old' })
    expect(rollback.edits[0]).toHaveProperty('rollbackDegraded', true)
  })

  it('detects a baseline mismatch on metadata change, not just content', () => {
    const baseline = freshState()
    baseline.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'same', updatedAt: 't' }
    const state = structuredClone(baseline)
    state.entries.memory['m'] = { ...baseline.entries.memory['m']!, metadata: { pinned: true } }
    const { result } = applyRefinementProposal(state, {
      id: 'r3', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'same' }],
    }, { id: 'r3', scope: 'local', baselineState: baseline })
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toBe('entry changed during refinement planning')
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
