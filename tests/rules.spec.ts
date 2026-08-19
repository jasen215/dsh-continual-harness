import { describe, expect, it } from 'vitest'
import {
  applyRefinementProposal,
  freshState,
  rollbackProposal,
  validateEdit,
} from '../src/refine.ts'
import type { HarnessState, RefinementEdit, RefinementProposal } from '../src/types.ts'

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

describe('growth limit rule', () => {
  function memoryState(content: string): HarnessState {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm',
      kind: 'memory',
      version: 1,
      content,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    return state
  }

  function applyGrowth(state: HarnessState, edit: RefinementEdit, maxEntryGrowth?: number) {
    const proposal: RefinementProposal = { id: 'refine_growth', summary: 'growth', edits: [edit] }
    return applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
      ...(maxEntryGrowth === undefined ? {} : { maxEntryGrowth }),
    })
  }

  it('rejects an update exceeding maxEntryGrowth with the exact message', () => {
    const { result } = applyGrowth(
      memoryState('x'.repeat(100)),
      { action: 'update', kind: 'memory', id: 'm', reason: 'grow', content: 'y'.repeat(200) },
      0.5,
    )
    const edit = result.appliedEdits[0]!
    expect(edit.applied).toBe(false)
    expect(edit.error).toBe('条目增长率超过 maxEntryGrowth上限')
    expect(edit.blastRadius).toBe('general')
  })

  it('allows an update exactly at the maxEntryGrowth threshold', () => {
    const { result, state: next } = applyGrowth(
      memoryState('x'.repeat(100)),
      { action: 'update', kind: 'memory', id: 'm', reason: 'grow', content: 'y'.repeat(150) },
      0.5,
    )
    expect(result.appliedEdits[0]!.applied).toBe(true)
    expect(next.entries.memory['m']!.content).toBe('y'.repeat(150))
  })

  it('disables the limit when maxEntryGrowth is 0', () => {
    const { result } = applyGrowth(
      memoryState('x'.repeat(100)),
      { action: 'update', kind: 'memory', id: 'm', reason: 'grow', content: 'y'.repeat(400) },
      0,
    )
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })

  it('skips the check when the old content is empty', () => {
    const { result } = applyGrowth(
      memoryState(''),
      { action: 'update', kind: 'memory', id: 'm', reason: 'grow', content: 'y'.repeat(200) },
      0.5,
    )
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })
})

describe('protected rule', () => {
  function memoryState(protection?: 'bundled' | 'pinned' | 'user-owned'): HarnessState {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm',
      kind: 'memory',
      version: 1,
      content: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(protection === undefined ? {} : { protection }),
    }
    return state
  }

  function applyProtected(state: HarnessState, edit: RefinementEdit, automatic?: boolean) {
    const proposal: RefinementProposal = { id: 'refine_prot', summary: 'protected', edits: [edit] }
    return applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
      ...(automatic === undefined ? {} : { automatic }),
    })
  }

  it('rejects an automatic update of a protected entry with the exact message', () => {
    const { result } = applyProtected(
      memoryState('pinned'),
      { action: 'update', kind: 'memory', id: 'm', reason: 'auto', content: 'new' },
      true,
    )
    const edit = result.appliedEdits[0]!
    expect(edit.applied).toBe(false)
    expect(edit.error).toBe('受保护条目仅显式用户会话可改')
    expect(edit.blastRadius).toBe('general')
  })

  it('rejects an automatic delete of a protected entry', () => {
    const { result } = applyProtected(
      memoryState('pinned'),
      { action: 'delete', kind: 'memory', id: 'm', reason: 'auto' },
      true,
    )
    expect(result.appliedEdits[0]!.applied).toBe(false)
    expect(result.appliedEdits[0]!.error).toBe('受保护条目仅显式用户会话可改')
  })

  it('allows the tool path (automatic false) to edit a protected entry', () => {
    const { result, state: next } = applyProtected(
      memoryState('pinned'),
      { action: 'update', kind: 'memory', id: 'm', reason: 'tool', content: 'new' },
      false,
    )
    expect(result.appliedEdits[0]!.applied).toBe(true)
    expect(next.entries.memory['m']!.content).toBe('new')
  })

  it('allows automatic edits of unprotected entries', () => {
    const { result } = applyProtected(
      memoryState(),
      { action: 'update', kind: 'memory', id: 'm', reason: 'auto', content: 'new' },
      true,
    )
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })
})

describe('local-during-global rule', () => {
  const GLOBAL_ENTRIES: HarnessState['entries'] = {
    prompt: {},
    memory: {
      'global-only': {
        id: 'global-only',
        kind: 'memory',
        version: 3,
        content: 'global',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      shared: {
        id: 'shared',
        kind: 'memory',
        version: 2,
        content: 'global copy',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    skill: {},
    subagent: {},
  }

  function localState(): HarnessState {
    const state = freshState()
    state.entries.memory['shared'] = {
      id: 'shared',
      kind: 'memory',
      version: 1,
      content: 'local copy',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    return state
  }

  function applyLocal(state: HarnessState, edit: RefinementEdit) {
    const proposal: RefinementProposal = { id: 'refine_local', summary: 'local', edits: [edit] }
    return applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
      globalEntries: GLOBAL_ENTRIES,
    })
  }

  it('rejects update of a global-only entry with the exact message', () => {
    const { result } = applyLocal(localState(), {
      action: 'update',
      kind: 'memory',
      id: 'global-only',
      reason: 'why',
      content: 'x',
    })
    expect(result.appliedEdits[0]!.applied).toBe(false)
    expect(result.appliedEdits[0]!.error).toBe('global条目在 local精修期间只读，请创建 local遮蔽条目')
  })

  it('rejects delete of a global-only entry', () => {
    const { result } = applyLocal(localState(), {
      action: 'delete',
      kind: 'memory',
      id: 'global-only',
      reason: 'why',
    })
    expect(result.appliedEdits[0]!.applied).toBe(false)
    expect(result.appliedEdits[0]!.error).toBe('global条目在 local精修期间只读，请创建 local遮蔽条目')
  })

  it('allows create of a global-only id as the local shadow', () => {
    const { result, state: next } = applyLocal(localState(), {
      action: 'create',
      kind: 'memory',
      id: 'global-only',
      content: 'shadow',
    })
    expect(result.appliedEdits[0]!.applied).toBe(true)
    expect(next.entries.memory['global-only']!.content).toBe('shadow')
  })

  it('allows update of an existing local shadow', () => {
    const { result, state: next } = applyLocal(localState(), {
      action: 'update',
      kind: 'memory',
      id: 'shared',
      reason: 'why',
      content: 'new local copy',
    })
    expect(result.appliedEdits[0]!.applied).toBe(true)
    expect(next.entries.memory['shared']!.content).toBe('new local copy')
  })

  it('is inert without globalEntries', () => {
    const state = freshState()
    state.entries.memory['m'] = {
      id: 'm',
      kind: 'memory',
      version: 1,
      content: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const proposal: RefinementProposal = {
      id: 'refine_no_global',
      summary: 'no global entries',
      edits: [{ action: 'update', kind: 'memory', id: 'm', reason: 'why', content: 'new' }],
    }
    const { result } = applyRefinementProposal(state, proposal, {
      id: proposal.id,
      scope: 'local',
      baselineState: state,
    })
    expect(result.appliedEdits[0]!.applied).toBe(true)
  })
})
