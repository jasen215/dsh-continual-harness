/**
 * Prompt rendering of harness state: a compact overview for injection, a
 * shorter routing overview, and the recent refinement history.
 * @module dsh-continual-harness
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { HarnessEntry, HarnessState, RefinementKind, RefinementResult } from './types.ts'
import { usageKey } from './usage.ts'

/** Default per-kind entry cap in the full overview. */
export const DEFAULT_ENTRIES_PER_KIND = 6
/** Default index length in stable-anchor mode. */
export const DEFAULT_INDEX_LINES = 15
/** What the injected block is ranked against. */
export type InjectionAnchor = 'query' | 'stable'
/** Header note that tells the model how the stable block's index was chosen. */
export const STABLE_ANCHOR_NOTE = 'session opening request + project cwd (stable for this session; read entries on demand)'
/** Default content truncation length. */
export const DEFAULT_CONTENT_MAX_CHARS = 180
/** Default refinement history length in the overview. */
export const DEFAULT_REFINEMENTS_IN_OVERVIEW = 5
/** Default per-kind cap in the routing overview. */
export const DEFAULT_OVERVIEW_PER_KIND = 40

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function formatEntry(
  entry: {
    id: string
    version: number
    content: string
    description?: string
    reference?: string
    arguments?: string
    files?: Record<string, string>
  },
  max: number,
): string {
  const summary = entry.description !== undefined && entry.description !== ''
    ? entry.description
    : entry.content
  const legacy = entry.reference !== undefined && entry.arguments !== undefined
    ? ` | reference: ${entry.reference} | arguments: ${entry.arguments}`
    : ''
  const fileKeys = entry.files === undefined ? [] : Object.keys(entry.files)
  const filesNote = fileKeys.length === 0
    ? ''
    : ` | files: ${fileKeys.join(', ')}`
  return `- ${entry.id} v${entry.version}: ${truncate(summary, max)}${legacy}${filesNote}`
}

/** Max query length fed to ranking. */
export const MAX_QUERY_CHARS = 400
/** Full-message acknowledgement phrases dropped from the query. */
export const ACK_PHRASES: ReadonlySet<string> = new Set(['好', '好的', '可以', '行', '收到', '明白', '继续', '谢谢', 'ok', 'okay', 'yes', 'thanks'])

function collapseWhitespace(text: string): string { return text.replace(/\s+/g, ' ').trim() }
function isPurePunctuation(text: string): boolean { return text.length > 0 && !/[\p{L}\p{N}]/u.test(text) }

/**
 * Normalized direct-user text of one message, or undefined when the message is
 * not usable as text (not a direct user message, empty, punctuation only, or a
 * bare acknowledgement).
 */
function userCandidate(message: Message | undefined): string | undefined {
  if (message === undefined || message.source.kind !== 'user') return undefined
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => (block as { text: string }).text).join('\n')
  const normalized = collapseWhitespace(text)
  if (!normalized || isPurePunctuation(normalized) || ACK_PHRASES.has(normalized.toLowerCase())) return undefined
  return normalized
}

/**
 * Build the ranked-injection query from the most recent effective direct-user
 * message.
 *
 * Reads the session's derived history rather than the event log: that array is
 * the current model-visible projection (a raw event with no surface marker is
 * absent, a compaction replace removes shadowed nodes, and plugin-owned message
 * changes arrive already applied), which is the transcript the query ranks
 * against. It also avoids `snapshotEvents()`, a synchronous history read whose
 * new uses are prohibited.
 */
export function buildQueryFromSession(session: Session, maxChars: number = MAX_QUERY_CHARS): string {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = userCandidate(messages[index])
    if (candidate !== undefined) return candidate.slice(0, maxChars)
  }
  return ''
}

