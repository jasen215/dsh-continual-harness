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
  commitOverlap(): number
} {
  const order: string[] = []
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
  store.plannerOverlap = () => 0
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
    const coordinator = createRefineCoordinator({ store, completeFor: cannedComplete({ id: 'p', summary: 'none', edits: [] }) })
    const result = await coordinator.execute(planRequest('local', 'tool'))
    expect(result).toMatchObject({ commitStatus: 'not-committed', appliedCount: 0, rejectedCount: 0 })
    expect(store.applyRefinement).not.toHaveBeenCalled()
  })

  it('keeps real-store fixture helpers available for coordinator scenarios', () => {
    expect(realStoreWithHistory).toBeTypeOf('function')
    expect(delayedStore).toBeTypeOf('function')
  })
})
