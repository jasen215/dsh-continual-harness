import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { captureReferenceSnapshot, loadBenchmark, loadReferenceSnapshot } from '../src/benchmark.ts'
import type { BenchmarkDecision, ExecutorEvidence } from '../src/benchmark.ts'
import type { RefineCoordinator } from '../src/coordinator.ts'
import { HarnessStore } from '../src/store.ts'
import { registerBenchmarkTool, registerHarnessTool } from '../src/tool.ts'
import type { BenchmarkToolOptions, ToolOptions } from '../src/tool.ts'
import type { MaterializationResult, RefinementResult } from '../src/types.ts'

const testToolSignal = new AbortController().signal
const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-tool-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(rawId: string): StubAgent {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** A bare live agent for coordinator-adapter tests (no registry involved). */
function agent(id = 'tool-coordinator-agent'): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
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

function emptyMaterialization(): MaterializationResult {
  return { status: 'completed', written: [], unchanged: [], skipped: [], removed: [], errors: [] }
}

function refinementResult(id: string, edits: RefinementResult['appliedEdits'] = []): RefinementResult & { materialization: MaterializationResult } {
  return {
    id,
    summary: id,
    appliedEdits: edits,
    committedAt: new Date().toISOString(),
    scope: 'global',
    materialization: emptyMaterialization(),
  }
}

/** Mount the tools service and register harness_refine over one fake coordinator. */
async function mountRefineTool(coordinator: RefineCoordinator, options: ToolOptions): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  registerHarnessTool(ctx, coordinator, options)
  return ctx
}

/** Execute the harness_refine tool through the live agent. */
async function executeTool(ctx: Context, name: string, args: unknown, liveAgent: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent: liveAgent,
  })
}

/** Default benchmark tool options mirroring the spec §5 defaults. */
const OPTIONS: BenchmarkToolOptions = {
  defaultRuns: 1,
  maxRuns: 3,
  passThreshold: 60,
  regressionTolerance: 0,
  maxFailedCells: 0,
}

/** Mount the tools service and register the benchmark tool over one temp store. */
async function mount(home: string): Promise<{ ctx: Context; store: HarnessStore }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
  registerBenchmarkTool(ctx, store, OPTIONS)
  return { ctx, store }
}

/** Execute the benchmark tool; the agent is optional so agent-less paths are testable. */
async function execute(
  ctx: Context,
  args: unknown,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name: 'harness_benchmark',
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}

/** Parse the compact JSON returned by a successful tool call. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  return JSON.parse(block.text) as Record<string, unknown>
}

/** The structured failure message of a tool call. */
function errorMessage(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected tool failure')
  return result.error.message
}

/** Llm stand-in recording provider/model and user prompts, yielding canned replies. */
function makeFakeLlm(
  replies: ReadonlyArray<Record<string, unknown>>,
  requests: Array<{ provider: string; model: string }> = [],
) {
  let calls = 0
  return {
    get callCount() { return calls },
    async *stream(request: { provider: string; model: string }) {
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls += 1
      requests.push({ provider: request.provider, model: request.model })
      yield { type: 'text-delta' as const, text: JSON.stringify(reply) }
      yield { type: 'finish' as const, reason: { kind: 'success' as const } }
    },
  }
}

const VALID_EVIDENCE = { completed: true, summary: 'did the task', actions: [], observations: [] }
const SCORE_70 = { score: 70, feedback: 'reference ok' }
const SCORE_90 = { score: 90, feedback: 'candidate better' }

/** Seed one frozen case through the tool. */
async function seedFrozenCase(ctx: Context, id = 'case-1'): Promise<void> {
  const added = await execute(ctx, {
    action: 'add-case',
    case_id: id,
    title: 'Task',
    statement: 'Do X',
    rubric: 'X is correct',
  })
  expect(added.isError).toBe(false)
  const frozen = await execute(ctx, { action: 'freeze', case_id: id })
  expect(frozen.isError).toBe(false)
}

/** Seed a reference snapshot for one agent and a global refinement over it. */
async function seedReferenceAndRefinement(store: HarnessStore, agent: Agent, home: string): Promise<{ referenceId: string; refinementId: string }> {
  const referenceId = 'ref-1'
  const refinementId = 'refine-1'
  const snapshot = store.captureSnapshot(agent, referenceId)
  captureReferenceSnapshot(home, snapshot)
  store.applyRefinement(agent, {
    id: refinementId,
    summary: 'add a durable memory',
    edits: [{ action: 'create', kind: 'memory', id: 'mem-1', content: 'learned' }],
  }, { global: true })
  return { referenceId, refinementId }
}

