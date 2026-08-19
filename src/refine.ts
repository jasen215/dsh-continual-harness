/**
 * Deterministic half of the refinement flow: edit validation, proposal
 * application with baseline conflict detection, and snapshot rollback.
 * @module dsh-continual-harness
 */

import { HARNESS_SCHEMA_VERSION, REFINEMENT_KINDS } from './domain.ts'
import type {
  AppliedRefinementEdit,
  BlastRadius,
  HarnessEntry,
  HarnessState,
  SkillEntry,
  RefinementEdit,
  RefinementKind,
  RefinementResult,
  RefinementProposal,
} from './types.ts'

/** Kind names accepted by the harness layer. */
export { REFINEMENT_KINDS }
/** Actions accepted by the harness layer. */
export const REFINEMENT_ACTIONS = ['create', 'update', 'delete'] as const
/** Identifier of the immutable base system prompt; never an editable id. */
export const BASE_SYSTEM_PROMPT_ID = 'base_system_prompt'
/** Valid blast radius values for a refinement edit. */
export const BLAST_RADIUS_VALUES: readonly BlastRadius[] = ['general', 'project', 'session']

/** Kebab-case pattern dsh requires for skill names (and the safe path form). */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Canonical serialization of an entry for baseline conflict detection. */
export function entryFingerprint(entry: HarnessEntry): string {
  return JSON.stringify({
    version: entry.version,
    content: entry.content,
    title: entry.title,
    description: entry.kind === 'skill' ? (entry as SkillEntry).description : undefined,
    reference: entry.kind === 'skill' ? (entry as SkillEntry).reference : undefined,
    arguments: entry.kind === 'skill' ? (entry as SkillEntry).arguments : undefined,
    metadata: entry.metadata,
    protection: entry.protection,
  })
}

/** Validate one edit; returns the failure reason or undefined when valid. */
export function validateEdit(edit: RefinementEdit): string | undefined {
  if (!REFINEMENT_KINDS.includes(edit.kind)) return `unknown kind: ${edit.kind}`
  if (!REFINEMENT_ACTIONS.includes(edit.action)) return `unknown action: ${edit.action}`
  if (edit.id === BASE_SYSTEM_PROMPT_ID) return 'the base system prompt is immutable'
  if (!edit.id) return 'edit id is required'
  if (edit.kind === 'skill' && !KEBAB_CASE_PATTERN.test(edit.id)) return 'skill ids must be kebab-case'
  if ((edit.action === 'update' || edit.action === 'delete')
      && (typeof edit.reason !== 'string' || edit.reason.trim() === '')) {
    return `edit "${edit.id}"缺 reason被拒绝，请补充 reason后重新提交`
  }
  if (edit.blastRadius !== undefined && !BLAST_RADIUS_VALUES.includes(edit.blastRadius)) {
    return `invalid blastRadius: ${edit.blastRadius}`
  }
  if (edit.action !== 'update' && (edit.archive !== undefined || edit.pin !== undefined)) {
    return 'archive/pin only valid on update edits'
  }
  if (edit.action !== 'delete'
      && edit.content === undefined
      && edit.archive === undefined
      && edit.pin === undefined) return 'non-delete edits require content'
  return undefined
}

