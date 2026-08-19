/**
 * End-to-end benchmark workflow test (spec §7 "integration tests" + §8 acceptance):
 * mounts the REAL plugin via apply() — real store, real harness_benchmark
 * tool, real evaluator and scorer, real persistence — with only the LLM
 * faked, and drives the full
 *   new → add-case → freeze → capture-reference → apply refinement → run → status
 * sequence. Asserts the durable benchmark/runs.jsonl record (decision + cells
 * + evidence with the correct shape), that benchmark evaluation never touches
 * reviews.jsonl or the harness state (isolation at the integration level),
 * that a REJECTED decision never auto-rolls back, and that a candidate that
 * is not reference plus exactly the named refinement is refused before any
 * evaluation. This is a workflow test of the real wiring, not a mock of the
 * code under test.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { appendReview } from '../src/audit.ts'
import type { ExecutorEvidence } from '../src/benchmark.ts'
import { HarnessStore } from '../src/store.ts'

const testToolSignal = new AbortController().signal
const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-benchmark-integration-'))
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

/** Hermetic plugin config: harness root + skills dir inside one temp home. */
function pluginConfig(root: string) {
  return { defaultGlobal: true, harnessRoot: root, skillsDir: join(root, 'skills') }
}

/** Mount the REAL plugin through apply(), exactly as a dsh profile would. */
async function mount(home: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, pluginConfig(home))
  return ctx
}

