/**
 * Prompt rendering of harness state: a compact overview for injection, a
 * shorter routing overview, and the recent refinement history.
 * @module dsh-continual-harness
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { HarnessEntry, HarnessState, RefinementKind, RefinementResult } from './types.ts'
import { usageKey } from './usage.ts'

/** Default per-kind entry cap in the full overview. */
export const DEFAULT_ENTRIES_PER_KIND = 6
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

/** Build the ranked-injection query from the most recent effective direct-user message. */
export function buildQueryFromSession(session: Session, maxChars: number = MAX_QUERY_CHARS): string {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = (Array.isArray(event.data?.content) ? event.data.content : [])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => (block as { text: string }).text).join('\n')
    const normalized = collapseWhitespace(text)
    if (!normalized || isPurePunctuation(normalized) || ACK_PHRASES.has(normalized.toLowerCase())) continue
    return normalized.slice(0, maxChars)
  }
  return ''
}

function relevanceScore(entry: HarnessEntry, query: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  if ((entry.title ?? '').toLowerCase().includes(q)) return 2
  if (entry.content.toLowerCase().includes(q)) return 1
  return 0
}

/** Structured injection render: ranked overview and scope-qualified keys. */
export function formatHarnessStateForPromptStructured(state: HarnessState, query: string, opts: { maxPerKind?: number; sessionId: string; isLocal: (kind: RefinementKind, id: string) => boolean }): { overview: string; injectedKeys: string[] } {
  const maxPerKind = opts.maxPerKind ?? DEFAULT_ENTRIES_PER_KIND
  const lines = ['# Continual Harness State', '']
  const injectedKeys: string[] = []
  const kinds: RefinementKind[] = ['prompt', 'memory', 'skill', 'subagent']
  for (const kind of kinds) {
    const active = Object.entries(state.entries[kind])
      .filter(([key, entry]) => entry.metadata?.lifecycleState !== 'archived' && !key.startsWith('local:'))
      .map(([, entry]) => entry)
    const ranked = [...active].sort((a, b) => relevanceScore(b, query) - relevanceScore(a, query) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const selected = ranked.slice(0, maxPerKind)
    lines.push(`## ${kind} (${active.length})`)
    if (selected.length === 0) lines.push('- none')
    else {
      for (const entry of selected) {
        lines.push(formatEntry(entry, DEFAULT_CONTENT_MAX_CHARS))
        injectedKeys.push(opts.isLocal(kind, entry.id)
          ? usageKey('local', kind, entry.id, opts.sessionId)
          : usageKey('global', kind, entry.id))
      }
      if (active.length > maxPerKind) lines.push(`- … ${active.length - maxPerKind} more`)
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
  return { overview: lines.join('\n'), injectedKeys }
}

/** Render the full overview using structured rendering for compatibility. */
export function formatHarnessStateForPrompt(state: HarnessState): string {
  return formatHarnessStateForPromptStructured(state, '', { sessionId: '', isLocal: () => false }).overview
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
