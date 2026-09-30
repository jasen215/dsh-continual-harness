import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildSnapshot, createBenchmarkCase, freezeBenchmarkCase } from '../src/benchmark.ts'
import type { BenchmarkCase, HarnessSnapshot } from '../src/benchmark.ts'
import { HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import { MAX_EVIDENCE_ARTIFACTS, MAX_EVIDENCE_TOTAL_BYTES, buildReviewerPrompt, parseExecutorEvidence, parseReviewerScore, parseReviewerVerdicts, runCellEvaluation, scoreFromVerdicts } from '../src/evaluate.ts'
import type { CellEvaluationInput } from '../src/evaluate.ts'
import type { BenchmarkCriterion } from '../src/benchmark.ts'
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

const CRITERIA: BenchmarkCriterion[] = [
  { id: 'routing', weight: 40, check: 'routed to the harness-managed skill path' },
  { id: 'persistence', weight: 25, check: 'persisted through the harness with an advanced version' },
  { id: 'auditability', weight: 25, check: 'named the exact call and read back the result' },
  { id: 'reusability', weight: 10, check: 'named where the skill materialized' },
]

const CRITERIA_CASE: BenchmarkCase = freezeBenchmarkCase(createBenchmarkCase({
  id: 'case-criteria',
  title: 'Criteria case',
  statement: 'Persist the workflow as a reusable skill.',
  rubric: 'Human-readable summary of the four dimensions.',
  criteria: CRITERIA,
}))

const REVIEW_EVIDENCE = { completed: true, summary: 's', actions: [], observations: [], artifacts: [] }

describe('criteria-scored reviewer', () => {
  it('computes the score in code from the per-dimension verdicts', () => {
    expect(scoreFromVerdicts(CRITERIA, CRITERIA.map(c => ({ id: c.id, met: true })))).toBe(100)
    expect(scoreFromVerdicts(CRITERIA, CRITERIA.map(c => ({ id: c.id, met: false })))).toBe(0)
    // 40 + 25 = 65 of 100: the arithmetic belongs to the harness, not the model.
    expect(scoreFromVerdicts(CRITERIA, [
      { id: 'routing', met: true },
      { id: 'persistence', met: true },
      { id: 'auditability', met: false },
      { id: 'reusability', met: false },
    ])).toBe(65)
  })

  it('ignores a total the reviewer supplies anyway', () => {
    // The failure mode this guards: a model that still emits a number must not
    // be able to set the score, because then the variance is back.
    const verdict = parseReviewerVerdicts(JSON.stringify({
      verdicts: [
        { id: 'routing', met: true },
        { id: 'persistence', met: false },
        { id: 'auditability', met: false },
        { id: 'reusability', met: false },
      ],
      feedback: 'name the exact call',
      score: 3,
    }), CRITERIA)
    expect(verdict.score).toBe(40)
    expect(verdict.feedback).toBe('name the exact call')
  })

  it('fails loudly when a criterion is unanswered instead of scoring it as unmet', () => {
    // Silently defaulting an unanswered dimension would depress the score with
    // no trace in the record.
    expect(() => parseReviewerVerdicts(JSON.stringify({
      verdicts: [{ id: 'routing', met: true }],
      feedback: 'ok',
    }), CRITERIA)).toThrow(/missing verdict for criterion: persistence/)
  })

  it('rejects unknown, malformed, or duplicated verdicts', () => {
    const all = CRITERIA.map(c => ({ id: c.id, met: true }))
    const call = (verdicts: unknown) => () => parseReviewerVerdicts(JSON.stringify({ verdicts, feedback: 'ok' }), CRITERIA)
    expect(call([...all, { id: 'invented', met: true }])).toThrow(/unknown criterion id/)
    expect(call(CRITERIA.map(c => ({ id: c.id, met: 'yes' })))).toThrow(/boolean met/)
    expect(call([...all, { id: 'routing', met: false }])).toThrow(/duplicate verdict id/)
    expect(() => parseReviewerVerdicts(JSON.stringify({ verdicts: 'nope', feedback: 'ok' }), CRITERIA))
      .toThrow(/verdicts must be an array/)
    expect(call(['nope'])).toThrow(/each verdict must be an object/)
    expect(() => parseReviewerVerdicts(JSON.stringify({ verdicts: all, feedback: '  ' }), CRITERIA))
      .toThrow(/feedback must be a non-empty string/)
  })

  it('asks a criteria case for verdicts and never for a total', () => {
    const prompt = buildReviewerPrompt(CRITERIA_CASE, REVIEW_EVIDENCE)
    for (const criterion of CRITERIA) expect(prompt).toContain(criterion.check)
    expect(prompt).toContain('"verdicts"')
    expect(prompt).not.toContain('"score"')
  })

  it('keeps the legacy single-score reply for a case without criteria', () => {
    const prompt = buildReviewerPrompt(FROZEN_CASE, REVIEW_EVIDENCE)
    expect(prompt).toContain(FROZEN_CASE.rubric)
    expect(prompt).toContain('"score"')
  })

  it('scores a criteria cell with the code-computed total', async () => {
    const calls: string[] = []
    const result = await runCellEvaluation(fakeContext(calls, [VALID_EVIDENCE, {
      verdicts: CRITERIA.map(c => ({ id: c.id, met: c.id === 'routing' || c.id === 'persistence' })),
      feedback: 'add the readback',
    }]), input({ benchmarkCase: CRITERIA_CASE }))
    expect(result.status).toBe('ok')
    expect(result.score).toBe(65)
    expect(result.feedback).toBe('add the readback')
  })

  it('fails the cell when a criteria reply omits a dimension', async () => {
    const calls: string[] = []
    const result = await runCellEvaluation(fakeContext(calls, [VALID_EVIDENCE, {
      verdicts: [{ id: 'routing', met: true }],
      feedback: 'partial',
    }]), input({ benchmarkCase: CRITERIA_CASE }))
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('invalid-reviewer-verdicts')
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
  it('fails the cell on malformed executor JSON and keeps a diagnostic', async () => {
    const reply = 'the model replied with prose'
    const requests: Array<{ provider: string; model: string }> = []
    const result = await runCellEvaluation(fakeContext([], [reply], requests), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('malformed-executor-json')
    expect(result.evidence).toBeNull()
    // The diagnosis must survive the run, otherwise a malformed reply can never
    // be told apart from a truncated one after the fact.
    expect(result.failureDetail).toContain(`reply ${reply.length} chars`)
    expect(result.failureDetail).toContain(reply)
    // Only an empty reply earns the retry: a malformed one is a parser verdict.
    // Were the retry unconditional, this call would ask the provider twice and
    // the request count below would be 2, so the assertion does discriminate.
    expect(requests).toHaveLength(1)
  })

  it('retries a once-empty executor reply instead of spending the pair', async () => {
    const requests: Array<{ provider: string; model: string }> = []
    const result = await runCellEvaluation(fakeContext([], ['', VALID_EVIDENCE, VALID_SCORE], requests), input())
    // An empty reply is a lost observation, not a verdict: with an acceptance
    // bar that needs consistent pairs, spending the pair on a provider hiccup
    // is the one cost this retry exists to avoid.
    expect(result.status).toBe('ok')
    expect(result.score).toBe(82)
    expect(requests).toHaveLength(3)
  })

  it('keeps the failure when the executor replies empty twice', async () => {
    const requests: Array<{ provider: string; model: string }> = []
    const result = await runCellEvaluation(fakeContext([], [''], requests), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.evidence).toBeNull()
    expect(result.failureReason).toBe('malformed-executor-json')
    expect(result.failureDetail).toContain('reply 0 chars')
    // Exactly one retry: a second empty reply is the recorded outcome, not a
    // reason to keep calling the provider.
    expect(requests).toHaveLength(2)
  })

  it('records which field made the executor evidence malformed', async () => {
    const result = await runCellEvaluation(fakeContext([], [{ completed: true, summary: 's', actions: [], observations: [], extra: 1 }]), input())
    expect(result.status).toBe('failed')
    expect(result.score).toBeNull()
    expect(result.failureReason).toBe('malformed-executor-json')
    // The parser's own message is the difference between a wrong shape and a
    // truncated reply; discarding it left every failure indistinguishable.
    expect(result.failureDetail).toContain('unexpected executor evidence field: extra')
  })

  it('diagnoses a truncated executor reply as truncation, with a bounded tail', async () => {
    const truncated = `{"completed":true,"summary":"${'x'.repeat(400)}`
    const result = await runCellEvaluation(fakeContext([], [truncated]), input())
    expect(result.failureReason).toBe('malformed-executor-json')
    expect(result.failureDetail).toContain('the reply was truncated or empty')
    expect(result.failureDetail).toContain(`reply ${truncated.length} chars`)
    expect(result.failureDetail!.length).toBeLessThanOrEqual(600)
  })

  it('marks evidence beyond the artifact cap as a failed cell with evidence-overflow', async () => {
    // executor reply carries one more artifact than MAX_EVIDENCE_ARTIFACTS allows
    const artifacts = Array.from({ length: MAX_EVIDENCE_ARTIFACTS + 1 }, (_, index) => ({ name: `f${index}.txt`, content: 'x' }))
    const result = await runCellEvaluation(fakeContext([], [{ completed: true, summary: 's', actions: [], observations: [], artifacts }]), input())
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('evidence-overflow')
    expect(result.score).toBeNull()
  })

  it('marks evidence beyond the total byte cap as a failed cell with evidence-overflow', async () => {
    // executor reply carries one artifact larger than MAX_EVIDENCE_TOTAL_BYTES allows
    const artifacts = [{ name: 'big.txt', content: 'x'.repeat(MAX_EVIDENCE_TOTAL_BYTES + 1) }]
    const result = await runCellEvaluation(fakeContext([], [{ completed: true, summary: 's', actions: [], observations: [], artifacts }]), input())
    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('evidence-overflow')
    expect(result.score).toBeNull()
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
