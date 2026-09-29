import { describe, expect, it } from 'vitest'
import { applyRefinementProposal, entryFingerprint, freshState, rollbackProposal, touchedSkillIds, validateEdit } from '../src/refine.ts'
import { DEFAULT_SKILL_BUNDLE_LIMITS } from '../src/skills.ts'
import type { BlastRadius, RefinementProposal } from '../src/types.ts'
import type { SkillEntry } from '../src/types.ts'

describe('scope x blastRadius exclusion (3.4.1)', () => {
  const base = freshState()
  const apply = (scope: 'local' | 'global', blastRadius: BlastRadius) => applyRefinementProposal(base, {
    id: 'refine_1', summary: 's',
    edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c', blastRadius }],
  }, { id: 'refine_1', scope, baselineState: base })

  it('rejects general content targeting the local scope', () => {
    const { result } = apply('local', 'general')
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toContain(`'general' cannot target the local scope`)
  })

  it('rejects session content targeting the global scope', () => {
    const { result } = apply('global', 'session')
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toContain(`'session' cannot target the global scope`)
  })

  it('admits the legal pairs, including local+project', () => {
    expect(apply('global', 'general').result.appliedEdits[0]?.applied).toBe(true)
    expect(apply('local', 'session').result.appliedEdits[0]?.applied).toBe(true)
    expect(apply('global', 'project').result.appliedEdits[0]?.applied).toBe(true)
  })

  it('lets a delete omit the reach it cannot have', () => {
    // A delete claims no reach at all, so demanding a declaration would be
    // meaningless. (The replay exemption — a record's general fallback is not a
    // declaration — is covered by the rollback cases in this file.)
    const seeded = applyRefinementProposal(base, {
      id: 'refine_0', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', blastRadius: 'project', content: 'c' }],
    }, { id: 'refine_0', scope: 'local', baselineState: base })
    const { result, state: deleted } = applyRefinementProposal(seeded.state, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'delete', kind: 'memory', id: 'a', reason: 'why' }],
    }, { id: 'refine_1', scope: 'local', baselineState: seeded.state })
    expect(result.appliedEdits[0]?.applied).toBe(true)
    expect(deleted.entries.memory.a).toBeUndefined()
  })

  it('still lets a rollback delete what it must, whatever the record fallback says', () => {
    // An applied record falls back to 'general' when nothing was declared; a
    // rollback must not turn that fallback into a declaration and reject itself.
    const created = applyRefinementProposal(base, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', blastRadius: 'project', content: 'c' }],
    }, { id: 'refine_1', scope: 'local', baselineState: base })
    const { state, result } = applyRefinementProposal(created.state, rollbackProposal(created.result), {
      id: 'rollback_refine_1', scope: 'local', baselineState: created.state,
    })
    expect(result.appliedEdits[0]?.error).toBeUndefined()
    expect(state.entries.memory.a).toBeUndefined()
  })
})

