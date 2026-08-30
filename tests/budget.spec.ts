import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS,
  DEFAULT_TOKEN_PER_CHAR_RATIO,
  estimateCharsTokens,
  estimateMessagesChars,
  MIN_PLANNER_OUTPUT_TOKENS,
  plannerOutputBudget,
} from '../src/budget.ts'

describe('estimateCharsTokens', () => {
  it('multiplies chars by the ratio and rounds up', () => {
    expect(estimateCharsTokens(10, 0.5)).toBe(5)
    expect(estimateCharsTokens(11, 0.5)).toBe(6)
    expect(estimateCharsTokens(100, 0.25)).toBe(25)
  })

  it('clamps ratio and chars to valid ranges', () => {
    expect(estimateCharsTokens(10, 2)).toBe(10)
    expect(estimateCharsTokens(10, -1)).toBe(0)
    expect(estimateCharsTokens(-5, 0.5)).toBe(0)
  })

  it('defaults to the shared ratio', () => {
    expect(DEFAULT_TOKEN_PER_CHAR_RATIO).toBe(0.5)
  })
})

describe('estimateMessagesChars', () => {
  it('sums serialized text of user and assistant messages', () => {
    const session = Session.create(SessionId('budget'))
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'world' }] }),
    } as never, { surfaceOp: 'append' })
    expect(estimateMessagesChars(session.deriveMessages())).toBe(10)
  })

  it('skips tool-result content like messageText', () => {
    // tool-result messages contribute 0 chars via messageText
    expect(estimateMessagesChars([])).toBe(0)
  })
})

describe('plannerOutputBudget', () => {
  it('returns configured max when the window is large enough', () => {
    expect(plannerOutputBudget({
      contextWindow: 128_000,
      inputChars: 1_000,
      tokenPerCharRatio: 0.5,
      configuredMaxTokens: 32_000,
      safetyReserveTokens: 1_024,
    })).toBe(32_000)
  })

  it('shrinks output to the remaining window', () => {
    expect(plannerOutputBudget({
      contextWindow: 100_000,
      inputChars: 280_000, // 280_000 × 0.5 = 140_000 tokens → window exhausted → 0
      tokenPerCharRatio: 0.5,
      configuredMaxTokens: 32_000,
      safetyReserveTokens: 1_024,
    })).toBe(0)
    expect(plannerOutputBudget({
      contextWindow: 50_000,
      inputChars: 80_000, // 80_000 × 0.5 = 40_000 tokens
      tokenPerCharRatio: 0.5,
      configuredMaxTokens: 32_000,
      safetyReserveTokens: 1_024,
    })).toBe(8_976) // 50_000 - 40_000 - 1_024
  })

  it('exposes a minimal output floor for route feasibility', () => {
    expect(MIN_PLANNER_OUTPUT_TOKENS).toBe(4096)
    expect(DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS).toBe(1024)
  })
})
