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

  it('validateEdit accepts archive/pin edits without content and rejects non-update lifecycle edits', () => {
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'hide' })).toBeUndefined()
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'm', pin: true, reason: 'lock' })).toBeUndefined()
    expect(validateEdit({ action: 'create', kind: 'memory', id: 'm', archive: true, content: 'x' })).toBe('archive/pin only valid on update edits')
    expect(validateEdit({ action: 'delete', kind: 'memory', id: 'm', pin: true, reason: 'remove' })).toBe('archive/pin only valid on update edits')
  })

  it('archives an active entry, bumps version, records snapshots, and rejects re-archive', () => {
    const state = freshState()
    state.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'a1', summary: 'archive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'stale' }],
    }, { id: 'a1', scope: 'local', baselineState: state })
    expect(result.appliedEdits[0]?.applied).toBe(true)
    expect(result.appliedEdits[0]?.reason).toBe('stale')
    expect(result.appliedEdits[0]?.beforeEntry).toEqual(state.entries.memory['m'])
    expect(result.appliedEdits[0]?.beforeEntry?.metadata?.lifecycleState).toBeUndefined()
    expect(result.appliedEdits[0]?.afterEntry?.metadata?.lifecycleState).toBe('archived')
    expect(next.entries.memory['m']?.metadata?.lifecycleState).toBe('archived')
    expect(next.entries.memory['m']?.version).toBe(2)

    const { result: dup } = applyRefinementProposal(next, {
      id: 'a2', summary: 're-archive',
      edits: [{ action: 'update', kind: 'memory', id: 'm', archive: true, reason: 'again' }],
    }, { id: 'a2', scope: 'local', baselineState: next })
    expect(dup.appliedEdits[0]?.applied).toBe(false)
    expect(dup.appliedEdits[0]?.error).toBe('already archived')
  })

  it('pins and unpins an entry with version and snapshots', () => {
    const state = freshState()
    state.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'x', updatedAt: 't' }
    const { result, state: pinned } = applyRefinementProposal(state, {
      id: 'p1', summary: 'pin',
      edits: [{ action: 'update', kind: 'memory', id: 'm', pin: true, reason: 'keep' }],
    }, { id: 'p1', scope: 'local', baselineState: state })
    expect(result.appliedEdits[0]?.applied).toBe(true)
    expect(result.appliedEdits[0]?.reason).toBe('keep')
    expect(result.appliedEdits[0]?.beforeEntry).toEqual(state.entries.memory['m'])
    expect(result.appliedEdits[0]?.afterEntry?.metadata?.pinned).toBe(true)
    expect(pinned.entries.memory['m']?.metadata?.pinned).toBe(true)
    expect(pinned.entries.memory['m']?.version).toBe(2)

    const { result: unpinResult, state: unpinned } = applyRefinementProposal(pinned, {
      id: 'p2', summary: 'unpin',
      edits: [{ action: 'update', kind: 'memory', id: 'm', pin: false, reason: 'release' }],
    }, { id: 'p2', scope: 'local', baselineState: pinned })
    expect(unpinResult.appliedEdits[0]?.applied).toBe(true)
    expect(unpinned.entries.memory['m']?.metadata?.pinned).toBe(false)
    expect(unpinned.entries.memory['m']?.version).toBe(3)
    expect(unpinResult.appliedEdits[0]?.beforeEntry?.metadata?.pinned).toBe(true)
    expect(unpinResult.appliedEdits[0]?.afterEntry?.metadata?.pinned).toBe(false)
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