describe('blastRadius reaches the entry it writes (gap 9)', () => {
  const state0 = freshState()
  const opts = { id: 'refine_1', scope: 'global' as const, baselineState: state0 }

  it('stamps a declared blastRadius onto a created entry', () => {
    const { state } = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c', blastRadius: 'project' }],
    }, opts)
    expect(state.entries.memory.a?.blastRadius).toBe('project')
  })

  it('stamps a declared blastRadius onto an updated entry', () => {
    const { state: created } = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c', blastRadius: 'project' }],
    }, opts)
    const updated = applyRefinementProposal(created, {
      id: 'refine_2', summary: 's',
      edits: [{ action: 'update', kind: 'memory', id: 'a', content: 'c2', blastRadius: 'session', reason: 'why' }],
    }, { id: 'refine_2', scope: 'local', baselineState: created })
    // Without this the rejection path would look identical to a missing stamp.
    expect(updated.result.appliedEdits[0]?.applied).toBe(true)
    expect(updated.state.entries.memory.a?.blastRadius).toBe('session')
  })

  it('rejects an edit that omits blastRadius instead of defaulting one', () => {
    const { result } = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c' }],
    }, opts)
    // 3.4.1: an omission is a missing declaration, not 'unspecified', so nothing
    // may be inferred on the writer's behalf.
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toContain('missing blastRadius')
  })

  it('rejects an explicit null blastRadius like any other non-declaration', () => {
    const { result } = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c', blastRadius: null as unknown as BlastRadius }],
    }, opts)
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toContain('invalid blastRadius')
  })

  it('stamps the declared reach on an archive edit too', () => {
    const { state: created } = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'c', blastRadius: 'project' }],
    }, opts)
    const archived = applyRefinementProposal(created, {
      id: 'refine_2', summary: 's',
      edits: [{ action: 'update', kind: 'memory', id: 'a', reason: 'hide', archive: true, blastRadius: 'session' }],
    }, { id: 'refine_2', scope: 'local', baselineState: created })
    // The validator forces a declaration on this edit, so dropping it would
    // leave the entry and the journal disagreeing about the reach.
    expect(archived.result.appliedEdits[0]?.applied).toBe(true)
    expect(archived.state.entries.memory.a?.blastRadius).toBe('session')
    expect(archived.state.entries.memory.a?.metadata?.lifecycleState).toBe('archived')
  })

  it('carries the declaration through rollback instead of dropping it', () => {
    const first = applyRefinementProposal(state0, {
      id: 'refine_1', summary: 's',
      edits: [{ action: 'create', kind: 'memory', id: 'a', content: 'v1', blastRadius: 'project' }],
    }, opts)
    const second = applyRefinementProposal(first.state, {
      id: 'refine_2', summary: 's',
      edits: [{ action: 'update', kind: 'memory', id: 'a', content: 'v2', blastRadius: 'session', reason: 'why' }],
    }, { id: 'refine_2', scope: 'local', baselineState: first.state })
    expect(second.result.appliedEdits[0]?.applied).toBe(true)
    expect(second.state.entries.memory.a?.blastRadius).toBe('session')
    // Rolling the update back must restore the earlier reach, not leave the
    // later one in place: an entry's reach is part of what rollback restores.
    const { state: reverted } = applyRefinementProposal(second.state, rollbackProposal(second.result), {
      id: 'rollback_refine_2', scope: 'local', baselineState: second.state,
    })
    expect(reverted.entries.memory.a?.blastRadius).toBe('project')
  })
})

const tinyLimits = { maxSkillFiles: 1, maxSkillFileBytes: 16, maxSkillBundleBytes: 64 }

describe('validateEdit', () => {
  it('accepts a well-formed create edit', () => {
    expect(validateEdit({ action: 'create', kind: 'memory', id: 'deploy-failure', blastRadius: 'project', content: 'remember to pin versions' }))
      .toBeUndefined()
  })

  it('rejects unknown kinds and actions', () => {
    expect(validateEdit({ action: 'create', kind: 'bogus', id: 'x', blastRadius: 'project', content: 'y' })).toContain('unknown kind')
    expect(validateEdit({ action: 'rename', kind: 'memory', id: 'x', content: 'y' })).toContain('unknown action')
  })

  it('treats the base system prompt as immutable', () => {
    expect(validateEdit({ action: 'update', kind: 'prompt', id: 'base_system_prompt', blastRadius: 'project', content: 'x' }))
      .toBe('the base system prompt is immutable')
  })

  it('validates skill edits: kebab-case id, content required, description optional', () => {
    expect(validateEdit({ action: 'create', kind: 'skill', id: 'Not Kebab', blastRadius: 'project', content: 'c' })).toContain('kebab-case')
    expect(validateEdit({ action: 'create', kind: 'skill', id: 's', blastRadius: 'project', content: 'c', description: 'summary' }))
      .toBeUndefined()
    expect(validateEdit({ action: 'delete', kind: 'skill', id: 's', blastRadius: 'project', reason: 'why' })).toBeUndefined()
    // legacy python-contract fields remain tolerated for state compatibility
    expect(validateEdit({ action: 'create', kind: 'skill', id: 's', blastRadius: 'project', content: 'c', reference: 'r', arguments: '{}' }))
      .toBeUndefined()
  })

  it('requires content for non-delete edits', () => {
    expect(validateEdit({ action: 'update', kind: 'memory', id: 'x', blastRadius: 'project', reason: 'why' })).toContain('content')
  })
})

