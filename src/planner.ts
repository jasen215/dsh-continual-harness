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
- 'skill' entries are real dsh skills, materialized as SKILL.md bundles: "description" is a one-line summary, "content" is the markdown body (step-by-step instructions), and the id must be kebab-case.
- Skill "content" keeps the SKILL.md body self-contained step-by-step instructions. Templates and scripts go into a structured "files" map: keys are relative paths under scripts/ or references/ (e.g. "scripts/oq_quantize.py"), values are the file contents. Use forward slashes only. Never include SKILL.md in files — it is generated from content. Keep each file small and total under the bundle limits (sizes count in UTF-8 bytes). files must be complete — every file the skill needs must be present. files are text-only — do not embed binary content.
- The harness refine path never performs a full skill-authoring loop (interviews, evals, packaging); route those to a dedicated skill-authoring capability.
- 'subagent' entries are reusable delegation specs: purpose, instructions, when to invoke.
- Prefer 'update' over creating near-duplicates; 'delete' entries that are stale, contradicted, or never useful.
- Scope policy: 'global' is only for stable cross-session lessons, durable preferences, reusable skills, and project-scoped facts; everything else belongs in 'local'. Local entries shadow same-id global entries.
- Update preference, in this order: 1) update a related entry used this session; 2) update an existing class-level umbrella entry; 3) add supporting content to an existing entry (references/templates/scripts analog); 4) only then create a new class-level entry. Never create one skill per session, and never name entries after PR numbers, raw error strings, or "fix-X-today"-style titles.
- 'reason': every 'update'/'delete' edit MUST carry a one-line 'reason' stating why this write is made; 'create' may omit it. Rollback reasons are system-generated — never supply them.
- 'blastRadius' is optional: one of general|project|session, defaulting to 'general'.
- Do NOT capture environment-dependent failures (missing binaries, missing commands, unconfigured credentials), negative assertions about tools or features ("tool X is broken"), transient session errors, one-off task narratives, or unresolved failed attempts as durable rules. Only the fix — the install command or config steps — may be captured.
- If nothing durable is worth persisting, return edits: [].
- The summary is one line.

Respond with ONLY a JSON object:
{"id":"refine_<timestamp>","summary":"one line","edits":[{"action":"create|update|delete","kind":"prompt|memory|skill|subagent","id":"kebab-case","content":"...","description":"...","files":{"scripts/oq_quantize.py":"..."},"reason":"...","blastRadius":"general"}]}
Note: 'reason' is required for 'update'/'delete' edits; 'create' may omit it. 'blastRadius' defaults to 'general'.`

/** System prompt for the automatic refinement review gate. */
export const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are the gatekeeper of an agent's continual harness. Given the current harness state, the recent refinement history, and a tail-biased trajectory excerpt, decide whether persisting a refinement NOW would materially help future steps of this session.

Approve only when the trajectory shows durable lessons: a repeated failure with an identified fix, a reusable tactic or delegation role, or a fact worth remembering. Reject when the session is too short, nothing new emerged, or the evidence is thin. You cannot see the future; base the verdict only on the evidence presented.

Negative assertions about tools or features and environment-dependent failures are NOT durable lessons (Do NOT capture).

Respond with ONLY a JSON object:
{"approved":true|false,"rationale":"one sentence"}`

/** Extract the first `{...}` span from model text, tolerating prose and code fences. */
export function extractJsonObject(text: string): string {
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
    ? 'Target store: global — entries persist across sessions and serve every session. Global writes only stable cross-session lessons: durable preferences, reusable skills, and project-scoped facts. update/delete edits must carry a reason.'
    : 'Target store: local — entries are session-scoped and shadow same-id global entries.'
}

/** Build the instruction line for an auto-triggered plan. */
export function autoRefineInstructions(reason: AutoRefineReviewContext['reason'], review: AutoRefineReview): string {
  return `Trigger: ${reason}. Gate rationale: ${review.rationale}`
}
