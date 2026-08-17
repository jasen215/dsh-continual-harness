/**
 * Deterministic half of the refinement flow: edit validation, proposal
 * application with baseline conflict detection, and snapshot rollback.
 * @module dsh-continual-harness
 */

import { HARNESS_SCHEMA_VERSION } from './domain.ts'
import type {
  AppliedRefinementEdit,
  HarnessState,
  RefinementEdit,
  RefinementResult,
  RefinementProposal,
} from './types.ts'

/** Kind names accepted by the harness layer. */
export const REFINEMENT_KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const
/** Actions accepted by the harness layer. */
export const REFINEMENT_ACTIONS = ['create', 'update', 'delete'] as const
/** Identifier of the immutable base system prompt; never an editable id. */
export const BASE_SYSTEM_PROMPT_ID = 'base_system_prompt'

/** Validate one edit; returns the failure reason or undefined when valid. */
export function validateEdit(edit: RefinementEdit): string | undefined {
  if (!REFINEMENT_KINDS.includes(edit.kind)) return `unknown kind: ${edit.kind}`
  if (!REFINEMENT_ACTIONS.includes(edit.action)) return `unknown action: ${edit.action}`
  if (edit.id === BASE_SYSTEM_PROMPT_ID) return 'the base system prompt is immutable'
  if (!edit.id) return 'edit id is required'
  if (edit.kind === 'skill') {
    if (edit.action === 'delete') return undefined
    if (!edit.reference) return 'skill edits require a python reference'
    if (!edit.arguments) return 'skill edits require arguments'
    return undefined
  }
  if (edit.action !== 'delete' && edit.content === undefined) return 'non-delete edits require content'
  return undefined
}

/**
 * Apply a proposal to a state snapshot with per-edit before/after snapshots.
 * Entries that changed during planning (baseline mismatch) reject their edit.
 * Returns the result and the mutated state.
 */
export function applyRefinementProposal(
  state: HarnessState,
  proposal: RefinementProposal,
  options: { id: string; rollbackOf?: string; scope: 'local' | 'global'; baselineState: HarnessState },
): { result: RefinementResult; state: HarnessState } {
  const now = new Date().toISOString()
  const appliedEdits: AppliedRefinementEdit[] = []
  const next = structuredClone(state)
  for (const edit of proposal.edits) {
    const invalid = validateEdit(edit)
    if (invalid) {
      appliedEdits.push({ action: edit.action, kind: edit.kind, id: edit.id, applied: false, error: invalid })
      continue
    }
    const current = state.entries[edit.kind][edit.id]
    if (edit.action === 'create' && current !== undefined) {
      appliedEdits.push({ action: edit.action, kind: edit.kind, id: edit.id, applied: false, error: 'entry already exists' })
      continue
    }
    if ((edit.action === 'update' || edit.action === 'delete') && current === undefined) {
      appliedEdits.push({ action: edit.action, kind: edit.kind, id: edit.id, applied: false, error: 'entry not found' })
      continue
    }
    const baseline = options.baselineState.entries[edit.kind][edit.id]
    const baselineMatches = edit.action === 'create'
      ? baseline === undefined
      : baseline !== undefined && baseline.content === current!.content
    if (!baselineMatches) {
      appliedEdits.push({
        action: edit.action,
        kind: edit.kind,
        id: edit.id,
        applied: false,
        error: 'entry changed during refinement planning',
      })
      continue
    }
    if (edit.action === 'delete') {
      appliedEdits.push({
        action: edit.action,
        kind: edit.kind,
        id: edit.id,
        before: current!.content,
        applied: true,
      })
      delete next.entries[edit.kind][edit.id]
      continue
    }
    // validateEdit guarantees content for non-delete edits; the guard keeps the
    // narrowing explicit under exactOptionalPropertyTypes.
    const content = edit.content
    if (content === undefined) {
      appliedEdits.push({ action: edit.action, kind: edit.kind, id: edit.id, applied: false, error: 'edit content is required' })
      continue
    }
    if (edit.action === 'create') {
      const entry = edit.kind === 'skill'
        ? {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            reference: edit.reference!,
            arguments: edit.arguments!,
            updatedAt: now,
          }
        : {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            updatedAt: now,
          }
      next.entries[edit.kind][edit.id] = entry
      appliedEdits.push({ action: edit.action, kind: edit.kind, id: edit.id, after: content, applied: true })
      continue
    }
    const currentEntry = current!
    next.entries[edit.kind][edit.id] = {
      ...currentEntry,
      version: currentEntry.version + 1,
      content,
      updatedAt: now,
    }
    appliedEdits.push({
      action: edit.action,
      kind: edit.kind,
      id: edit.id,
      before: currentEntry.content,
      after: content,
      applied: true,
    })
  }
  const result: RefinementResult = {
    id: options.id,
    summary: proposal.summary,
    ...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
    appliedEdits,
    committedAt: now,
    scope: options.scope,
  }
  next.refinements.push(result)
  return { result, state: next }
}

/**
 * Revert a committed result from its snapshots: reverse edit order, restoring
 * `before` content or deleting created entries.
 */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = []
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) continue
    if (edit.action === 'create') {
      edits.push({ action: 'delete', kind: edit.kind, id: edit.id })
    } else if (edit.action === 'delete') {
      if (edit.before === undefined) continue
      edits.push({ action: 'create', kind: edit.kind, id: edit.id, content: edit.before })
    } else if (edit.before !== undefined) {
      edits.push({ action: 'update', kind: edit.kind, id: edit.id, content: edit.before })
    }
  }
  return {
    id: `rollback_${target.id}`,
    summary: `Rollback of ${target.id}`,
    edits,
  }
}

/** Infer the scope of a result absent an explicit one. */
export function inferRefinementResultScope(result: RefinementResult): 'local' | 'global' {
  return result.scope
}

/** A fresh empty entries map at the current schema version. */
export function freshState(): HarnessState {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  }
}
