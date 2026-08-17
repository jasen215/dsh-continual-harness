/**
 * Prompt rendering of harness state: a compact overview for injection, a
 * shorter routing overview, and the recent refinement history.
 * @module dsh-continual-harness
 */

import type { HarnessState, RefinementKind, RefinementResult } from './types.ts'

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

function formatEntry(entry: { id: string; version: number; content: string; reference?: string; arguments?: string }, max: number): string {
  const contract = entry.reference !== undefined && entry.arguments !== undefined
    ? ` | reference: ${entry.reference} | arguments: ${entry.arguments}`
    : ''
  return `- ${entry.id} v${entry.version}: ${truncate(entry.content, max)}${contract}`
}

/** Render the full `# Continual Harness State` overview block. */
export function formatHarnessStateForPrompt(state: HarnessState): string {
  const lines = ['# Continual Harness State', '']
  const kinds: RefinementKind[] = ['prompt', 'memory', 'skill', 'subagent']
  for (const kind of kinds) {
    const records = Object.values(state.entries[kind])
    lines.push(`## ${kind} (${records.length})`)
    if (records.length === 0) {
      lines.push('- none')
    } else {
      for (const entry of records.slice(-DEFAULT_ENTRIES_PER_KIND)) {
        lines.push(formatEntry(entry, DEFAULT_CONTENT_MAX_CHARS))
      }
      if (records.length > DEFAULT_ENTRIES_PER_KIND) {
        lines.push(`- … ${records.length - DEFAULT_ENTRIES_PER_KIND} more`)
      }
    }
    lines.push('')
  }
  lines.push(`## recent refinements (${state.refinements.length})`)
  if (state.refinements.length === 0) {
    lines.push('- none')
  } else {
    for (const result of state.refinements.slice(-DEFAULT_REFINEMENTS_IN_OVERVIEW)) {
      const applied = result.appliedEdits.filter(edit => edit.applied).length
      const failed = result.appliedEdits.length - applied
      lines.push(`- ${result.id} (${result.scope}, +${applied}${failed > 0 ? `, ${failed} failed` : ''}): ${truncate(result.summary, DEFAULT_CONTENT_MAX_CHARS)}`)
    }
  }
  return lines.join('\n')
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
