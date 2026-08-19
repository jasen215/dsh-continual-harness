import { describe, expect, it } from 'vitest'
import { applyRefinementProposal, freshState, validateEdit } from '../src/refine.ts'

describe('archive/unarchive', () => {
  function archivedState() {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm', kind: 'memory', version: 1, content: 'x', updatedAt: 't',
      metadata: { lifecycleState: 'archived' },
    }
    return state
  }

  it('validateEdit accepts archive/pin edits without content', () => {
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'hide' })).toBeUndefined()
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', pin: true, reason: 'lock' })).toBeUndefined()
  })

  it('archives an active entry, bumps version, and rejects re-archive', () => {
    const state = freshState()
    state.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'a1', summary: 'archive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'stale' }],
    }, { id: 'a1', scope: 'local', baselineState: state })
    expect(result.appliedEdits[0]?.applied).toBe(true)
    expect(next.entries.memory['m']?.metadata?.lifecycleState).toBe('archived')
    expect(next.entries.memory['m']?.version).toBe(2)

    const { result: dup } = applyRefinementProposal(next, {
      id: 'a2', summary: 're-archive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'again' }],
    }, { id: 'a2', scope: 'local', baselineState: next })
    expect(dup.appliedEdits[0]?.applied).toBe(false)
    expect(dup.appliedEdits[0]?.error).toBe('already archived')
  })

  it('unarchives an archived entry and rejects unarchive of an active one', () => {
    const state = archivedState()
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'u1', summary: 'unarchive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: false, reason: 'needed' }],
    }, { id: 'u1', scope: 'local', baselineState: state })
    expect(result.appliedEdits[0]?.applied).toBe(true)
    expect(next.entries.memory['m']?.metadata?.lifecycleState).toBe('active')

    const { result: dup } = applyRefinementProposal(next, {
      id: 'u2', summary: 're-unarchive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: false, reason: 'again' }],
    }, { id: 'u2', scope: 'local', baselineState: next })
    expect(dup.appliedEdits[0]?.applied).toBe(false)
    expect(dup.appliedEdits[0]?.error).toBe('not archived')
  })
})