describe('applyRefinementProposal', () => {
  const proposal: RefinementProposal = {
    id: 'refine_1',
    summary: 'remember the pattern',
    edits: [
      { action: 'create', kind: 'memory', id: 'pin-versions', blastRadius: 'project', content: 'always pin versions' },
      { action: 'create', kind: 'skill', id: 'repro', blastRadius: 'project', content: 'repro skill', description: 'reproduce a bug fast' },
      { action: 'update', kind: 'memory', id: 'missing', blastRadius: 'project', reason: 'why', content: 'x' },
      { action: 'delete', kind: 'memory', id: 'stale', blastRadius: 'project', reason: 'why', content: '' },
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

  it('persists titles on create and explicit update', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 'title-create', summary: 'title',
      edits: [{ action: 'create', kind: 'memory', id: 'titled', blastRadius: 'project', content: 'x', title: 'Original title' }],
    }, { id: 'title-create', scope: 'local', baselineState: state })
    expect(created.entries.memory['titled']?.title).toBe('Original title')

    const { state: updated } = applyRefinementProposal(created, {
      id: 'title-update', summary: 'rename',
      edits: [{ action: 'update', kind: 'memory', id: 'titled', blastRadius: 'project', reason: 'clarify', content: 'y', title: 'Updated title' }],
    }, { id: 'title-update', scope: 'local', baselineState: created })
    expect(updated.entries.memory['titled']?.title).toBe('Updated title')
  })

  it('stamps sourceSession on create and preserves it on update', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 's1', summary: 'create',
      edits: [{ action: 'create', kind: 'memory', id: 'm', blastRadius: 'project', content: 'x' }],
    }, { id: 's1', scope: 'local', baselineState: state, sourceSession: 'session-9' })
    expect(created.entries.memory['m']?.metadata?.sourceSession).toBe('session-9')

    const { state: updated } = applyRefinementProposal(created, {
      id: 's2', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', reason: 'why', content: 'y' }],
    }, { id: 's2', scope: 'local', baselineState: created, sourceSession: 'session-9' })
    expect(updated.entries.memory['m']?.metadata?.sourceSession).toBe('session-9')
    expect(updated.entries.memory['m']?.content).toBe('y')
  })

  it('honors edit metadata precedence and sourceSession edge cases', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 'precedence-create', summary: 'create historical',
      edits: [{
        action: 'create', kind: 'memory', id: 'historical', content: 'x', blastRadius: 'project',
        metadata: { sourceSession: 'historical' },
      }],
    }, {
      id: 'precedence-create', scope: 'local', baselineState: state, sourceSession: 'current',
    })
    expect(created.entries.memory['historical']?.metadata?.sourceSession).toBe('historical')

    const { state: updated } = applyRefinementProposal(created, {
      id: 'precedence-update', summary: 'update historical',
      edits: [{
        action: 'update', kind: 'memory', id: 'historical', reason: 'restore', content: 'y', blastRadius: 'project',
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
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', archive: true }],
    }, { id: 'archive', scope: 'local', baselineState: archiveState, sourceSession: 'current' })
    expect(archived.entries.memory['m']?.metadata?.sourceSession).toBe('original')

    const pinState = freshState()
    pinState.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't' }
    const { state: pinned } = applyRefinementProposal(pinState, {
      id: 'pin', summary: 'pin',
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', pin: true }],
    }, { id: 'pin', scope: 'local', baselineState: pinState, sourceSession: 'current' })
    expect(pinned.entries.memory['m']?.metadata?.sourceSession).toBeUndefined()

    const noMetadataState = freshState()
    noMetadataState.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't' }
    const { state: noMetadataUpdated } = applyRefinementProposal(noMetadataState, {
      id: 'old-entry', summary: 'update old entry',
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', reason: 'annotate', content: 'new' }],
    }, { id: 'old-entry', scope: 'local', baselineState: noMetadataState, sourceSession: 'current' })
    expect(noMetadataUpdated.entries.memory['m']?.metadata).toEqual({ sourceSession: 'current' })

    const { state: noSource } = applyRefinementProposal(freshState(), {
      id: 'no-source', summary: 'create without metadata',
      edits: [{ action: 'create', kind: 'memory', id: 'm', blastRadius: 'project', content: 'x' }],
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
      edits: [{ action: 'update', kind: 'memory', id: 'pin-versions', blastRadius: 'project', reason: 'why', content: 'newest' }],
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
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', reason: 'why', content: 'new' }],
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
      edits: [{ action: 'delete', kind: 'memory', id: 'm', blastRadius: 'project', reason: 'remove' }],
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

  it('persists a conclusion-only record in the state while the result keeps full snapshots', () => {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm', kind: 'memory', version: 1, content: 'old', updatedAt: 't',
      title: 'old title', metadata: { sourceSession: 's1' },
    }
    const { result, state: next } = applyRefinementProposal(state, {
      id: 'r-strip', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'why', blastRadius: 'project', content: 'new' }],
    }, { id: 'r-strip', scope: 'local', baselineState: state })
    // The in-memory result keeps the snapshots (rollback/diagnostics use them).
    expect(result.appliedEdits[0]).toMatchObject({ applied: true, reason: 'why', blastRadius: 'project' })
    expect(result.appliedEdits[0]?.beforeEntry?.content).toBe('old')
    expect(result.appliedEdits[0]?.beforeEntry?.title).toBe('old title')
    expect(result.appliedEdits[0]?.afterEntry?.content).toBe('new')
    // The persisted state copy records only the conclusion + edit metadata.
    const persisted = next.refinements[0]!
    const edit = persisted.appliedEdits[0]!
    expect(persisted.summary).toBe('update')
    expect(edit).toMatchObject({ action: 'update', kind: 'memory', id: 'm', applied: true, reason: 'why', blastRadius: 'project' })
    expect(edit.before).toBeUndefined()
    expect(edit.after).toBeUndefined()
    expect(edit.beforeEntry).toBeUndefined()
    expect(edit.afterEntry).toBeUndefined()
  })

  it('detects a baseline mismatch on skill persisted fields', () => {
    const baseline = freshState()
    baseline.entries.skill['skill'] = {
      id: 'skill', kind: 'skill', version: 1, content: 'same', updatedAt: 't',
      description: 'old description', reference: 'old reference', arguments: 'old arguments',
    }
    const state = structuredClone(baseline)
    state.entries.skill['skill'] = { ...baseline.entries.skill['skill']!, reference: 'new reference' }
    const { result } = applyRefinementProposal(state, {
      id: 'r-skill-fields', summary: 'update',
      edits: [{ action: 'update', kind: 'skill', id: 'skill', blastRadius: 'project', reason: 'why', content: 'same' }],
    }, { id: 'r-skill-fields', scope: 'local', baselineState: baseline })
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toBe('entry changed during refinement planning')
  })

  it('detects a baseline mismatch on metadata change, not just content', () => {
    const baseline = freshState()
    baseline.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'same', updatedAt: 't' }
    const state = structuredClone(baseline)
    state.entries.memory['m'] = { ...baseline.entries.memory['m']!, metadata: { pinned: true } }
    const { result } = applyRefinementProposal(state, {
      id: 'r3', summary: 'update',
      edits: [{ action: 'update', kind: 'memory', id: 'm', blastRadius: 'project', reason: 'why', content: 'same' }],
    }, { id: 'r3', scope: 'local', baselineState: baseline })
    expect(result.appliedEdits[0]?.applied).toBe(false)
    expect(result.appliedEdits[0]?.error).toBe('entry changed during refinement planning')
  })

  it('rejects every edit on a protected kind on the automatic path', () => {
    const state = freshState()
    state.entries.skill['existing'] = {
      id: 'existing', kind: 'skill', version: 1, content: 'old body', updatedAt: 't',
    }
    const { result } = applyRefinementProposal(state, {
      id: 'auto-protected', summary: 'auto skill edit',
      edits: [
        { action: 'create', kind: 'skill', id: 'new-skill', blastRadius: 'project', content: 'body' },
        { action: 'update', kind: 'skill', id: 'existing', blastRadius: 'project', reason: 'auto', content: 'tampered' },
        { action: 'delete', kind: 'skill', id: 'existing', blastRadius: 'project', reason: 'auto' },
      ],
    }, {
      id: 'auto-protected', scope: 'local', baselineState: state,
      protectedKinds: ['skill'], automatic: true,
    })
    expect(result.appliedEdits.every(edit => !edit.applied)).toBe(true)
    expect(result.appliedEdits.map(edit => edit.error)).toEqual([
      'kind skill is protected from automatic refinement',
      'kind skill is protected from automatic refinement',
      'kind skill is protected from automatic refinement',
    ])
    // the explicit (non-automatic) tool path may still edit the kind
    const manual = applyRefinementProposal(state, {
      id: 'manual-skill', summary: 'manual skill edit',
      edits: [{ action: 'create', kind: 'skill', id: 'new-skill', blastRadius: 'project', content: 'body' }],
    }, { id: 'manual-skill', scope: 'local', baselineState: state, protectedKinds: ['skill'] })
    expect(manual.result.appliedEdits[0]?.applied).toBe(true)
  })

  it('rejects a protected kind even when the entry itself is unprotected', () => {
    const state = freshState()
    const { result } = applyRefinementProposal(state, {
      id: 'auto-protected-2', summary: 'auto create',
      edits: [{ action: 'create', kind: 'skill', id: 'unprotected-skill', blastRadius: 'project', content: 'body' }],
    }, {
      id: 'auto-protected-2', scope: 'local', baselineState: state,
      protectedKinds: ['skill'], automatic: true,
    })
    expect(result.appliedEdits[0]).toMatchObject({ applied: false, error: 'kind skill is protected from automatic refinement' })
  })

  it('applies skill description/reference/arguments on update', () => {
    const state = freshState()
    state.entries.skill['s'] = {
      id: 's', kind: 'skill', version: 1, content: 'body', updatedAt: 't',
      description: 'stale desc', reference: 'old ref', arguments: 'old args',
    }
    const { state: next } = applyRefinementProposal(state, {
      id: 'u', summary: 'refresh skill',
      edits: [{
        action: 'update', kind: 'skill', id: 's', reason: 'refresh', blastRadius: 'project',
        content: 'new body', description: 'fresh desc', reference: 'new ref', arguments: '{"a":1}',
      }],
    }, { id: 'u', scope: 'local', baselineState: state })
    expect(next.entries.skill['s']).toMatchObject({
      content: 'new body',
      description: 'fresh desc',
      reference: 'new ref',
      arguments: '{"a":1}',
    })
  })

  it('applies protection on skill update', () => {
    const state = freshState()
    state.entries.skill['s'] = {
      id: 's', kind: 'skill', version: 1, content: 'body', updatedAt: 't', protection: 'pinned',
    }
    const { state: next } = applyRefinementProposal(state, {
      id: 'u-protection', summary: 'update protection',
      edits: [{ action: 'update', kind: 'skill', id: 's', blastRadius: 'project', reason: 'restore', content: 'new body', protection: 'user-owned' }],
    }, { id: 'u-protection', scope: 'local', baselineState: state })
    expect(next.entries.skill['s']?.protection).toBe('user-owned')
  })

  it('restores full skill fields (description/reference/arguments/protection) when rolling back a delete', () => {
    const state = freshState()
    state.entries.skill['s'] = {
      id: 's', kind: 'skill', version: 1, content: 'body', updatedAt: 't',
      description: 'desc', reference: 'ref', arguments: '{"a":1}', protection: 'user-owned',
      title: 'Skill title',
    }
    const { result, state: deleted } = applyRefinementProposal(state, {
      id: 'd', summary: 'delete skill',
      edits: [{ action: 'delete', kind: 'skill', id: 's', blastRadius: 'project', reason: 'remove' }],
    }, { id: 'd', scope: 'local', baselineState: state })
    const rollback = rollbackProposal(result)
    expect(rollback.edits[0]).toMatchObject({
      action: 'create', id: 's', content: 'body',
      description: 'desc', reference: 'ref', arguments: '{"a":1}', protection: 'user-owned',
    })
    const { state: reverted } = applyRefinementProposal(deleted, rollback, {
      id: rollback.id, rollbackOf: result.id, scope: 'local', baselineState: deleted,
    })
    expect(reverted.entries.skill['s']).toMatchObject({
      content: 'body',
      description: 'desc',
      reference: 'ref',
      arguments: '{"a":1}',
      protection: 'user-owned',
    })
  })

  it('restores the skill description when rolling back an update', () => {
    const state = freshState()
    state.entries.skill['s'] = {
      id: 's', kind: 'skill', version: 1, content: 'body', updatedAt: 't', description: 'original desc',
    }
    const { result, state: updated } = applyRefinementProposal(state, {
      id: 'u', summary: 'update skill',
      edits: [{
        action: 'update', kind: 'skill', id: 's', reason: 'refresh', blastRadius: 'project',
        content: 'new body', description: 'changed desc',
      }],
    }, { id: 'u', scope: 'local', baselineState: state })
    const rollback = rollbackProposal(result)
    const { state: reverted } = applyRefinementProposal(updated, rollback, {
      id: rollback.id, rollbackOf: result.id, scope: 'local', baselineState: updated,
    })
    expect(reverted.entries.skill['s']).toMatchObject({ content: 'body', description: 'original desc' })
  })

  it('documents set-if-present rollback: a field an update introduced survives rollback', () => {
    const state = freshState()
    state.entries.skill['s'] = { id: 's', kind: 'skill', version: 1, content: 'body', updatedAt: 't' }
    const { result, state: updated } = applyRefinementProposal(state, {
      id: 'u', summary: 'add description',
      edits: [{ action: 'update', kind: 'skill', id: 's', blastRadius: 'project', reason: 'add desc', content: 'new body', description: 'added desc' }],
    }, { id: 'u', scope: 'local', baselineState: state })
    expect(updated.entries.skill['s']?.description).toBe('added desc')
    const rollback = rollbackProposal(result)
    const { state: reverted } = applyRefinementProposal(updated, rollback, {
      id: rollback.id, rollbackOf: result.id, scope: 'local', baselineState: updated,
    })
    // update semantics are set-if-present, so the rollback restores
    // content/title/metadata but cannot remove the description the update
    // introduced (the edit model has no field-clearing action)
    expect(reverted.entries.skill['s']?.content).toBe('body')
    expect(reverted.entries.skill['s']?.description).toBe('added desc')
  })
})

