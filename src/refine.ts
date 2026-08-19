/**
 * Deterministic half of the refinement flow: edit validation, proposal
 * application with baseline conflict detection, and snapshot rollback.
 * @module dsh-continual-harness
 */

import { HARNESS_SCHEMA_VERSION } from './domain.ts'
import type {
  AppliedRefinementEdit,
  BlastRadius,
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
/** Valid blast radius values for a refinement edit. */
export const BLAST_RADIUS_VALUES: readonly BlastRadius[] = ['general', 'project', 'session']

/** Kebab-case pattern dsh requires for skill names (and the safe path form). */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Validate one edit; returns the failure reason or undefined when valid. */
export function validateEdit(edit: RefinementEdit): string | undefined {
  if (!REFINEMENT_KINDS.includes(edit.kind)) return `unknown kind: ${edit.kind}`
  if (!REFINEMENT_ACTIONS.includes(edit.action)) return `unknown action: ${edit.action}`
  if (edit.id === BASE_SYSTEM_PROMPT_ID) return 'the base system prompt is immutable'
  if (!edit.id) return 'edit id is required'
  if (edit.kind === 'skill' && !KEBAB_CASE_PATTERN.test(edit.id)) return 'skill ids must be kebab-case'
  if ((edit.action === 'update' || edit.action === 'delete')
      && (edit.reason === undefined || edit.reason.trim() === '')) {
    return `edit "${edit.id}"缺 reason被拒绝，请补充 reason后重新提交`
  }
  if (edit.blastRadius !== undefined && !BLAST_RADIUS_VALUES.includes(edit.blastRadius)) {
    return `invalid blastRadius: ${edit.blastRadius}`
  }
  if (edit.action !== 'delete' && edit.content === undefined) return 'non-delete edits require content'
  return undefined
}

/** Stamp the shared reason/blastRadius fields onto an applied edit record. */
function stampAppliedEdit(
  edit: RefinementEdit,
  fields: { applied: boolean; error?: string; before?: string; after?: string },
): AppliedRefinementEdit {
  return {
    action: edit.action,
    kind: edit.kind,
    id: edit.id,
    blastRadius: edit.blastRadius ?? 'general',
    ...(edit.reason === undefined ? {} : { reason: edit.reason }),
    ...fields,
  }
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
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: invalid }))
      continue
    }
    const current = state.entries[edit.kind][edit.id]
    if (edit.action === 'create' && current !== undefined) {
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: 'entry already exists' }))
      continue
    }
    if ((edit.action === 'update' || edit.action === 'delete') && current === undefined) {
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: 'entry not found' }))
      continue
    }
    const baseline = options.baselineState.entries[edit.kind][edit.id]
    const baselineMatches = edit.action === 'create'
      ? baseline === undefined
      : baseline !== undefined && baseline.content === current!.content
    if (!baselineMatches) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: 'entry changed during refinement planning',
      }))
      continue
    }
    if (edit.action === 'delete') {
      appliedEdits.push(stampAppliedEdit(edit, { before: current!.content, applied: true }))
      delete next.entries[edit.kind][edit.id]
      continue
    }
    // validateEdit guarantees content for non-delete edits; the guard keeps the
    // narrowing explicit under exactOptionalPropertyTypes.
    const content = edit.content
    if (content === undefined) {
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: 'edit content is required' }))
      continue
    }
    if (edit.action === 'create') {
      const entry = edit.kind === 'skill'
        ? {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            ...(edit.description === undefined ? {} : { description: edit.description }),
            ...(edit.reference === undefined ? {} : { reference: edit.reference }),
            ...(edit.arguments === undefined ? {} : { arguments: edit.arguments }),
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
      appliedEdits.push(stampAppliedEdit(edit, { after: content, applied: true }))
      continue
    }
    const currentEntry = current!
    next.entries[edit.kind][edit.id] = {
      ...currentEntry,
      version: currentEntry.version + 1,
      content,
      updatedAt: now,
    }
    appliedEdits.push(stampAppliedEdit(edit, {
      before: currentEntry.content,
      after: content,
      applied: true,
    }))
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

/** Revert a committed result from its snapshots: reverse edit order, restoring
 * `before` content or deleting created entries.
 */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = []
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) continue
    const reason = `rollback:${target.id}`
    if (edit.action === 'create') {
      edits.push({ action: 'delete', kind: edit.kind, id: edit.id, reason })
    } else if (edit.action === 'delete') {
      if (edit.before === undefined) continue
      edits.push({ action: 'create', kind: edit.kind, id: edit.id, content: edit.before, reason })
    } else if (edit.before !== undefined) {
      edits.push({ action: 'update', kind: edit.kind, id: edit.id, content: edit.before, reason })
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