/** Text ranked against in stable mode: the session's opening request plus its project identity. */
export function buildStableAnchor(session: Session, maxChars: number = MAX_QUERY_CHARS): string {
  const parts: string[] = []
  const cwd = session.header.cwd
  if (cwd !== undefined && cwd !== '') parts.push(cwd)
  for (const message of session.deriveMessages()) {
    const candidate = userCandidate(message)
    if (candidate !== undefined) {
      parts.push(candidate)
      break
    }
  }
  return collapseWhitespace(parts.join(' ')).slice(0, maxChars)
}

/** Weight of one query term found in an entry title rather than its content. */
const TITLE_TERM_WEIGHT = 2
/** Shortest latin/digit term worth ranking on; shorter runs are too common to discriminate. */
const MIN_LATIN_TERM_CHARS = 2
/**
 * Share of a ranked corpus a term may appear in and still count.
 *
 * A term shared with a large share of the corpus says nothing about which entry
 * answers the query. Measured over the live 73-entry state with 13 anchor
 * queries: dropping terms above this share took slots filled purely by generic
 * phrasing (a generic "about this X question" wrapper) from 26–34 of 78 to 0 of
 * 78 while keeping every anchor term (13/13, identical anywhere in the 5–20%
 * range).
 */
const MAX_TERM_CORPUS_SHARE = 0.1
const CJK_SCRIPTS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
/**
 * One CJK run, or one non-CJK letter/digit run. The lookahead is load-bearing:
 * Han characters are `\p{L}`, so without it a bare latin word followed by Han
 * characters would be swallowed whole and shingled into junk terms (`he`, `rm`,
 * `es`) that match unrelated English content.
 */
const QUERY_RUN_PATTERN = new RegExp(`[${CJK_SCRIPTS}]+|(?:(?![${CJK_SCRIPTS}])[\\p{L}\\p{N}])+`, 'gu')
const CJK_CHAR_PATTERN = new RegExp(`[${CJK_SCRIPTS}]`, 'u')

/**
 * Split a ranking query into the terms that actually get matched.
 *
 * The query is a whole user message, so matching it as one substring matched
 * nothing in practice: over the live state a natural Chinese sentence scored
 * zero hits, which silently degraded injection to pure recency and made every
 * entry outside the newest `maxPerKind` unreachable. Terms are matched
 * individually instead, and a CJK run is matched as two-character shingles
 * because single Chinese characters are far too common to discriminate.
 */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const run of query.toLowerCase().match(QUERY_RUN_PATTERN) ?? []) {
    if (!CJK_CHAR_PATTERN.test(run)) {
      if (run.length >= MIN_LATIN_TERM_CHARS) terms.add(run)
      continue
    }
    if (run.length === 1) terms.add(run)
    else for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2))
  }
  return [...terms]
}

/**
 * Weight each query term for one corpus: terms shared with more than
 * `MAX_TERM_CORPUS_SHARE` of it are dropped as non-discriminative, and the rest
 * are weighted by inverse document frequency so that a rare term outranks a
 * common one that happens to be mentioned in the same message.
 */
function termWeights(entries: readonly HarnessEntry[], terms: readonly string[]): Map<string, number> {
  // Never drop a term exactly one entry has: on a small corpus every term would
  // otherwise exceed the share and ranking would collapse back to recency.
  const maxDocumentFrequency = Math.max(1, entries.length * MAX_TERM_CORPUS_SHARE)
  const frequencies = new Map<string, number>()
  for (const term of terms) {
    let documentFrequency = 0
    for (const entry of entries) {
      if (entry.content.toLowerCase().includes(term) || (entry.title ?? '').toLowerCase().includes(term)) documentFrequency += 1
    }
    frequencies.set(term, documentFrequency)
  }
  // When every term exceeds the share the query is nothing but corpus-wide words
  // ("hermes", "memory"). There is no rarer evidence to rank on, so dropping the
  // lot would score every entry 0 and silently degrade the ranking to recency —
  // measured: the newest unrelated entry wins over the entries the query names.
  const kept = terms.filter(term => (frequencies.get(term) ?? 0) <= maxDocumentFrequency)
  const effective = kept.length > 0 ? kept : terms
  const weights = new Map<string, number>()
  for (const term of effective) {
    weights.set(term, Math.log(1 + entries.length / (1 + (frequencies.get(term) ?? 0))))
  }
  return weights
}

