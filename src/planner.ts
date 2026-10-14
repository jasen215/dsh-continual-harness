/**
 * LLM planning surface: one-shot JSON proposal/review generation through an
 * injected `Complete` seam, so planning is testable without a live model.
 * @module dsh-continual-harness
 */

import type { RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AutoRefineReview,
  AutoRefineReviewContext,
  RefinementPlanInput,
  RefinementProposal,
} from './types.ts'

/** Optional request-level context forwarded to the completion seam (Route A). */
export interface CompleteContext {
  /** Route A: host-loop tool schemas — reproduce the loop's cache key. */
  tools?: readonly ToolSchema[]
  /** Route A: session identity stamped on the request. */
  sessionId?: SessionId
  /** Output budget override derived from the remaining context window. */
  maxTokens?: number
}

/** One non-reasoning LLM call: system + user prompt in, plain text out. */
export type Complete = (
  /**
   * System slot for the request. `undefined` sends NO system slot at all —
   * the shape of a loop-built host request on dsh 0.1.5, whose system prompt
   * rides as the leading system-role message of `prefix`. Route A passes the
   * host's own value (usually `undefined`) so the reused prefix stays warm;
   * Route B passes an explicit prompt.
   */
  system: string | undefined,
  user: string,
  signal?: AbortSignal,
  /** Route A: warm session messages prepended before the trailing user message. */
  prefix?: readonly RequestMessage[],
  /** Request-level context (tools/sessionId/output budget) for Route A. */
  context?: CompleteContext,
) => Promise<string>

/** Raised when the model reply is truncated before its JSON object completes. */
export const TRUNCATED_JSON_ERROR = 'the model stopped before completing its JSON object; the reply was truncated or empty'

/** Raised when the model reply parses but is not a valid proposal shape. */
export const MALFORMED_PROPOSAL_ERROR = 'malformed refinement proposal'

/** Raised when the model reply parses but is not a valid review shape. */
export const MALFORMED_REVIEW_ERROR = 'malformed auto-refine review'

/** How a model reply failed to become the expected JSON object. */
export type ReplyFailure =
  /** The provider stopped at the output limit (`max-tokens`): the reply is cut. */
  | 'output-limit'
  /** The reply text never completes a `{...}` span. */
  | 'truncated-json'
  /** A complete span exists but `JSON.parse` rejects it. */
  | 'invalid-json'
  /** It parses, but the expected proposal/review fields are missing. */
  | 'malformed-shape'

/** Head excerpt bound for the reply diagnostic attached to a reply error. */
export const MAX_REPLY_HEAD_CHARS = 200
/** Tail excerpt bound; the tail is what exposes an output-limit cut. */
export const MAX_REPLY_TAIL_CHARS = 160
/** Cap on the whole reply diagnostic, so no message grows unbounded. */
export const MAX_REPLY_DETAIL_CHARS = 600

/**
 * Raised when the model's reply cannot be turned into a proposal/review. The
 * reply text IS the evidence — a raw control character, an unescaped quote, or
 * a cut-off tail — so the error carries it verbatim for logging, while the
 * message carries a bounded head/tail excerpt for the tool output.
 */
export class PlannerReplyError extends Error {
  override name = 'PlannerReplyError'
  constructor(
    /** Which way the reply was unusable; every value is retryable. */
    readonly failure: ReplyFailure,
    message: string,
    /** The raw reply, unbounded: consumers decide how much of it to keep. */
    readonly reply: string,
  ) {
    super(message)
  }
}

/**
 * Describe an unusable reply: the parser's own reason first, then the reply
 * size and a bounded head/tail excerpt. The head exposes a leaked prefix or a
 * raw control character; the tail exposes a cut-off reply. Both are needed
 * because a parse position alone cannot tell the two apart.
 */
export function describeReply(reply: string, reason: string): string {
  const head = reply.slice(0, MAX_REPLY_HEAD_CHARS)
  const tail = reply.length > MAX_REPLY_HEAD_CHARS + MAX_REPLY_TAIL_CHARS ? reply.slice(-MAX_REPLY_TAIL_CHARS) : ''
  return [
    reason,
    `reply ${reply.length} chars`,
    `head: ${head}`,
    ...(tail === '' ? [] : [`tail: ${tail}`]),
  ].join(' | ').slice(0, MAX_REPLY_DETAIL_CHARS)
}

/** Explicit JSON escape sequences for the control characters JSON names. */
const CONTROL_CHAR_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
}

/**
 * Escape raw control characters that appear INSIDE JSON string literals.
 *
 * Models writing multi-line markdown bodies inside a JSON string routinely emit
 * literal newlines/tabs, which `JSON.parse` rejects with "Bad control character
 * in string literal ...". JSON forbids raw U+0000–U+001F inside a string, so
 * escaping them is a pure repair: it cannot alter an already-valid document, and
 * whitespace between tokens is left untouched.
 */
