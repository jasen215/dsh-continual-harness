/**
 * Planner token budgeting: one shared character→token estimate ratio for both
 * routes plus the remaining-output computation against a model context window.
 * @module dsh-continual-harness
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import { messageText } from './store.ts'

/** Shared char→token estimate ratio for Route A and Route B (spec §2.2). */
export const DEFAULT_TOKEN_PER_CHAR_RATIO = 0.5

/** Tokens reserved inside the context window for safety (prompt framing etc.). */
export const DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS = 1024

/** Minimum output tokens a planner call must be able to produce; below this the route is infeasible. */
export const MIN_PLANNER_OUTPUT_TOKENS = 4096

/** Estimate tokens for a character count using the shared ratio (rounded up). */
export function estimateCharsTokens(chars: number, ratio: number): number {
  const safeRatio = Math.min(1, Math.max(0, ratio))
  return Math.ceil(Math.max(0, chars) * safeRatio)
}

/** Estimate the token weight of a message prefix from its serialized text. */
export function estimateMessagesChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + messageText(message).length, 0)
}

/** Compute the output token budget a planner call may use. */
export function plannerOutputBudget(params: {
  contextWindow: number
  inputChars: number
  tokenPerCharRatio: number
  configuredMaxTokens: number
  safetyReserveTokens: number
}): number {
  const inputTokens = estimateCharsTokens(params.inputChars, params.tokenPerCharRatio)
  const remaining = params.contextWindow - inputTokens - params.safetyReserveTokens
  return Math.max(0, Math.min(params.configuredMaxTokens, remaining))
}
