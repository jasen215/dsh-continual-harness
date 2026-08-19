import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as audit from '../src/audit.ts'
import * as benchmark from '../src/benchmark.ts'
import { buildSnapshot, createBenchmarkCase, freezeBenchmarkCase } from '../src/benchmark.ts'
import type { BenchmarkCase, HarnessSnapshot } from '../src/benchmark.ts'
import { HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import { runCellEvaluation } from '../src/evaluate.ts'
import type { CellEvaluationInput } from '../src/evaluate.ts'
import * as projection from '../src/projection.ts'
import * as skills from '../src/skills.ts'
import * as storage from '../src/storage.ts'
import { HarnessStore } from '../src/store.ts'
import type { HarnessState } from '../src/types.ts'

const EMPTY_ENTRIES = { prompt: {}, memory: {}, skill: {}, subagent: {} }

function baseState(): HarnessState {
  return { schemaVersion: HARNESS_SCHEMA_VERSION, entries: structuredClone(EMPTY_ENTRIES), refinements: [] }
}

const FROZEN_CASE: BenchmarkCase = freezeBenchmarkCase(createBenchmarkCase({
  id: 'case-1',
  title: 'Task',
  statement: 'Do X',
  rubric: 'X is correct',
}))

const SNAPSHOT: HarnessSnapshot = buildSnapshot(baseState(), 'ref-1')

const VALID_EVIDENCE = { completed: true, summary: 'did the task', actions: [], observations: [] }
const VALID_SCORE = { score: 82, feedback: 'specific improvement' }

function input(): CellEvaluationInput {
  return {
    runId: 'run-1',
    side: 'reference',
    iteration: 1,
    benchmarkCase: FROZEN_CASE,
    snapshot: SNAPSHOT,
    provider: 'test-provider',
    model: 'test-model',
  }
}

/** Llm stand-in yielding a valid evidence then a valid score. */
function makeFakeLlm() {
  let index = 0
  return {
    async *stream() {
      const reply = index === 0 ? VALID_EVIDENCE : VALID_SCORE
      index += 1
      yield { type: 'text-delta', text: JSON.stringify(reply) }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
}

function fakeContext(): Context {
  const ctx = new Context()
  ctx.provide('llm', makeFakeLlm() as never)
  return ctx
}

describe('benchmark evaluator isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never applies refinements, persists state, records usage, projects, reconciles skills, or audits', async () => {
    const applySpy = vi.spyOn(HarnessStore.prototype, 'applyRefinement')
    const saveSpy = vi.spyOn(storage, 'saveHarnessState')
    const usageSpy = vi.spyOn(storage, 'appendUsageEvents')
    const projectionSpy = vi.spyOn(projection, 'registerHarnessProjection')
    const skillSpy = vi.spyOn(skills, 'reconcileSkillFiles')
    const auditSpy = vi.spyOn(audit, 'appendReview')
    // the benchmark-specific audit write; the evaluator must not touch it
    const benchmarkAuditSpy = vi.spyOn(benchmark, 'appendBenchmarkRun')

    const result = await runCellEvaluation(fakeContext(), input())

    expect(result.status).toBe('ok')
    expect(applySpy).not.toHaveBeenCalled()
    expect(saveSpy).not.toHaveBeenCalled()
    expect(usageSpy).not.toHaveBeenCalled()
    expect(projectionSpy).not.toHaveBeenCalled()
    expect(skillSpy).not.toHaveBeenCalled()
    expect(auditSpy).not.toHaveBeenCalled()
    expect(benchmarkAuditSpy).not.toHaveBeenCalled()
  })

  it('never calls a store passed on the context', async () => {
    const storeSpy = {
      applyRefinement: vi.fn(),
      saveHarnessState: vi.fn(),
      recordInjections: vi.fn(),
      promoteEntry: vi.fn(),
      rollbackRefinement: vi.fn(),
    }
    const ctx = fakeContext() as Context & { store: typeof storeSpy }
    ctx.store = storeSpy

    const result = await runCellEvaluation(ctx, input())

    expect(result.status).toBe('ok')
    for (const spy of Object.values(storeSpy)) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('does not mutate the snapshot it evaluates against', async () => {
    const snapshot: HarnessSnapshot = buildSnapshot(baseState(), 'ref-2')
    const before = structuredClone(snapshot)

    const result = await runCellEvaluation(fakeContext(), { ...input(), snapshot })

    expect(result.status).toBe('ok')
    expect(snapshot).toEqual(before)
  })
})