describe('validateEdit with bundle files', () => {
  it('rejects a skill edit whose files fail bundle validation', () => {
    const edit = { action: 'create', kind: 'skill' as const, id: 's', blastRadius: 'project' as const, content: 'c', files: { '../evil': 'x' } }
    expect(validateEdit(edit, { skillBundleLimits: DEFAULT_SKILL_BUNDLE_LIMITS })).toContain('invalid path segment')
    expect(validateEdit({ ...edit, files: { 'scripts/a.py': 'x', 'scripts/b.py': 'y' } }, { skillBundleLimits: tinyLimits }))
      .toContain('maxSkillFiles')
  })

  it('accepts a skill edit with valid files', () => {
    expect(validateEdit(
      { action: 'create', kind: 'skill', id: 's', blastRadius: 'project', content: 'c', files: { 'scripts/x.py': 'print(1)' } },
      { skillBundleLimits: DEFAULT_SKILL_BUNDLE_LIMITS },
    )).toBeUndefined()
  })
})

describe('applyRefinementProposal project stamping', () => {
  const create: RefinementProposal = {
    id: 'refine_p1',
    summary: 'learn something here',
    edits: [{ action: 'create', kind: 'memory', id: 'local-trick', blastRadius: 'project', content: 'the trick' }],
  }

  it('tags a created entry with the project the commit came from', () => {
    const state = freshState()
    const { state: next } = applyRefinementProposal(state, create, {
      id: create.id,
      scope: 'global',
      baselineState: state,
      project: 'dsh-continual-harness',
    })
    expect(next.entries.memory['local-trick']?.projects).toEqual(['dsh-continual-harness'])
  })

  it('leaves entries untagged when the caller has no project, so replays stay machine-independent', () => {
    const state = freshState()
    const { state: next } = applyRefinementProposal(state, create, { id: create.id, scope: 'global', baselineState: state })
    expect(next.entries.memory['local-trick']?.projects).toBeUndefined()
  })

  it('unions a second project instead of replacing the first, so the lesson serves both', () => {
    const state = freshState()
    const once = applyRefinementProposal(state, create, { id: create.id, scope: 'global', baselineState: state, project: 'repo-a' }).state
    const twice = applyRefinementProposal(once, {
      id: 'refine_p2',
      summary: 'same lesson, other repo',
      edits: [{ action: 'update', kind: 'memory', id: 'local-trick', blastRadius: 'project', reason: 'sharpened here', content: 'the trick, sharpened' }],
    }, { id: 'refine_p2', scope: 'global', baselineState: once, project: 'repo-b' }).state
    expect(twice.entries.memory['local-trick']?.projects).toEqual(['repo-a', 'repo-b'])
  })
})