function relevanceScore(entry: HarnessEntry, weights: ReadonlyMap<string, number>): number {
  if (weights.size === 0) return 0
  const title = (entry.title ?? '').toLowerCase()
  const content = entry.content.toLowerCase()
  let score = 0
  for (const [term, weight] of weights) {
    if (title.includes(term)) score += TITLE_TERM_WEIGHT * weight
    else if (content.includes(term)) score += weight
  }
  return score
}

/**
 * Structured injection render: ranked overview, scope-qualified keys, and the
 * subset of those keys that actually matched the anchor (`matchedKeys`).
 *
 * `matchedKeys` exists so callers can tell a response to the current question
 * apart from recency filler: a follow-up message that matches nothing still
 * reorders the selection, and re-injecting on that alone would trade relevant
 * experience for the newest entries.
 *
 * With `indexLines`, the per-kind sections shrink to counts and one ranked
 * index of `indexLines` id lines replaces them. The index is what a
 * session-stable anchor can afford to rerender: it carries routing hints at a
 * fraction of the tokens, so a block that must stay byte-stable across turns
 * stays small, and detail moves to on-demand reads through the tool.
 *
 * `project` orders the index by ownership before relevance. A session-stable
 * anchor is built from the opening request, whose terms are corpus-wide on this
 * state (measured: `dsh` df=26, `harness` df=20 against 75 entries, both dropped
 * as non-discriminative, leaving an index 80% identical to plain recency), and
 * no amount of term weighting recovers a fact that is not in the text. Ownership
 * is that fact: entries of the working project first, project-agnostic entries
 * next, other projects' entries last — a rank, never a filter, so a mis-tagged
 * entry is outranked rather than silently unreachable.
 */