/** Stamp the shared reason/blastRadius fields onto an applied edit record. */
function stampAppliedEdit(
  edit: RefinementEdit,
  fields: {
    applied: boolean
    error?: string
    before?: string
    after?: string
    beforeEntry?: HarnessEntry
    afterEntry?: HarnessEntry
  },
): AppliedRefinementEdit {
  const radius = edit.blastRadius
  // parseProposal does no field validation, so an out-of-enum value must be
  // normalized: the tool result is validated against OUTPUT_SCHEMA and an
  // invalid blastRadius would hard-fail the whole result as INVALID_TOOL_OUTPUT.
  const blastRadius: BlastRadius = radius !== undefined && BLAST_RADIUS_VALUES.includes(radius)
    ? radius
    : 'general'
  return {
    action: edit.action,
    kind: edit.kind,
    id: edit.id,
    blastRadius,
    ...(edit.reason === undefined ? {} : { reason: edit.reason }),
    ...(edit.rollbackDegraded === undefined ? {} : { rollbackDegraded: edit.rollbackDegraded }),
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
  options: {
    id: string
    rollbackOf?: string
    scope: 'local' | 'global'
    baselineState: HarnessState
    /** Entry growth fraction cap; 0 disables the check. */
    maxEntryGrowth?: number
    /** Kinds protected from the automatic path (plumbed; the per-edit rule keys off the entry's own protection). */
    protectedKinds?: readonly RefinementKind[]
    /** Global entries for the local-during-global read-only rule. */
    globalEntries?: HarnessState['entries']
    /** True when the commit rides the automatic path (gate), enabling protected-layer checks. */
    automatic?: boolean
    /** Session provenance stamped on create/content-update edits. */
    sourceSession?: string
  },
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
    // Rule 1: during a local refinement the global store is read-only. An id
    // present in the global store but absent from the local target state is an
    // unshadowed global entry; the model must create a local shadow instead.
    if (options.scope === 'local'
        && (edit.action === 'update' || edit.action === 'delete')
        && options.globalEntries?.[edit.kind]?.[edit.id] !== undefined
        && state.entries[edit.kind]?.[edit.id] === undefined) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: 'global条目在 local精修期间只读，请创建 local遮蔽条目',
      }))
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
    // Rule 2: protected entries are immutable on the automatic path; the tool
    // (explicit user session) path may still edit them.
    if (options.automatic === true
        && (edit.action === 'update' || edit.action === 'delete')
        && current!.protection !== undefined) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: '受保护条目仅显式用户会话可改',
      }))
      continue
    }
    // Rule 3: growth limit on update; empty old content skips the check.
    const growthLimit = options.maxEntryGrowth ?? 0
    if (edit.action === 'update'
        && growthLimit > 0
        && current!.content.length > 0
        && edit.content !== undefined
        && (edit.content.length - current!.content.length) / current!.content.length > growthLimit) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: '条目增长率超过 maxEntryGrowth上限',
      }))
      continue
    }
    const baseline = options.baselineState.entries[edit.kind][edit.id]
    const baselineMatches = edit.action === 'create'
      ? baseline === undefined
      : baseline !== undefined && entryFingerprint(baseline) === entryFingerprint(current!)
    if (!baselineMatches) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: 'entry changed during refinement planning',
      }))
      continue
    }
    if (edit.action === 'delete') {
      appliedEdits.push(stampAppliedEdit(edit, { before: current!.content, beforeEntry: structuredClone(current!), applied: true }))
      delete next.entries[edit.kind][edit.id]
      continue
    }
    const currentEntry = current!
    if (edit.archive !== undefined) {
      const stateNow = currentEntry.metadata?.lifecycleState ?? 'active'
      const target = edit.archive ? 'archived' : 'active'
      if (stateNow === target) {
        appliedEdits.push(stampAppliedEdit(edit, {
          applied: false,
          error: edit.archive ? 'already archived' : 'not archived',
        }))
        continue
      }
      const nextEntry: HarnessEntry = {
        ...currentEntry,
        version: currentEntry.version + 1,
        updatedAt: now,
        metadata: { ...currentEntry.metadata, lifecycleState: target },
      }
      next.entries[edit.kind][edit.id] = nextEntry
      appliedEdits.push(stampAppliedEdit(edit, {
        before: currentEntry.content,
        beforeEntry: structuredClone(currentEntry),
        after: currentEntry.content,
        afterEntry: structuredClone(nextEntry),
        applied: true,
      }))
      continue
    }
    if (edit.pin !== undefined) {
      const nextEntry: HarnessEntry = {
        ...currentEntry,
        version: currentEntry.version + 1,
        updatedAt: now,
        metadata: { ...currentEntry.metadata, pinned: edit.pin },
      }
      next.entries[edit.kind][edit.id] = nextEntry
      appliedEdits.push(stampAppliedEdit(edit, {
        before: currentEntry.content,
        beforeEntry: structuredClone(currentEntry),
        after: currentEntry.content,
        afterEntry: structuredClone(nextEntry),
        applied: true,
      }))
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
      const finalSourceSession = edit.metadata?.sourceSession ?? options.sourceSession
      const metadata = {
        ...(edit.metadata ?? {}),
        ...(finalSourceSession === undefined ? {} : { sourceSession: finalSourceSession }),
      }
      const entry = edit.kind === 'skill'
        ? {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            ...(edit.title === undefined ? {} : { title: edit.title }),
            ...(edit.description === undefined ? {} : { description: edit.description }),
            ...(edit.reference === undefined ? {} : { reference: edit.reference }),
            ...(edit.arguments === undefined ? {} : { arguments: edit.arguments }),
            ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
            updatedAt: now,
          }
        : {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            ...(edit.title === undefined ? {} : { title: edit.title }),
            ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
            updatedAt: now,
          }
      next.entries[edit.kind][edit.id] = entry
      appliedEdits.push(stampAppliedEdit(edit, { after: content, afterEntry: structuredClone(entry), applied: true }))
      continue
    }
    const finalSourceSession = edit.metadata?.sourceSession ?? options.sourceSession
    const metadata = {
      ...(currentEntry.metadata ?? {}),
      ...(edit.metadata ?? {}),
      ...(finalSourceSession === undefined ? {} : { sourceSession: finalSourceSession }),
    }
    const nextEntry = {
      ...currentEntry,
      version: currentEntry.version + 1,
      content,
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      updatedAt: now,
    }
    next.entries[edit.kind][edit.id] = nextEntry
    appliedEdits.push(stampAppliedEdit(edit, {
      before: currentEntry.content,
      beforeEntry: structuredClone(currentEntry),
      after: content,
      afterEntry: structuredClone(nextEntry),
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

/** Revert a committed result: reverse edit order, restoring full entries from
 * snapshots when available; legacy content-only records degrade and are marked. */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = []
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) continue
    const reason = `rollback:${target.id}`
    if (edit.action === 'create') {
      edits.push({ action: 'delete', kind: edit.kind, id: edit.id, reason })
    } else if (edit.action === 'delete') {
      const before: HarnessEntry | undefined = edit.beforeEntry
        ?? (edit.before === undefined ? undefined : { content: edit.before } as HarnessEntry)
      if (before === undefined) continue
      edits.push({
        action: 'create', kind: edit.kind, id: edit.id,
        ...(before.title === undefined ? {} : { title: before.title }),
        ...(before.metadata === undefined ? {} : { metadata: before.metadata }),
        content: before.content,
        reason,
        ...(edit.beforeEntry === undefined ? { rollbackDegraded: true } : {}),
      })
    } else if (edit.beforeEntry !== undefined) {
      edits.push({
        action: 'update', kind: edit.kind, id: edit.id,
        ...(edit.beforeEntry.title === undefined ? {} : { title: edit.beforeEntry.title }),
        ...(edit.beforeEntry.metadata === undefined ? {} : { metadata: edit.beforeEntry.metadata }),
        content: edit.beforeEntry.content,
        reason,
      })
    } else if (edit.before !== undefined) {
      edits.push({ action: 'update', kind: edit.kind, id: edit.id, content: edit.before, reason, rollbackDegraded: true })
    }
  }
  return {
    id: `rollback_${target.id}`,
    summary: `Rollback of ${target.id}`,
    edits,
  }
}

/** A fresh empty entries map at the current schema version. */
export function freshState(): HarnessState {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  }
}
