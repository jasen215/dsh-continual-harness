import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Complete } from '../src/planner.ts'
import { freshState } from '../src/refine.ts'
import { HarnessStore } from '../src/store.ts'
import { createRefineCoordinator } from '../src/coordinator.ts'
import type {
  HarnessScope,
  HarnessState,
  MaterializationResult,
  RefinementProposal,
  RefinementResult,
} from '../src/types.ts'
import type { PlanRequest } from '../src/coordinator.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-coordinator-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function agent(id = 'coordinator-agent'): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: undefined as never,
    get status() { return 'running' as const },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

function emptyState(): HarnessState {
  return {
    schemaVersion: 1,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  }
}

function emptyMaterialization(): MaterializationResult {
  return { status: 'completed', written: [], unchanged: [], skipped: [], staleCandidates: [], errors: [] }
}

function refinementResult(id: string): RefinementResult & { materialization: MaterializationResult } {
  return {
    id,
    summary: id,
    appliedEdits: [],
    committedAt: new Date().toISOString(),
    scope: 'local',
    materialization: emptyMaterialization(),
  }
}

function cannedComplete(reply: RefinementProposal | string): Complete {
  return async () => typeof reply === 'string' ? reply : JSON.stringify(reply)
}

function planRequest(scope: HarnessScope, source: 'tool' | 'command', instructions?: string): PlanRequest {
  return { mode: 'plan', agent: agent(), scope, source, ...(instructions === undefined ? {} : { instructions }) }
}

function fakeStore(onApply?: () => void): HarnessStore {
  return {
    localState: vi.fn(() => emptyState()),
    globalState: vi.fn(() => emptyState()),
    history: vi.fn(() => []),
    trajectory: vi.fn(() => ''),
    applyRefinement: vi.fn(() => {
      onApply?.()
      return refinementResult('fake')
    }),
  } as unknown as HarnessStore
}

function realStoreWithHistory(): { store: HarnessStore; agent: Agent } {
  const ctx = new Context()
  const home = tempHome()
  const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
  const liveAgent = agent('history-agent')
  store.applyRefinement(liveAgent, { id: 'seed', summary: 'seed', edits: [] }, {})
  return { store, agent: liveAgent }
}

function delayedStore(): HarnessStore & {
  commitOrder(): string[]
  plannerOverlap(): number
  plannerStart(): void
  plannerEnd(): void
  commitOverlap(): number
} {
  const order: string[] = []
  let activePlanner = 0
  let maxPlanner = 0
  let activeCommit = 0
  let maxCommit = 0
  const store = fakeStore(() => {}) as HarnessStore & {
    commitOrder(): string[]
    plannerOverlap(): number
    commitOverlap(): number
  }
  store.applyRefinement = vi.fn(async (_agent, plan) => {
    activeCommit += 1
    maxCommit = Math.max(maxCommit, activeCommit)
    order.push(plan.id)
    await Promise.resolve()
    activeCommit -= 1
    return refinementResult(plan.id)
  })
  store.commitOrder = () => order
  store.plannerOverlap = () => maxPlanner
  store.plannerStart = () => { activePlanner += 1; maxPlanner = Math.max(maxPlanner, activePlanner) }
  store.plannerEnd = () => { activePlanner -= 1 }
  store.commitOverlap = () => maxCommit
  return store
}