export function formatHarnessStateForPromptStructured(state: HarnessState, query: string, opts: { maxPerKind?: number; sessionId: string; isLocal: (kind: RefinementKind, id: string) => boolean; indexLines?: number; anchorNote?: string; project?: string }): { overview: string; injectedKeys: string[]; matchedKeys: string[] } {
  const maxPerKind = opts.maxPerKind ?? DEFAULT_ENTRIES_PER_KIND
  const indexLines = opts.indexLines ?? 0
  const lines = ['# Continual Harness State', '']
  if (opts.anchorNote !== undefined && opts.anchorNote !== '') lines.push(`anchor: ${opts.anchorNote}`, '')
  const injectedKeys: string[] = []
  const matchedKeys: string[] = []
  const kinds: RefinementKind[] = ['prompt', 'memory', 'skill', 'subagent']
  const terms = queryTerms(query)
  const scoredAll: { kind: RefinementKind; entry: HarnessEntry; score: number }[] = []
  for (const kind of kinds) {
    const active = Object.entries(state.entries[kind])
      .filter(([key, entry]) => entry.metadata?.lifecycleState !== 'archived' && !key.startsWith('local:'))
      .map(([, entry]) => entry)
    const weights = termWeights(active, terms)
    const scored = active
      .map(entry => ({ entry, score: relevanceScore(entry, weights) }))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id))
    lines.push(`## ${kind} (${active.length})`)
    if (indexLines > 0) {
      scoredAll.push(...scored.map(({ entry, score }) => ({ kind, entry, score })))
      lines.push('')
      continue
    }
    const selected = scored.slice(0, maxPerKind)
    if (selected.length === 0) lines.push('- none')
    else {
      for (const { entry, score } of selected) {
        lines.push(formatEntry(entry, DEFAULT_CONTENT_MAX_CHARS))
        const key = opts.isLocal(kind, entry.id)
          ? usageKey('local', kind, entry.id, opts.sessionId)
          : usageKey('global', kind, entry.id)
        injectedKeys.push(key)
        // Score > 0 means the entry matched a query term; the rest are recency
        // fillers. Re-injection is gated on this difference.
        if (score > 0) matchedKeys.push(key)
      }
      if (active.length > maxPerKind) lines.push(`- … ${active.length - maxPerKind} more`)
    }
    lines.push('')
  }
  if (indexLines > 0) {
    const projectRank = (entry: HarnessEntry): number => {
      if (opts.project === undefined) return 0
      const tags = entry.projects
      if (tags === undefined || tags.length === 0) return 1
      return tags.includes(opts.project) ? 2 : 0
    }
    const ranked = scoredAll
      .sort((a, b) => projectRank(b.entry) - projectRank(a.entry)
        || b.score - a.score
        || b.entry.updatedAt.localeCompare(a.entry.updatedAt)
        || a.entry.id.localeCompare(b.entry.id))
      .slice(0, indexLines)
    lines.push(`## index (${scoredAll.length} entries, top ${ranked.length})`)
    if (ranked.length === 0) lines.push('- none')
    else {
      for (const { kind, entry, score } of ranked) {
        lines.push(`- ${kind}/${entry.id} v${entry.version}`)
        const key = opts.isLocal(kind, entry.id)
          ? usageKey('local', kind, entry.id, opts.sessionId)
          : usageKey('global', kind, entry.id)
        injectedKeys.push(key)
        if (score > 0) matchedKeys.push(key)
      }
      if (scoredAll.length > ranked.length) lines.push(`- … ${scoredAll.length - ranked.length} more`)
      // An anchor that matches nothing leaves only recency order, which is a
      // stable block of little use. Say so instead of letting it look ranked.
      if (matchedKeys.length === 0) lines.push(`- note: anchor matched no entry; this index is recency-ordered`)
    }
    lines.push('')
  }
  lines.push(`## recent refinements (${state.refinements.length})`)
  if (state.refinements.length === 0) lines.push('- none')
  else for (const result of state.refinements.slice(-DEFAULT_REFINEMENTS_IN_OVERVIEW)) {
    const applied = result.appliedEdits.filter(edit => edit.applied).length
    const failed = result.appliedEdits.length - applied
    lines.push(`- ${result.id} (${result.scope}, +${applied}${failed > 0 ? `, ${failed} failed` : ''}): ${truncate(result.summary, DEFAULT_CONTENT_MAX_CHARS)}`)
  }
  return { overview: lines.join('\n'), injectedKeys, matchedKeys }
}

/** Render a shorter routing overview (more entries, truncated content). */
export function overviewForPrompt(state: HarnessState): string {
  const lines = ['# Continual Harness State', '']
  const kinds: RefinementKind[] = ['prompt', 'memory', 'skill', 'subagent']
  for (const kind of kinds) {
    const records = Object.values(state.entries[kind])
    lines.push(`## ${kind} (${records.length})`)
    if (records.length === 0) {
      lines.push('- none')
    } else {
      for (const entry of records.slice(-DEFAULT_OVERVIEW_PER_KIND)) {
        lines.push(formatEntry(entry, DEFAULT_CONTENT_MAX_CHARS))
      }
      if (records.length > DEFAULT_OVERVIEW_PER_KIND) {
        lines.push(`- … ${records.length - DEFAULT_OVERVIEW_PER_KIND} more`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Render the recent refinement history fed to the planner. */
export function historyForPrompt(results: RefinementResult[], max: number = 20): string {
  const lines = [`# Recent Harness Refinements (${results.length})`]
  for (const result of results.slice(-max)) {
    lines.push(`- ${result.id} (${result.scope}${result.rollbackOf ? `, rollback of ${result.rollbackOf}` : ''}): ${result.summary}`)
  }
  return lines.join('\n')
}