describe('harness_benchmark action validation', () => {
  it('rejects an unknown action as a structured error without touching the benchmark store', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    for (const action of ['reset', 'nope', 'clear']) {
      const result = await execute(ctx, { action })
      expect(result.isError).toBe(true)
      expect(errorMessage(result)).toMatch(/invalid arguments/)
    }
    expect(existsSync(join(home, 'benchmark'))).toBe(false)
  })

  it('rejects a missing action as a structured error', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const result = await execute(ctx, {})
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/invalid arguments/)
    expect(existsSync(join(home, 'benchmark'))).toBe(false)
  })

  it('initializes the benchmark store with the new action', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const result = await execute(ctx, { action: 'new' })
    const json = resultJson(result)
    expect(json.action).toBe('new')
    expect(json.ok).toBe(true)
    expect(json.benchmark_dir).toBe(join(home, 'benchmark'))
    expect(existsSync(join(home, 'benchmark'))).toBe(true)
  })
})

describe('harness_benchmark add-case and freeze', () => {
  it('adds a draft case and persists it to cases.json', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const result = await execute(ctx, {
      action: 'add-case',
      case_id: 'case-1',
      title: 'Task',
      statement: 'Do X',
      rubric: 'X is correct',
      capability: 'mem',
    })
    const json = resultJson(result)
    expect(json.action).toBe('add-case')
    expect(json.ok).toBe(true)
    const benchmarkCase = json.case as Record<string, unknown>
    expect(benchmarkCase.id).toBe('case-1')
    expect(benchmarkCase.state).toBe('draft')
    expect(benchmarkCase.capability).toBe('mem')

    const loaded = loadBenchmark(home)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ id: 'case-1', state: 'draft', statement: 'Do X', rubric: 'X is correct' })
  })

  it('rejects add-case with missing material as a structured error without state change', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    for (const args of [
      { action: 'add-case', case_id: 'case-1', title: 'Task', statement: 'Do X' },
      { action: 'add-case', case_id: 'case-1', title: 'Task', rubric: 'X is correct' },
      { action: 'add-case', case_id: '', title: 'Task', statement: 'Do X', rubric: 'X is correct' },
    ]) {
      const result = await execute(ctx, args)
      expect(result.isError).toBe(true)
      expect(errorMessage(result)).toMatch(/benchmark:add-case:missing-argument/)
      expect(loadBenchmark(home)).toEqual([])
    }
  })

  it('rejects a duplicate case id as a structured error without overwriting the store', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    await seedFrozenCase(ctx, 'case-1')
    const result = await execute(ctx, {
      action: 'add-case',
      case_id: 'case-1',
      title: 'Another',
      statement: 'Do Y',
      rubric: 'Y is correct',
    })
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:add-case:duplicate-id/)
    const loaded = loadBenchmark(home)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.statement).toBe('Do X')
  })

  it('freezes a draft case and stamps frozenAt', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    await execute(ctx, { action: 'add-case', case_id: 'case-1', title: 'Task', statement: 'Do X', rubric: 'X is correct' })
    const result = await execute(ctx, { action: 'freeze', case_id: 'case-1' })
    const json = resultJson(result)
    const benchmarkCase = json.case as Record<string, unknown>
    expect(benchmarkCase.state).toBe('frozen')
    expect(benchmarkCase.frozen_at).toEqual(expect.any(String))
    const loaded = loadBenchmark(home)
    expect(loaded[0]?.state).toBe('frozen')
  })

  it('freeze of a non-existent or already-frozen case returns a structured error without state change', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const missing = await execute(ctx, { action: 'freeze', case_id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(errorMessage(missing)).toMatch(/benchmark:freeze:not-found/)

    await seedFrozenCase(ctx, 'case-1')
    const again = await execute(ctx, { action: 'freeze', case_id: 'case-1' })
    expect(again.isError).toBe(true)
    expect(errorMessage(again)).toMatch(/benchmark:freeze:not-draft/)
    expect(loadBenchmark(home)).toHaveLength(1)
  })
})

