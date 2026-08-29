/**
 * Shared benchmark-tool test scaffolding: the phase-dispatching fake llm, the
 * canned cell fixtures, and the structured-error helper. One copy so a
 * runner-call-pattern change touches a single file (the two spec copies were
 * edited in lockstep when evaluation went pair-parallel).
 * @module dsh-continual-harness
 */

import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect } from 'vitest'
import { REVIEWER_SYSTEM_PROMPT } from '../src/evaluate.ts'

export const VALID_EVIDENCE = { completed: true, summary: 'did the task', actions: [], observations: [] }
export const SCORE_70 = { score: 70, feedback: 'reference ok' }
export const SCORE_90 = { score: 90, feedback: 'candidate better' }

/** The structured failure message of a tool call. */
export function errorMessage(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected tool failure')
  return result.error.message
}

/** Llm stand-in recording provider/model and user prompts, yielding canned replies.
 *  Replies are per-cell `[executor, reviewer]` pairs in serial cell order; under
 *  pair-parallel evaluation the k-th executor call and the k-th reviewer call
 *  (both sides still arrive reference-first) map back onto that order. */
export function makeFakeLlm(
  replies: ReadonlyArray<Record<string, unknown>>,
  requests: Array<{ provider: string; model: string }> = [],
) {
  let executorCalls = 0
  let reviewerCalls = 0
  return {
    get callCount() { return executorCalls + reviewerCalls },
    async *stream(request: { provider: string; model: string; system: string }) {
      const reviewer = request.system === REVIEWER_SYSTEM_PROMPT
      const index = reviewer ? 2 * reviewerCalls + 1 : 2 * executorCalls
      const reply = replies[Math.min(index, replies.length - 1)]
      if (reviewer) reviewerCalls += 1
      else executorCalls += 1
      requests.push({ provider: request.provider, model: request.model })
      yield { type: 'text-delta' as const, text: JSON.stringify(reply) }
      yield { type: 'finish' as const, reason: { kind: 'success' as const } }
    },
  }
}
