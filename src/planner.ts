/**
 * LLM planning surface: one-shot JSON proposal/review generation through an
 * injected `Complete` seam, so planning is testable without a live model.
 * @module dsh-continual-harness
 */

import type {
  AutoRefineReview,
  AutoRefineReviewContext,
  RefinementPlanInput,
  RefinementProposal,
} from './types.ts'

/** One non-reasoning LLM call: system + user prompt in, plain text out. */
export type Complete = (system: string, user: string, signal?: AbortSignal) => Promise<string>

/** Raised when the model reply is truncated before its JSON object completes. */
export const TRUNCATED_JSON_ERROR = 'the model stopped before completing its JSON object; the reply was truncated or empty'

/** System prompt for refinement planning. */
export const REFINEMENT_SYSTEM_PROMPT = `You are the continual harness refiner of an agent loop. The agent learns by persisting small, reusable, evidence-backed entries — prompt notes, memories, skill contracts, or subagent specs — and by pruning stale ones.

You receive the current harness state, the recent refinement history, a tail-biased trajectory excerpt of the current session, and the store scope. Propose a minimal set of edits that capture durable lessons. Rules:

- Edits must be small and evidence-backed by the trajectory; never invent facts.
- ids are lowercase kebab-case, unique within (scope, kind).
- 'prompt' entries are supplemental prompt notes; the base system prompt is immutable and never edited.
- 'memory' entries are durable facts, decisions, failures, preferences, and outcomes.
- 'skill' entries MUST include a python \`reference\` (the runnable skill the Python REPL resolves) and \`arguments\` (a JSON description of accepted arguments).
- 'subagent' entries are reusable delegation specs: purpose, instructions, when to invoke.
- Prefer 'update' over creating near-duplicates; 'delete' entries that are stale, contradicted, or never useful.
- If nothing durable is worth persisting, return edits: [].
- The summary is one line.

Respond with ONLY a JSON object:
{"id":"refine_<timestamp>","summary":"one line","edits":[{"action":"create|update|delete","kind":"prompt|memory|skill|subagent","id":"kebab-case","content":"...","reference":"...","arguments":"..."}]}`

/** System prompt for the automatic refinement review gate. */
export const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are the gatekeeper of an agent's continual harness. Given the current harness state, the recent refinement history, and a tail-biased trajectory excerpt, decide whether persisting a refinement NOW would materially help future steps of this session.

Approve only when the trajectory shows durable lessons: a repeated failure with an identified fix, a reusable tactic or delegation role, or a fact worth remembering. Reject when the session is too short, nothing new emerged, or the evidence is thin. You cannot see the future; base the verdict only on the evidence presented.

Respond with ONLY a JSON object:
{"approved":true|false,"rationale":"one sentence"}`

function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(TRUNCATED_JSON_ERROR)
  return text.slice(start, end + 1)
}

/** Parse a refinement proposal from model text; JSON code fences are tolerated. */
export function parseProposal(text: string): RefinementProposal {
  const object = JSON.parse(extractJsonObject(text)) as RefinementProposal
  if (typeof object.id !== 'string' || !Array.isArray(object.edits)) {
    throw new Error('malformed refinement proposal')
  }
  return object
}

/** Parse a review verdict from model text; JSON code fences are tolerated. */
export function parseAutoRefineReview(text: string): AutoRefineReview {
  const object = JSON.parse(extractJsonObject(text)) as AutoRefineReview
  if (typeof object.approved !== 'boolean' || typeof object.rationale !== 'string') {
    throw new Error('malformed auto-refine review')
  }
  return object
}

/** Plan a refinement through the injected seam. */
export async function planRefinement(
  input: RefinementPlanInput,
  complete: Complete,
  signal?: AbortSignal,
): Promise<RefinementProposal> {
  const user = [
    `# Store scope\n${input.scopeInstruction}`,
    input.stateOverview,
    input.historyText,
    `# Current trajectory excerpt (tail-biased)\n${input.trajectoryText}`,
    input.instructions ? `# Focus instructions\n${input.instructions}` : '',
  ].filter(Boolean).join('\n\n')
  return parseProposal(await complete(REFINEMENT_SYSTEM_PROMPT, user, signal))
}

/** Run the automatic refinement review gate through the injected seam. */
export async function reviewAutoRefine(
  context: AutoRefineReviewContext,
  complete: Complete,
  signal?: AbortSignal,
): Promise<AutoRefineReview> {
  const user = [
    `# Trigger\nreason: ${context.reason}`,
    context.stateOverview,
    context.historyText,
    `# Current trajectory excerpt (tail-biased)\n${context.trajectoryText}`,
  ].filter(Boolean).join('\n\n')
  return parseAutoRefineReview(await complete(AUTO_REFINE_REVIEW_SYSTEM_PROMPT, user, signal))
}

/** Build the store-scope instruction line for the planner. */
export function scopeInstruction(global: boolean): string {
  return global
    ? 'Target store: global — entries persist across sessions and serve every session.'
    : 'Target store: local — entries are session-scoped and shadow same-id global entries.'
}

/** Build the instruction line for an auto-triggered plan. */
export function autoRefineInstructions(reason: AutoRefineReviewContext['reason'], review: AutoRefineReview): string {
  return `Trigger: ${reason}. Gate rationale: ${review.rationale}`
}