describe('harness_benchmark capture-reference', () => {
  it('requires a live agent', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const result = await execute(ctx, { action: 'capture-reference', snapshot_id: 'ref-1' })
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/requires a live agent/)
    expect(existsSync(join(home, 'benchmark'))).toBe(false)
  })

  it('captures the merged pre-refinement state and persists it', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('capture-ref')
    const result = await execute(ctx, { action: 'capture-reference', snapshot_id: 'ref-1' }, agent)
    const json = resultJson(result)
    expect(json.snapshot_id).toBe('ref-1')
    expect(json.state_hash).toMatch(/^[a-f0-9]{64}$/)

    const snapshot = loadReferenceSnapshot(home, 'ref-1')
    expect(snapshot).toBeDefined()
    expect(snapshot?.snapshotId).toBe('ref-1')
    expect(existsSync(join(home, 'benchmark', 'snapshots', 'ref-1.json'))).toBe(true)

    // the snapshot reflects pre-refinement state: a later refinement does not leak in
    store.applyRefinement(agent, {
      id: 'refine-later',
      summary: 'applied after capture',
      edits: [{ action: 'create', kind: 'memory', id: 'mem-1', content: 'later' }],
    }, { global: true })
    const loaded = loadReferenceSnapshot(home, 'ref-1')
    expect(loaded?.state.refinements).toHaveLength(0)
    expect(loaded?.state.entries.memory['mem-1']).toBeUndefined()
  })

  it('rejects a malformed capture-reference call without writing a snapshot', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const { agent } = stubAgent('capture-bad')
    const result = await execute(ctx, { action: 'capture-reference' }, agent)
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:capture-reference:missing-argument/)
    expect(existsSync(join(home, 'benchmark', 'snapshots'))).toBe(false)
  })
})