describe('createRefineCoordinator', () => {
  it('rejects automatic requests without automaticContext', async () => {
    const calls = { planner: 0, store: 0 }
    const coordinator = createRefineCoordinator({
      store: fakeStore(() => { calls.store += 1 }),
      completeFor: async () => { calls.planner += 1; return '{}' },
    })
    const result = await coordinator.execute({
      mode: 'plan', source: 'automatic', scope: 'local', agent: agent(),
    } as never)
    expect(result).toMatchObject({
      commitStatus: 'not-committed',
      approval: 'not-required',
      appliedCount: 0,
      rejectedCount: 0,
      failedAt: 'validation',
      error: { code: 'invalid-request' },
    })
    expect(calls).toEqual({ planner: 0, store: 0 })
  })

  it('returns an empty no-op without calling Store', async () => {
    const store = fakeStore()
    const coordinator = createRefineCoordinator({ store, completeFor: () => cannedComplete({ id: 'p', summary: 'none', edits: [] }) })
    const result = await coordinator.execute(planRequest('local', 'tool'))
    expect(result).toMatchObject({ commitStatus: 'not-committed', appliedCount: 0, rejectedCount: 0 })
    expect(store.localState).toHaveBeenCalledTimes(1)
    expect(store.globalState).toHaveBeenCalledTimes(1)
    expect(store.history).toHaveBeenCalledTimes(1)
    expect(store.trajectory).toHaveBeenCalledTimes(1)
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('rejects rollback requests with a non-string rollbackId', async () => {
    const store = fakeStore()
    const coordinator = createRefineCoordinator({ store, completeFor: cannedComplete('{}') })
    const result = await coordinator.execute({
      mode: 'rollback', source: 'tool', scope: 'local', agent: agent(), rollbackId: 42,
    } as never)
    expect(result).toMatchObject({
      commitStatus: 'not-committed', approval: 'not-required', appliedCount: 0, rejectedCount: 0,
      failedAt: 'validation', error: { code: 'invalid-request' },
    })
    expect(store.localState).not.toHaveBeenCalled()
    expect(store.globalState).not.toHaveBeenCalled()
    expect(store.history).not.toHaveBeenCalled()
    expect(store.trajectory).not.toHaveBeenCalled()
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('real-store fixture records a seed refinement', () => {
    const { store, agent: liveAgent } = realStoreWithHistory()
    expect(store.history(liveAgent)).toHaveLength(1)
    expect(store.history(liveAgent)[0]?.id).toBe('seed')
  })

  it('rejects a missing rollback target without planner, approval, or Store calls', async () => {
    const store = fakeStore(() => {})
    const complete = vi.fn(cannedComplete('{}'))
    const result = await createRefineCoordinator({ store, completeFor: () => complete }).execute({
      mode: 'rollback', source: 'tool', scope: 'local', rollbackId: 'missing', agent: agent(),
    })
    expect(result.error).toMatchObject({ code: 'rollback-target-not-found' })
    expect(complete).not.toHaveBeenCalled()
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('rejects scope mismatch and a second rollback', async () => {
    const { store, agent: liveAgent } = realStoreWithHistory()
    const coordinator = createRefineCoordinator({ store, completeFor: () => cannedComplete('{}') })
    const mismatch = await coordinator.execute({ mode: 'rollback', source: 'tool', scope: 'global', rollbackId: 'seed', agent: liveAgent })
    expect(mismatch.error?.code).toBe('rollback-scope-mismatch')
    const first = await coordinator.execute({ mode: 'rollback', source: 'tool', scope: 'local', rollbackId: 'seed', agent: liveAgent })
    expect(first.commitStatus).toBe('committed')
    const second = await coordinator.execute({ mode: 'rollback', source: 'tool', scope: 'local', rollbackId: 'seed', agent: liveAgent })
    expect(second.error?.code).toBe('rollback-already-rolled-back')
  })

  it('serializes same-scope commits while allowing concurrent planner work outside the lock', async () => {
    const store = delayedStore()
    let sequence = 0
    const complete = async () => {
      store.plannerStart()
      await Promise.resolve()
      store.plannerEnd()
      sequence += 1
      return JSON.stringify({ id: sequence === 1 ? 'first' : 'second', summary: 'test', edits: [{ action: 'create', kind: 'memory', id: `m${sequence}`, content: 'x' }] })
    }
    const coordinator = createRefineCoordinator({ store, completeFor: () => complete as Complete })
    const first = coordinator.execute(planRequest('local', 'tool'))
    const second = coordinator.execute(planRequest('local', 'tool'))
    await Promise.all([first, second])
    expect(store.commitOrder()).toEqual(['first', 'second'])
    expect(store.plannerOverlap()).toBeGreaterThan(1)
    expect(store.commitOverlap()).toBe(1)
  })

  it('delayed-store fixture records commits without overlap', async () => {
    const store = delayedStore()
    await Promise.all([
      store.applyRefinement(agent('first'), { id: 'first', summary: 'first', edits: [] }, {}),
      store.applyRefinement(agent('second'), { id: 'second', summary: 'second', edits: [] }, {}),
    ])
    expect(store.commitOrder()).toEqual(['first', 'second'])
    expect(store.commitOverlap()).toBeGreaterThan(1)
  })

  it('captures planner context once and passes baseline to Store', async () => {
    const ctx = new Context()
    const home = tempHome()
    const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
    const baseline = store.localState(agent())
    const complete = cannedComplete({ id: 'plan-1', summary: 'save lesson', edits: [{ action: 'create', kind: 'memory', id: 'lesson', content: 'x' }] })
    const coordinator = createRefineCoordinator({ store, completeFor: () => complete })
    const result = await coordinator.execute(planRequest('local', 'tool', 'focus'))
    expect(result).toMatchObject({ commitStatus: 'committed', approval: 'not-required', appliedCount: 1, rejectedCount: 0 })
    expect(result.refinement?.id).toBe('plan-1')
    expect(result.materialization?.status).toBe('completed')
    expect(result.refinement?.appliedEdits).toHaveLength(1)
  })

  it('uses the planner snapshot for real Store baseline conflict detection', async () => {
    const ctx = new Context()
    const home = tempHome()
    const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
    const liveAgent = agent('baseline-conflict-agent')
    store.applyRefinement(liveAgent, {
      id: 'seed-target', summary: 'seed target',
      edits: [{ action: 'create', kind: 'memory', id: 'target', content: 'before' }],
    })

    let mutation: RefinementResult & { materialization: MaterializationResult } | undefined
    const complete: Complete = async () => {
      mutation = store.applyRefinement(liveAgent, {
        id: 'mutate-target', summary: 'mutate target',
        edits: [{ action: 'update', kind: 'memory', id: 'target', content: 'changed', reason: 'change during planning' }],
      })
      return JSON.stringify({
        id: 'planned-target-update', summary: 'planned update',
        edits: [{ action: 'update', kind: 'memory', id: 'target', content: 'planned', reason: 'planned change' }],
      })
    }
    const result = await createRefineCoordinator({ store, completeFor: () => complete })
      .execute({ mode: 'plan', source: 'tool', scope: 'local', agent: liveAgent })

    expect(mutation?.appliedEdits[0]?.applied).toBe(true)
    expect(result.commitStatus).toBe('committed-with-rejected-edits')
    expect(result.appliedCount).toBe(0)
    expect(result.rejectedCount).toBe(1)
    expect(result.refinement?.appliedEdits[0]).toMatchObject({
      id: 'target', applied: false, error: 'entry changed during refinement planning',
    })
  })

  it('maps partial Store application to committed-with-rejected-edits', async () => {
    const store = fakeStore()
    store.applyRefinement = vi.fn(async () => ({
      ...refinementResult('r'),
      materialization: emptyMaterialization(),
      appliedEdits: [
        { action: 'create', kind: 'memory', id: 'ok', applied: true, blastRadius: 'general' },
        { action: 'update', kind: 'memory', id: 'bad', applied: false, blastRadius: 'general', error: 'entry not found' },
      ],
    }))
    const result = await createRefineCoordinator({ store, completeFor: () => cannedComplete({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'ok', content: 'x' }] }) }).execute(planRequest('local', 'tool'))
    expect(result).toMatchObject({ commitStatus: 'committed-with-rejected-edits', appliedCount: 1, rejectedCount: 1 })
  })

  it('rejects malformed edits before calling Store', async () => {
    const store = fakeStore()
    const result = await createRefineCoordinator({
      store,
      completeFor: () => cannedComplete({ id: 'bad-edit', summary: 'bad', edits: [null as never] }),
    }).execute(planRequest('local', 'tool'))
    expect(result).toMatchObject({ failedAt: 'planning', error: { code: 'invalid-proposal' } })
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('maps planner failures and malformed proposals', async () => {
    const failed = await createRefineCoordinator({ store: fakeStore(), completeFor: () => async () => { throw new Error('planner down') } }).execute(planRequest('local', 'tool'))
    expect(failed).toMatchObject({ failedAt: 'planning', error: { code: 'planning-failed', message: 'planner down' } })
    const store = fakeStore()
    const invalid = await createRefineCoordinator({ store, completeFor: () => cannedComplete('{"id":"bad","summary":3,"edits":[]}') }).execute(planRequest('local', 'tool'))
    expect(invalid).toMatchObject({ failedAt: 'planning', error: { code: 'invalid-proposal' } })
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('aborts before planning and before commit', async () => {
    const before = new AbortController()
    before.abort()
    const store = fakeStore()
    const planning = await createRefineCoordinator({ store, completeFor: () => cannedComplete('{}') }).execute({ ...planRequest('local', 'tool'), signal: before.signal })
    expect(planning).toMatchObject({ failedAt: 'validation', error: { code: 'aborted' } })
    const controller = new AbortController()
    const complete = async () => { controller.abort(); return JSON.stringify({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'x', content: 'x' }] }) }
    const commit = await createRefineCoordinator({ store, completeFor: () => complete as Complete }).execute({ ...planRequest('local', 'tool'), signal: controller.signal })
    expect(commit).toMatchObject({ failedAt: 'planning', error: { code: 'aborted' } })
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('aborts after approval before Store commit', async () => {
    const controller = new AbortController()
    const store = fakeStore()
    const result = await createRefineCoordinator({
      store,
      completeFor: () => cannedComplete({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'x', content: 'x' }] }),
      requireGlobalApprovalForTool: true,
      requireGlobalApproval: async () => { controller.abort() },
    }).execute({ ...planRequest('global', 'tool'), signal: controller.signal })
    expect(result).toMatchObject({ approval: 'approved', failedAt: 'approval', error: { code: 'aborted' } })
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('requires and maps global approval without Store commits', async () => {
    const missingStore = fakeStore()
    const missing = await createRefineCoordinator({ store: missingStore, completeFor: () => cannedComplete({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'x', content: 'x' }] }), requireGlobalApprovalForTool: true }).execute(planRequest('global', 'tool'))
    expect(missing).toMatchObject({ approval: 'not-required', failedAt: 'approval', error: { code: 'approval-unavailable' } })
    expect(missingStore.applyRefinement).not.toHaveBeenCalled()
    const rejectedStore = fakeStore()
    const rejected = await createRefineCoordinator({ store: rejectedStore, completeFor: () => cannedComplete({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'x', content: 'x' }] }), requireGlobalApprovalForTool: true, requireGlobalApproval: async () => { throw new Error('no') } }).execute(planRequest('global', 'tool'))
    expect(rejected).toMatchObject({ approval: 'rejected', failedAt: 'approval', error: { code: 'approval-rejected', message: 'no' } })
    expect(rejectedStore.applyRefinement).not.toHaveBeenCalled()
  })

  it('retains committed status when materialization fails', async () => {
    const store = fakeStore()
    store.applyRefinement = vi.fn(async () => ({
      ...refinementResult('materialization-failed'),
      appliedEdits: [{ action: 'create', kind: 'memory', id: 'x', applied: true, blastRadius: 'general' }],
      materialization: { ...emptyMaterialization(), status: 'failed' },
    }))
    const result = await createRefineCoordinator({ store, completeFor: () => cannedComplete({ id: 'r', summary: 'r', edits: [{ action: 'create', kind: 'memory', id: 'x', content: 'x' }] }) }).execute(planRequest('local', 'tool'))
    expect(result).toMatchObject({ commitStatus: 'committed', appliedCount: 1, rejectedCount: 0, failedAt: 'materialization', error: { code: 'materialization-failed' } })
  })
})