export function escapeRawControlChars(text: string): string {
  let repaired = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true
      repaired += char
      continue
    }
    if (escaped) {
      // The previous character was a backslash: this one already carries an
      // escape's meaning (or is its payload), so it is never rewritten.
      repaired += char
      escaped = false
      continue
    }
    if (char === '\\') {
      repaired += char
      escaped = true
      continue
    }
    if (char === '"') {
      inString = false
      repaired += char
      continue
    }
    const code = char.codePointAt(0) ?? 0
    repaired += code < 0x20
      ? (CONTROL_CHAR_ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, '0')}`)
      : char
  }
  return repaired
}

/**
 * True when a failure MESSAGE means the reply was unusable rather than a
 * transport/deadline failure. In-process parse failures are typed as
 * {@link PlannerReplyError}; this stays for seams that raise the legacy worded
 * errors, so a custom `Complete` keeps the same retry behavior.
 */
export function isTruncatedReply(message: string): boolean {
  return message.startsWith(TRUNCATED_JSON_ERROR)
    || message.startsWith(MALFORMED_PROPOSAL_ERROR)
    || message.includes('Unexpected token')
    || message.includes('Unexpected end')
}

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
- 'blastRadius' is REQUIRED on every edit: one of general|project|session. It is your declaration of how far this edit reaches, and an edit that omits it is rejected — never rely on a default. 'general' (reach across projects) cannot be stored in the local layer, and 'session' (reach of this one session) cannot be stored in the global layer.
- Do NOT capture environment-dependent failures (missing binaries, missing commands, unconfigured credentials), negative assertions about tools or features ("tool X is broken"), transient session errors, one-off task narratives, or unresolved failed attempts as durable rules. Only the fix — the install command or config steps — may be captured.
- If nothing durable is worth persisting, return edits: [].
- The summary is one line.

Respond with ONLY a JSON object:
{"id":"refine_<timestamp>","summary":"one line","edits":[{"action":"create|update|delete","kind":"prompt|memory|skill|subagent","id":"kebab-case","content":"...","description":"...","files":{"scripts/oq_quantize.py":"..."},"reason":"...","blastRadius":"general"}]}`

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
  const object = parseReplyObject(text) as RefinementProposal
  if (typeof object.id !== 'string' || !Array.isArray(object.edits)) {
    throw new PlannerReplyError('malformed-shape', describeReply(text, MALFORMED_PROPOSAL_ERROR), text)
  }
  return object
}

/** Parse a review verdict from model text; JSON code fences are tolerated. */
export function parseAutoRefineReview(text: string): AutoRefineReview {
  const object = parseReplyObject(text) as AutoRefineReview
  if (typeof object.approved !== 'boolean' || typeof object.rationale !== 'string') {
    throw new PlannerReplyError('malformed-shape', describeReply(text, MALFORMED_REVIEW_ERROR), text)
  }
  return object
}

/**
 * Extract and parse the reply's JSON object, repairing raw control characters
 * inside string literals first. Every failure carries `text`, so a caller can
 * log the exact reply that was rejected instead of only a parser position.
 */
function parseReplyObject(text: string): unknown {
  let span: string
  try {
    span = extractJsonObject(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PlannerReplyError('truncated-json', describeReply(text, reason), text)
  }
  try {
    return JSON.parse(escapeRawControlChars(span))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PlannerReplyError('invalid-json', describeReply(text, `reply is not valid JSON: ${reason}`), text)
  }
}

/** Plan a refinement through the injected seam. */
export async function planRefinement(
  input: RefinementPlanInput,
  complete: Complete,
  signal?: AbortSignal,
  prefix?: readonly RequestMessage[],
  system?: string,
  context?: CompleteContext,
): Promise<RefinementProposal> {
  const routeA = prefix !== undefined
  const user = [
    // Route A: the planning rules move into the trailing user message so the
    // system slot keeps the host's own value (byte-identical to the host loop
    // request → warm prefix). Route B keeps them in the system slot.
    routeA || system !== undefined ? REFINEMENT_SYSTEM_PROMPT : '',
    `# Store scope\n${input.scopeInstruction}`,
    input.stateOverview,
    input.historyText,
    // Route A omits the trajectory block; the session prefix carries the context.
    input.trajectoryText === '' ? '' : `# Current trajectory excerpt (tail-biased)\n${input.trajectoryText}`,
    input.instructions ? `# Focus instructions\n${input.instructions}` : '',
  ].filter(Boolean).join('\n\n')
  // Route A reuses the host's system slot verbatim. On dsh 0.1.5 that slot is
  // usually `undefined` (loop-built requests carry the prompt inside `prefix`),
  // so substituting the refinement prompt here would duplicate the rules into
  // both slots and invalidate the warm prefix Route A exists to reuse.
  return parseProposal(await complete(routeA ? system : system ?? REFINEMENT_SYSTEM_PROMPT, user, signal, prefix, context))
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
