import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildSnapshot, createBenchmarkCase, freezeBenchmarkCase } from '../src/benchmark.ts'
import type { BenchmarkCase, HarnessSnapshot } from '../src/benchmark.ts'
import { HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import { parseExecutorEvidence, parseReviewerScore, runCellEvaluation } from '../src/evaluate.ts'
import type { CellEvaluationInput } from '../src/evaluate.ts'
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

const REFERENCE_SNAPSHOT: HarnessSnapshot = buildSnapshot(baseState(), 'ref-1')

const VALID_EVIDENCE = { completed: true, summary: 'did the task', actions: ['checked the state'], observations: ['the state is empty'] }
const VALID_SCORE = { score: 82, feedback: 'specific improvement' }

function input(overrides: Partial<CellEvaluationInput> = {}): CellEvaluationInput {
  return {
    runId: 'run-1',
    side: 'reference',
    iteration: 1,
    benchmarkCase: FROZEN_CASE,
    snapshot: REFERENCE_SNAPSHOT,
    provider: 'test-provider',
    model: 'test-model',
    ...overrides,
  }
}

type LlmReply = Record<string, unknown> | string

/** Llm stand-in that records the user prompt of every call and yields canned replies. */
function makeFakeLlm(calls: string[], requests: Array<{ provider: string; model: string }>, replies: ReadonlyArray<LlmReply>) {
  let index = 0
  return {
    get callCount() { return index },
    async *stream(request: { provider: string; model: string; messages: Array<{ content: Array<{ type: string; text: string }> }> }) {
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      requests.push({ provider: request.provider, model: request.model })
      const user = request.messages[0]?.content.find(block => block.type === 'text')?.text ?? ''
      calls.push(user)
      yield { type: 'text-delta', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }
      yield { type: 'finish', reason: { kind: 'success' } }
    },
  }
}

function fakeContext(
  calls: string[],
  replies: ReadonlyArray<LlmReply> = [VALID_EVIDENCE, VALID_SCORE],
  requests: Array<{ provider: string; model: string }> = [],
): Context {
  const ctx = new Context()
  ctx.provide('llm', makeFakeLlm(calls, requests, replies) as never)
  return ctx
}

/** Injected completion seam yielding one canned reply per phase. */
function injectedComplete(replies: ReadonlyArray<LlmReply>) {
  let index = 0
  return async (): Promise<string> => {
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return typeof reply === 'string' ? reply : JSON.stringify(reply)
  }
}

describe('executor/reviewer prompt boundary', () => {
  it('does not include rubric in the executor prompt', async () => {
    const calls: string[] = []
    const result = await runCellEvaluation(fakeContext(calls), input())
    expect(calls[0]).not.toContain(FROZEN_CASE.rubric)
    expect(calls[0]).toContain(FROZEN_CASE.statement)
    expect(result.status).toBe('ok')
  })

  it('builds the executor prompt from the statement and the snapshot overview only', async () => {
    const calls: string[] = []
    await runCellEvaluation(fakeContext(calls), input())
    expect(calls[0]).toContain(FROZEN_CASE.statement)
    expect(calls[0]).toContain('# Continual Harness State')
    expect(calls[0]).not.toContain(FROZEN_CASE.rubric)
  })

  it('gives the reviewer evidence and rubric and preserves feedback', async () => {
    const calls: string[] = []
    const result = await runCellEvaluation(fakeContext(calls), input())
    expect(calls[1]).toContain(FROZEN_CASE.rubric)
    expect(calls[1]).toContain('did the task')
    expect(result.score).toBe(82)
    expect(result.feedback).toBe('specific improvement')
  })

  it('records traceability references on an ok cell', async () => {
    const result = await runCellEvaluation(fakeContext([]), input())
    expect(result.runId).toBe('run-1')
    expect(result.side).toBe('reference')
    expect(result.caseId).toBe('case-1')
    expect(result.iteration).toBe(1)
    expect(result.snapshotId).toBe('ref-1')
    expect(result.stateHash).toBe(REFERENCE_SNAPSHOT.stateHash)
    expect(result.caseHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.executorProvider).toBe('test-provider')
    expect(result.executorModel).toBe('test-model')
    expect(result.evidence).toEqual(VALID_EVIDENCE)
    expect(result.recordedAt).toEqual(expect.any(String))
  })

  it('routes the completion through the input provider and model', async () => {
    const requests: Array<{ provider: string; model: string }> = []
    await runCellEvaluation(fakeContext([], [VALID_EVIDENCE, VALID_SCORE], requests), input())
    expect(requests).toEqual([
      { provider: 'test-provider', model: 'test-model' },
      { provider: 'test-provider', model: 'test-model' },
    ])
  })
})

describe('parseExecutorEvidence', () => {
  it('parses exactly the documented fields and tolerates code fences', () => {
    const evidence = parseExecutorEvidence('```json\n{"completed":true,"summary":"s","actions":["a"],"observations":["o"],"artifacts":[{"name":"n","content":"c"}]}\n```')
    expect(evidence).toEqual({
      completed: true,
      summary: 's',
      actions: ['a'],
      observations: ['o'],
      artifacts: [{ name: 'n', content: 'c' }],
    })
  })

  it('rejects evidence with unknown fields', () => {
    expect(() => parseExecutorEvidence('{"completed":true,"summary":"s","actions":[],"observations":[],"extra":1}')).toThrow(/unexpected/i)
  })

  it('rejects malformed or mistyped evidence', () => {
    expect(() => parseExecutorEvidence('not json')).toThrow()
    expect(() => parseExecutorEvidence('{"completed":"yes","summary":"s","actions":[],"observations":[]}')).toThrow()
    expect(() => parseExecutorEvidence('{"completed":true,"summary":"s","actions":"a","observations":[]}')).toThrow()
  })

  it('rejects unknown fields inside an artifact', () => {
    expect(() => parseExecutorEvidence('{"completed":true,"summary":"s","actions":[],"observations":[],"artifacts":[{"name":"n","content":"c","path":"/tmp/x"}]}')).toThrow()
    expect(() => parseExecutorEvidence('{"completed":true,"summary":"s","actions":[],"observations":[],"artifacts":[{"name":"n"}]}')).toThrow()
  })
})

describe('parseReviewerScore', () => {
  it('parses a finite score in 0..100 with non-empty feedback', () => {
    expect(parseReviewerScore('{"score":82,"feedback":"specific improvement"}')).toEqual({ score: 82, feedback: 'specific improvement' })
  })

  it('rejects non-finite and out-of-range scores', () => {
    for (const text of [
      '{"score":-1,"feedback":"f"}',
      '{"score":101,"feedback":"f"}',
      '{"score":null,"feedback":"f"}',
      '{"score":"82","feedback":"f"}',
    ]) {
      expect(() => parseReviewerScore(text)).toThrow()
    }
  })

  it('rejects empty or missing feedback', () => {
    expect(() => parseReviewerScore('{"score":50,"feedback":""}')).toThrow()
    expect(() => parseReviewerScore('{"score":50,"feedback":"   "}')).toThrow()
    expect(() => parseReviewerScore('{"score":50}')).toThrow()
  })
})

describe('failure conversion', () => {
  it('fails the cell on malformed executor JSON', async () => {
    const result = await runCellEvaluation(fakeContext([], ['the model replied with prose']), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('malformed-executor-json')
    expect(result.evidence).toBeNull()
  })

  it('fails the cell on executor evidence with unknown fields', async () => {
    const result = await runCellEvaluation(fakeContext([], [{ completed: true, summary: 's', actions: [], observations: [], extra: 1 }]), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('malformed-executor-json')
  })

  it('fails the cell on malformed reviewer JSON', async () => {
    const result = await runCellEvaluation(fakeContext([], [VALID_EVIDENCE, 'reviewer prose']), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('malformed-reviewer-json')
    // evidence from the executor phase is still preserved on the failed cell
    expect(result.evidence).toEqual(VALID_EVIDENCE)
  })

  it('fails the cell on invalid reviewer scores', async () => {
    for (const reply of [{ score: -1, feedback: 'f' }, { score: 101, feedback: 'f' }, { score: null, feedback: 'f' }]) {
      const result = await runCellEvaluation(fakeContext([], [VALID_EVIDENCE, reply]), input())
      expect(result.status).toBe('failed')
      expect(result.score).toBeNull()
      expect(result.failureReason).toBe('invalid-reviewer-score')
    }
  })

  it('fails the cell on empty reviewer feedback', async () => {
    const result = await runCellEvaluation(fakeContext([], [VALID_EVIDENCE, { score: 50, feedback: ' ' }]), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('empty-reviewer-feedback')
  })

  it('fails the cell when the model stream ends with an error', async () => {
    const ctx = new Context()
    ctx.provide('llm', { async *stream() { yield { type: 'finish', reason: { kind: 'error' } } } } as never)
    const result = await runCellEvaluation(ctx, input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('provider-error')
  })

  it('fails the cell when the completion throws', async () => {
    const result = await runCellEvaluation(new Context(), input(), {
      complete: async () => { throw new Error('provider down') },
    })
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('provider-error')
  })

  it('fails the cell when the evaluation is aborted', async () => {
    const controller = new AbortController()
    const pending = runCellEvaluation(new Context(), input(), {
      signal: controller.signal,
      timeoutMs: 5000,
      complete: async () => { await new Promise(() => {}); return '' },
    })
    controller.abort()
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('aborted')
  })

  it('fails the cell when a phase times out', async () => {
    const result = await runCellEvaluation(new Context(), input(), {
      timeoutMs: 10,
      complete: async () => { await new Promise(() => {}); return '' },
    })
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('timeout')
  })

  it('honors an injected completion function', async () => {
    const result = await runCellEvaluation(new Context(), input(), {
      complete: injectedComplete([VALID_EVIDENCE, VALID_SCORE]),
    })
    expect(result.status).toBe('ok')
    expect(result.score).toBe(82)
    expect(result.feedback).toBe('specific improvement')
  })
})