/** Execute the real harness_benchmark tool registered by the mounted plugin. */
async function execute(
  ctx: Context,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name: 'harness_benchmark',
    arguments: args,
    agent,
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

/** Seed the workflow's setup steps: new → add-case → freeze → capture-reference. */
async function seedBenchmark(ctx: Context, agent: Agent): Promise<void> {
  const created = await execute(ctx, { action: 'new' }, agent)
  expect(resultJson(created)).toMatchObject({ action: 'new', ok: true })
  const added = await execute(ctx, {
    action: 'add-case',
    case_id: 'case-1',
    title: 'Task',
    statement: 'Do X',
    rubric: 'X is correct',
  }, agent)
  expect(resultJson(added)).toMatchObject({ action: 'add-case', ok: true })
  const frozen = await execute(ctx, { action: 'freeze', case_id: 'case-1' }, agent)
  expect(resultJson(frozen)).toMatchObject({ action: 'freeze', ok: true })
  const captured = await execute(ctx, { action: 'capture-reference', snapshot_id: 'ref-1' }, agent)
  expect(resultJson(captured)).toMatchObject({ action: 'capture-reference', ok: true, snapshot_id: 'ref-1' })
}

/** Apply one known global refinement through the REAL store over the same home. */
function applyKnownRefinement(home: string, agent: Agent, refinementId: string): void {
  const store = new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') })
  const result = store.applyRefinement(agent, {
    id: refinementId,
    summary: 'add a durable memory',
    edits: [{ action: 'create', kind: 'memory', id: 'mem-1', content: 'learned' }],
  }, { global: true })
  expect(result.appliedEdits).toHaveLength(1)
}

/** Seed one pre-existing review line so the run must prove it never rewrites it. */
function seedReview(home: string, agent: Agent): string {
  appendReview(home, {
    timestamp: new Date().toISOString(),
    sessionId: String(agent.session.id),
    trigger: 'manual',
    turnsSinceLastReview: 0,
    outcome: 'approved',
    rationale: 'seeded before the benchmark run',
  })
  return readFileSync(join(home, 'reviews.jsonl'), 'utf8')
}

/** Re-open the harness state from disk exactly as a fresh session would see it. */
function freshState(home: string) {
  return new HarnessStore(new Context(), { harnessRoot: home, skillsDir: join(home, 'skills') }).globalState()
}

describe('harness_benchmark end-to-end workflow (real plugin wiring)', () => {
  it('accepts a known-good refinement and records decision + cells + evidence without touching reviews.jsonl or harness state', async () => {
    const home = tempHome()
    const ctx = await mount(home)
    const { agent } = stubAgent('int-accepted')
    const requests: Array<{ provider: string; model: string }> = []
    ctx.provide('llm', makeFakeLlm([VALID_EVIDENCE, SCORE_70, VALID_EVIDENCE, SCORE_90], requests) as never)

    await seedBenchmark(ctx, agent)
    // reference capture (inside seedBenchmark) precedes the refinement
    applyKnownRefinement(home, agent, 'refine-1')
    const reviewsBefore = seedReview(home, agent)
    const stateBefore = freshState(home)

    const run = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-1',
    }, agent)
    const json = resultJson(run)
    expect(json.action).toBe('run')
    expect(json.ok).toBe(true)
    expect(json.status).toBe('ACCEPTED')
    expect(json.refinement_id).toBe('refine-1')
    expect(json.reference_overall).toBe(70)
    expect(json.candidate_overall).toBe(90)
    expect(json.regression_cases).toEqual([])
    expect(json.failed_cells).toBe(0)
    expect(json.auto_rollback).toBe(false)
    expect(json.runs).toBe(1)
    expect(json.cells).toBe(2)
    // both sides evaluated through the same provider/model
    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.provider === 'test-provider' && request.model === 'test-model')).toBe(true)

    // the durable run record lands in benchmark/runs.jsonl with decision + cells + evidence
    const lines = readFileSync(join(home, 'benchmark', 'runs.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as {
      runId: string
      cells: Array<{
        side: string
        caseId: string
        iteration: number
        status: string
        score: number | null
        feedback?: string
        snapshotId: string
        stateHash: string
        caseHash: string
        evidence: ExecutorEvidence | null
      }>
      decision: {
        status: string
        refinementId: string
        referenceOverall: number | null
        candidateOverall: number | null
        regressionCases: string[]
        failedCells: number
        feedback: string[]
        autoRollback: boolean
        createdAt: string
      }
      createdAt: string
    }
    expect(record.runId).toBe(json.run_id)
    expect(record.decision).toMatchObject({
      status: 'ACCEPTED',
      refinementId: 'refine-1',
      referenceOverall: 70,
      candidateOverall: 90,
      regressionCases: [],
      failedCells: 0,
      autoRollback: false,
    })
    expect(record.decision.feedback).toEqual(['reference ok', 'candidate better'])
    expect(record.createdAt).toBe(record.decision.createdAt)
    expect(record.cells).toHaveLength(2)
    const referenceCell = record.cells.find(cell => cell.side === 'reference')
    const candidateCell = record.cells.find(cell => cell.side === 'candidate')
    expect(referenceCell).toMatchObject({
      side: 'reference',
      caseId: 'case-1',
      iteration: 1,
      status: 'ok',
      score: 70,
      snapshotId: 'ref-1',
    })
    expect(referenceCell?.stateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(referenceCell?.caseHash).toMatch(/^[a-f0-9]{64}$/)
    expect(referenceCell?.evidence).toEqual(VALID_EVIDENCE)
    expect(candidateCell).toMatchObject({ side: 'candidate', status: 'ok', score: 90 })
    expect(candidateCell?.snapshotId).not.toBe('ref-1')
    expect(candidateCell?.evidence).toEqual(VALID_EVIDENCE)

    // isolation: benchmark evaluation never touches reviews.jsonl or the harness state
    expect(readFileSync(join(home, 'reviews.jsonl'), 'utf8')).toBe(reviewsBefore)
    expect(freshState(home)).toEqual(stateBefore)

    // status closes the loop: one frozen case, one snapshot, one ACCEPTED run
    const status = resultJson(await execute(ctx, { action: 'status' }, agent))
    expect(status.cases).toEqual([{ id: 'case-1', title: 'Task', state: 'frozen' }])
    const snapshots = status.snapshots as Array<Record<string, unknown>>
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ snapshot_id: 'ref-1' })
    const runs = status.recent_runs as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ refinement_id: 'refine-1', status: 'ACCEPTED', reference_overall: 70, candidate_overall: 90 })
  })

  it('rejects a regressing refinement and never auto-rolls back or mutates harness state', async () => {
    const home = tempHome()
    const ctx = await mount(home)
    const { agent } = stubAgent('int-rejected')
    // candidate scores below the reference on the same case -> regression
    ctx.provide('llm', makeFakeLlm([VALID_EVIDENCE, SCORE_90, VALID_EVIDENCE, SCORE_70]) as never)

    await seedBenchmark(ctx, agent)
    applyKnownRefinement(home, agent, 'refine-1')
    const reviewsBefore = seedReview(home, agent)
    const stateBefore = freshState(home)

    const run = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-1',
    }, agent)
    const json = resultJson(run)
    expect(json.status).toBe('REJECTED')
    expect(json.reference_overall).toBe(90)
    expect(json.candidate_overall).toBe(70)
    expect(json.regression_cases).toEqual(['case-1'])
    expect(json.failed_cells).toBe(0)
    expect(json.auto_rollback).toBe(false)

    // the REJECTED decision is recorded; nothing is rolled back
    const record = JSON.parse(
      readFileSync(join(home, 'benchmark', 'runs.jsonl'), 'utf8').trim().split('\n')[0]!,
    ) as { decision: { status: string; autoRollback: boolean; referenceOverall: number | null; candidateOverall: number | null } }
    expect(record.decision).toMatchObject({
      status: 'REJECTED',
      autoRollback: false,
      referenceOverall: 90,
      candidateOverall: 70,
    })
    expect(readFileSync(join(home, 'reviews.jsonl'), 'utf8')).toBe(reviewsBefore)
    expect(freshState(home)).toEqual(stateBefore)

    const status = resultJson(await execute(ctx, { action: 'status' }, agent))
    const runs = status.recent_runs as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ refinement_id: 'refine-1', status: 'REJECTED' })
  })

  it('refuses a run whose candidate is not the single refinement delta, before any evaluation', async () => {
    const home = tempHome()
    const ctx = await mount(home)
    const { agent } = stubAgent('int-delta')
    // misuse: the refinement is applied BEFORE the reference is captured, so the
    // reference already contains the change and no clean delta can be proven
    applyKnownRefinement(home, agent, 'refine-1')
    await seedBenchmark(ctx, agent)

    const run = await execute(ctx, {
      action: 'run',
      reference_snapshot_id: 'ref-1',
      refinement_id: 'refine-1',
    }, agent)
    expect(run.isError).toBe(true)
    expect(errorMessage(run)).toMatch(/benchmark:run:candidate-delta/)
    // the refusal happens before evaluation: no run record, no llm calls, no reviews
    expect(existsSync(join(home, 'benchmark', 'runs.jsonl'))).toBe(false)
    expect(existsSync(join(home, 'reviews.jsonl'))).toBe(false)
    expect(freshState(home).refinements).toHaveLength(1)
  })
})