describe('harness_benchmark run', () => {
  it('refuses to run without any frozen cases', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const { agent } = stubAgent('run-empty')
    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-1',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:run:no-frozen-cases/)
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
  })

  it('refuses to run without the named reference snapshot', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const { agent } = stubAgent('run-no-ref')
    await seedFrozenCase(ctx)
    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'missing-ref',
      refinement_id: 'refine-1',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:run:no-reference/)
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
  })

  it('refuses to run when the refinement is not in the store history', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('run-no-refine')
    await seedFrozenCase(ctx)
    const snapshot = store.captureSnapshot(agent, 'ref-1')
    captureReferenceSnapshot(home, snapshot)
    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-unknown',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:run:refinement-not-found/)
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
  })

  it('refuses to run when the candidate delta is not provable from the reference', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('run-drift')
    await seedFrozenCase(ctx)
    // misuse: the refinement is applied BEFORE the reference is captured, so the
    // reference already contains the change and no clean delta can be proven
    store.applyRefinement(agent, {
      id: 'refine-1',
      summary: 'add a durable memory',
      edits: [{ action: 'create', kind: 'memory', id: 'mem-1', content: 'learned' }],
    }, { global: true })
    const snapshot = store.captureSnapshot(agent, 'ref-1')
    captureReferenceSnapshot(home, snapshot)
    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-1',
    }, agent)
    expect(result.isError).toBe(true)
    expect(errorMessage(result)).toMatch(/benchmark:run:candidate-delta/)
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
  })

  it('evaluates both sides and appends an ACCEPTED decision to runs.jsonl', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('run-ok')
    ctx.provide('llm', makeFakeLlm([VALID_EVIDENCE, SCORE_70, VALID_EVIDENCE, SCORE_90]) as never)
    await seedFrozenCase(ctx)
    const { referenceId, refinementId } = await seedReferenceAndRefinement(store, agent, home)

    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: referenceId,
      refinement_id: refinementId,
    }, agent)
    const json = resultJson(result)
    expect(json.action).toBe('run')
    expect(json.ok).toBe(true)
    expect(json.run_id).toEqual(expect.any(String))
    expect(json.refinement_id).toBe(refinementId)
    expect(json.status).toBe('ACCEPTED')
    expect(json.reference_overall).toBe(70)
    expect(json.candidate_overall).toBe(90)
    expect(json.regression_cases).toEqual([])
    expect(json.failed_cells).toBe(0)
    expect(json.auto_rollback).toBe(false)
    expect(json.feedback).toEqual(['reference ok', 'candidate better'])
    expect(json.runs).toBe(1)
    expect(json.cells).toBe(2)

    // the durable run record lands in benchmark/runs.jsonl with cells + decision
    const lines = readFileSync(join(home, 'benchmark', 'runs.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as {
      runId: string
      cells: Array<{ side: string; status: string; score: number | null; evidence: ExecutorEvidence | null; snapshotId: string }>
      decision: BenchmarkDecision
      createdAt: string
    }
    expect(record.runId).toBe(json.run_id)
    expect(record.decision.status).toBe('ACCEPTED')
    expect(record.decision.autoRollback).toBe(false)
    expect(record.decision.referenceOverall).toBe(70)
    expect(record.decision.candidateOverall).toBe(90)
    expect(record.cells).toHaveLength(2)
    const referenceCell = record.cells.find(cell => cell.side === 'reference')
    const candidateCell = record.cells.find(cell => cell.side === 'candidate')
    expect(referenceCell).toMatchObject({ status: 'ok', score: 70, snapshotId: referenceId })
    expect(referenceCell?.evidence).toEqual(VALID_EVIDENCE)
    expect(candidateCell).toMatchObject({ status: 'ok', score: 90 })
    expect(candidateCell?.snapshotId).not.toBe(referenceId)

    // the benchmark run never touched reviews.jsonl or applied another refinement
    expect(existsSync(join(home, 'reviews.jsonl'))).toBe(false)
    const fresh = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
    expect(fresh.globalState().refinements).toHaveLength(1)
  })

  it('honors runs, provider, and model options with identical options on both sides', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('run-options')
    const requests: Array<{ provider: string; model: string }> = []
    // 1 case x 2 iterations x 2 sides = 4 cells -> 8 completions
    const replies = [
      VALID_EVIDENCE, SCORE_70, VALID_EVIDENCE, SCORE_90,
      VALID_EVIDENCE, SCORE_70, VALID_EVIDENCE, SCORE_90,
    ]
    ctx.provide('llm', makeFakeLlm(replies, requests) as never)
    await seedFrozenCase(ctx)
    const { referenceId, refinementId } = await seedReferenceAndRefinement(store, agent, home)

    const result = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: referenceId,
      refinement_id: refinementId,
      runs: 2,
      provider: 'alt-provider',
      model: 'alt-model',
    }, agent)
    const json = resultJson(result)
    expect(json.status).toBe('ACCEPTED')
    expect(json.runs).toBe(2)
    expect(json.cells).toBe(4)
    // every completion — both sides, both iterations — routed through the same options
    expect(requests).toHaveLength(8)
    expect(requests.every(request => request.provider === 'alt-provider' && request.model === 'alt-model')).toBe(true)
  })

  it('rejects malformed run arguments without appending a run', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const { agent } = stubAgent('run-malformed')
    await seedFrozenCase(ctx)
    for (const args of [
      { action: 'run', refinement_id: 'refine-1' },
      { action: 'run', reference_snapshot_id: 'ref-1' },
      { action: 'run', reference_snapshot_id: 'ref-1', refinement_id: 'refine-1', runs: 0 },
      { action: 'run', reference_snapshot_id: 'ref-1', refinement_id: 'refine-1', runs: 99 },
    ]) {
      const result = await execute(ctx, args, agent)
      expect(result.isError).toBe(true)
      expect(errorMessage(result)).toMatch(/benchmark:run:/)
      expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
    }
  })

  it('an aborted run records no decision and fails with a structured error', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('run-abort')
    await seedFrozenCase(ctx)
    const { referenceId, refinementId } = await seedReferenceAndRefinement(store, agent, home)
    const controller = new AbortController()
    let calls = 0
    ctx.provide('llm', {
      async *stream() {
        calls += 1
        if (calls === 1) controller.abort()
        yield { type: 'text-delta' as const, text: JSON.stringify(VALID_EVIDENCE) }
        yield { type: 'finish' as const, reason: { kind: 'success' as const } }
      },
    } as never)
    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: CallId(`call-${Math.random()}`),
      name: 'harness_benchmark',
      arguments: { action: 'run', reference_snapshot_id: referenceId, refinement_id: refinementId },
      agent,
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected tool failure')
    expect(result.error.message).toMatch(/benchmark:run:aborted/)
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
  })
})