describe('applyRefinementProposal with files', () => {
  it('persists files on create and replaces them on update', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 'r1', summary: 's',
      edits: [{ action: 'create', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', files: { 'scripts/x.py': 'v1' } }],
    }, { id: 'r1', scope: 'local', baselineState: state })
    expect((created.entries.skill['oq'] as SkillEntry).files).toEqual({ 'scripts/x.py': 'v1' })

    const { state: updated } = applyRefinementProposal(created, {
      id: 'r2', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body2', reason: 'why', files: { 'scripts/x.py': 'v2' } }],
    }, { id: 'r2', scope: 'local', baselineState: created })
    expect((updated.entries.skill['oq'] as SkillEntry).files).toEqual({ 'scripts/x.py': 'v2' })
  })

  it('clears files on update with {} and keeps them when files is absent', () => {
    const state = freshState()
    const { state: created } = applyRefinementProposal(state, {
      id: 'r1', summary: 's',
      edits: [{ action: 'create', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', files: { 'scripts/x.py': 'v1' } }],
    }, { id: 'r1', scope: 'local', baselineState: state })
    const { state: cleared } = applyRefinementProposal(created, {
      id: 'r2', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', reason: 'why', files: {} }],
    }, { id: 'r2', scope: 'local', baselineState: created })
    expect((cleared.entries.skill['oq'] as SkillEntry).files).toEqual({})
    const { state: kept } = applyRefinementProposal(cleared, {
      id: 'r3', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', reason: 'why' }],
    }, { id: 'r3', scope: 'local', baselineState: cleared })
    expect((kept.entries.skill['oq'] as SkillEntry).files).toEqual({})
  })

  it('includes files in the entry fingerprint so content-identical file changes conflict', () => {
    const state = freshState()
    const { state: first } = applyRefinementProposal(state, {
      id: 'r1', summary: 's',
      edits: [{ action: 'create', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', files: { 'scripts/x.py': 'v1' } }],
    }, { id: 'r1', scope: 'local', baselineState: state })
    const { state: second } = applyRefinementProposal(first, {
      id: 'r2', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', reason: 'why', files: { 'scripts/x.py': 'v2' } }],
    }, { id: 'r2', scope: 'local', baselineState: first })
    // a stale plan built against `first` must now be rejected against `second`
    const stale = applyRefinementProposal(second, {
      id: 'r3', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', reason: 'why', files: { 'scripts/x.py': 'v2' } }],
    }, { id: 'r3', scope: 'local', baselineState: first })
    expect(stale.result.appliedEdits.find(edit => edit.id === 'oq')?.error).toBe('entry changed during refinement planning')
  })

  it('restores and clears files through rollback (full entry replacement)', () => {
    const state = freshState()
    const { state: created, result: createResult } = applyRefinementProposal(state, {
      id: 'r1', summary: 's',
      edits: [{ action: 'create', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'body', files: { 'scripts/x.py': 'v1' } }],
    }, { id: 'r1', scope: 'local', baselineState: state })
    // update adds nothing to files, then rollback of the create must drop files entirely
    const rollback = rollbackProposal(createResult)
    expect(rollback.edits[0]?.action).toBe('delete')
    const { state: restored } = applyRefinementProposal(created, rollback, {
      id: rollback.id, scope: 'local', baselineState: created,
    })
    expect(restored.entries.skill['oq']).toBeUndefined()

    // an update that introduces files must roll back to a files-less entry
    const before = freshState()
    before.entries.skill['oq'] = { id: 'oq', kind: 'skill', version: 1, content: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }
    const { state: added, result: addResult } = applyRefinementProposal(before, {
      id: 'r2', summary: 's',
      edits: [{ action: 'update', kind: 'skill', id: 'oq', blastRadius: 'project', content: 'new', reason: 'why', files: { 'scripts/x.py': 'v1' } }],
    }, { id: 'r2', scope: 'local', baselineState: before })
    expect((added.entries.skill['oq'] as SkillEntry).files).toEqual({ 'scripts/x.py': 'v1' })
    const rollback2 = rollbackProposal(addResult)
    const { state: undone } = applyRefinementProposal(added, rollback2, {
      id: rollback2.id, rollbackOf: addResult.id, scope: 'local', baselineState: added,
    })
    const undoneEntry = undone.entries.skill['oq'] as SkillEntry
    expect(undoneEntry.content).toBe('old')
    expect(undoneEntry.files).toEqual({})
  })

  it('applies the editGate veto and records it as a failed edit', () => {
    const state = freshState()
    const { result } = applyRefinementProposal(state, {
      id: 'r1', summary: 's',
      edits: [{ action: 'create', kind: 'skill', id: 'taken', blastRadius: 'project', content: 'body' }],
    }, {
      id: 'r1', scope: 'local', baselineState: state,
      editGate: edit => edit.id === 'taken' ? 'skill directory exists and is not harness-owned; pick another id' : undefined,
    })
    const failed = result.appliedEdits.find(edit => edit.id === 'taken')
    expect(failed?.applied).toBe(false)
    expect(failed?.error).toContain('not harness-owned')
  })
})

describe('rollbackProposal', () => {
  it('persists rollbackDegraded on the applied rollback record', () => {
    const state = freshState()
    state.entries.memory['m'] = { id: 'm', kind: 'memory', version: 1, content: 'new', updatedAt: 't' }
    const legacy: RefinementResult = {
      id: 'legacy-r', summary: 'legacy', scope: 'local', committedAt: 't',
      appliedEdits: [{ action: 'update', kind: 'memory', id: 'm', before: 'old', after: 'new', blastRadius: 'general', applied: true }],
    }
    const rollback = rollbackProposal(legacy)
    const { result } = applyRefinementProposal(state, rollback, {
      id: rollback.id, rollbackOf: legacy.id, scope: 'local', baselineState: state,
    })
    expect(result.appliedEdits[0]).toMatchObject({ applied: true, rollbackDegraded: true })
  })

  it('reverses applied edits in reverse order', () => {
    const state = freshState()
    const proposal: RefinementProposal = {
      id: 'refine_3',
      summary: 'two creates',
      edits: [
        { action: 'create', kind: 'memory', id: 'a', blastRadius: 'project', content: 'A' },
        { action: 'create', kind: 'memory', id: 'b', blastRadius: 'project', content: 'B' },
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

describe('touchedSkillIds', () => {
  it('returns applied skill edit ids in order, deduplicated', () => {
    expect(touchedSkillIds([
      { applied: true, kind: 'skill', id: 's1' },
      { applied: false, kind: 'skill', id: 'rejected' },
      { applied: true, kind: 'skill', id: 's1' },
      { applied: true, kind: 'memory', id: 'm1' },
      { applied: true, kind: 'skill', id: 's2' },
    ])).toEqual(['s1', 's2'])
  })
})

describe('entryFingerprint covers the persisted reach', () => {
  it('changes when only blastRadius changes', () => {
    // The fingerprint is the baseline-conflict key: a mutable field missing from
    // it means a stale plan can silently overwrite a concurrent declaration.
    const base = { id: 'm', kind: 'memory' as const, version: 1, content: 'c', updatedAt: 't' }
    expect(entryFingerprint({ ...base, blastRadius: 'project' }))
      .not.toBe(entryFingerprint({ ...base, blastRadius: 'session' }))
  })
})