describe('harness_benchmark status', () => {
  it('lists cases, snapshots, and recent runs', async () => {
    const home = tempHome()
    const { ctx, store } = await mount(home)
    const { agent } = stubAgent('status')
    ctx.provide('llm', makeFakeLlm([VALID_EVIDENCE, SCORE_70, VALID_EVIDENCE, SCORE_90]) as never)
    await seedFrozenCase(ctx, 'case-1')
    const { referenceId, refinementId } = await seedReferenceAndRefinement(store, agent, home)
    await execute(ctx, {
      action: 'run',
      reference_snapshot_id: referenceId,
      refinement_id: refinementId,
    }, agent)

    const result = await execute(ctx, { action: 'status' })
    const json = resultJson(result)
    expect(json.action).toBe('status')
    expect(json.ok).toBe(true)
    const cases = json.cases as Array<Record<string, unknown>>
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({ id: 'case-1', state: 'frozen' })
    const snapshots = json.snapshots as Array<Record<string, unknown>>
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ snapshot_id: referenceId })
    expect(snapshots[0]?.state_hash).toMatch(/^[a-f0-9]{64}$/)
    const runs = json.recent_runs as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ refinement_id: refinementId, status: 'ACCEPTED' })
  })

  it('reports an empty benchmark without creating the store', async () => {
    const home = tempHome()
    const { ctx } = await mount(home)
    const result = await execute(ctx, { action: 'status' })
    const json = resultJson(result)
    expect(json.cases).toEqual([])
    expect(json.snapshots).toEqual([])
    expect(json.recent_runs).toEqual([])
    expect(existsSync(join(home, 'benchmark'))).toBe(false)
  })
})

describe('harness_refine coordinator adapter', () => {
  it('maps tool arguments to one coordinator request and preserves domain counts', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed-with-rejected-edits' as const,
      approval: 'approved' as const,
      appliedCount: 2,
      rejectedCount: 1,
      refinement: refinementResult('r-tool'),
      materialization: emptyMaterialization(),
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const result = await executeTool(ctx, 'harness_refine', { instructions: 'focus', global: true }, agent())
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan', source: 'tool', scope: 'global', instructions: 'focus' }))
    expect(execute.mock.calls[0]?.[0]?.signal).toBe(testToolSignal)
    expect(resultJson(result)).toMatchObject({ refinement_id: 'r-tool', scope: 'global', applied: 2, failed: 1 })
  })

  it('maps a rollback_id to one rollback request and preserves the refinement id', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 1,
      rejectedCount: 0,
      refinement: refinementResult('rollback_refine_x'),
      materialization: emptyMaterialization(),
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const result = await executeTool(ctx, 'harness_refine', { rollback_id: 'refine_x', global: true }, agent())
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'rollback', source: 'tool', scope: 'global', rollbackId: 'refine_x' }))
    expect(resultJson(result)).toMatchObject({ refinement_id: 'rollback_refine_x', scope: 'global', applied: 1, failed: 0 })
  })

  it('reports refinement_id none for a not-committed result and resolves the default scope', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'not-committed' as const,
      approval: 'not-required' as const,
      appliedCount: 0,
      rejectedCount: 0,
      error: { code: 'approval-rejected' as const, message: 'global write not approved' },
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const result = await executeTool(ctx, 'harness_refine', {}, agent())
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan', source: 'tool', scope: 'global' }))
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('instructions')
    expect(resultJson(result)).toMatchObject({
      refinement_id: 'none',
      scope: 'global',
      summary: 'global write not approved',
      applied: 0,
      failed: 0,
      edits: [],
    })
  })

  it('includes coordinator diagnostics in the tool output without changing committed counts', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 1,
      rejectedCount: 0,
      refinement: refinementResult('r'),
      materialization: emptyMaterialization(),
      diagnostics: {
        status: 'partial' as const,
        structural: [],
        security: [],
        errors: [{ provider: 'security', code: 'provider-failed', message: 'scanner failed' }],
      },
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const result = await executeTool(ctx, 'harness_refine', { global: true }, agent())
    const json = resultJson(result)
    // counts come only from the coordinator output; the top-level materialization
    // stays put, while diagnostics carries only diagnostics fields
    expect(json).toMatchObject({
      applied: 1,
      failed: 0,
      refinement_id: 'r',
      materialization: expect.any(Object),
      diagnostics: {
        status: 'partial',
        structural: [],
        security: [],
        errors: [{ provider: 'security', code: 'provider-failed', message: 'scanner failed' }],
      },
    })
    expect(json.diagnostics).not.toHaveProperty('materialization')
  })

  it('maps optional security file/line/evidence fields into tool output', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 1,
      rejectedCount: 0,
      refinement: refinementResult('r-sec'),
      materialization: emptyMaterialization(),
      diagnostics: {
        status: 'completed' as const,
        structural: [],
        security: [{
          skillId: 'one',
          code: 'secret-exposure',
          message: 'looks like a credential',
          severity: 'high',
          file: 'SKILL.md',
          line: 2,
          evidence: 'sk-key-like',
        }],
        errors: [],
      },
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const json = resultJson(await executeTool(ctx, 'harness_refine', { global: true }, agent()))
    expect(json.diagnostics.security[0]).toEqual({
      skill_id: 'one',
      code: 'secret-exposure',
      message: 'looks like a credential',
      severity: 'high',
      file: 'SKILL.md',
      line: 2,
      evidence: 'sk-key-like',
    })
  })

  it('projects a security finding without optional fields to just skill_id/code/message', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 1,
      rejectedCount: 0,
      refinement: refinementResult('r-sec-bare'),
      materialization: emptyMaterialization(),
      diagnostics: {
        status: 'completed' as const,
        structural: [],
        security: [{
          skillId: 'one',
          code: 'secret-exposure',
          message: 'looks like a credential',
        }],
        errors: [],
      },
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const json = resultJson(await executeTool(ctx, 'harness_refine', { global: true }, agent()))
    expect(json.diagnostics.security[0]).toEqual({
      skill_id: 'one',
      code: 'secret-exposure',
      message: 'looks like a credential',
    })
    expect(json.diagnostics.security[0]).not.toHaveProperty('severity')
    expect(json.diagnostics.security[0]).not.toHaveProperty('file')
    expect(json.diagnostics.security[0]).not.toHaveProperty('line')
    expect(json.diagnostics.security[0]).not.toHaveProperty('evidence')
  })

  it('omits the diagnostics key when the coordinator result has none', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 1,
      rejectedCount: 0,
      refinement: refinementResult('r'),
      materialization: emptyMaterialization(),
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: true })
    const json = resultJson(await executeTool(ctx, 'harness_refine', { global: true }, agent()))
    expect(json.applied).toBe(1)
    expect(json.diagnostics).toBeUndefined()
  })

  it('uses coordinator-provided counts without recounting adapter-local edit arrays', async () => {
    const execute = vi.fn(async () => ({
      commitStatus: 'committed' as const,
      approval: 'not-required' as const,
      appliedCount: 2,
      rejectedCount: 1,
      refinement: refinementResult('r-counts', [
        { action: 'create', kind: 'memory', id: 'a', applied: true, blastRadius: 'general' },
        { action: 'create', kind: 'memory', id: 'b', applied: true, blastRadius: 'general' },
        { action: 'create', kind: 'memory', id: 'c', applied: true, blastRadius: 'general' },
        { action: 'create', kind: 'memory', id: 'd', applied: true, blastRadius: 'general' },
        { action: 'create', kind: 'memory', id: 'e', applied: false, error: 'rejected', blastRadius: 'general' },
      ]),
      materialization: {
        status: 'partial',
        written: ['w1'],
        unchanged: [],
        skipped: [],
        removed: ['s1'],
        errors: [{ path: 'p', code: 'c', retryable: true, message: 'm' }],
      },
    }))
    const ctx = await mountRefineTool({ execute }, { defaultGlobal: false })
    const result = await executeTool(ctx, 'harness_refine', { global: false }, agent())
    const json = resultJson(result)
    // counts come only from the coordinator output, never from the edit array length
    expect(json.applied).toBe(2)
    expect(json.failed).toBe(1)
    expect((json.edits as unknown[])).toHaveLength(5)
    const edits = json.edits as Array<Record<string, unknown>>
    expect(edits[4]).toMatchObject({ id: 'e', applied: false, error: 'rejected' })
    const materialization = json.materialization as Record<string, unknown>
    expect(materialization.removed).toEqual(['s1'])
    expect(materialization.errors).toEqual([{ path: 'p', code: 'c', retryable: true, message: 'm' }])
  })
})
