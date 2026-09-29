/**
 * Deterministic half of the refinement flow: edit validation, proposal
 * application with baseline conflict detection, and the entry↔edit field
 * mapping shared with rollback (see ./rollback.ts) and promote.
 * @module dsh-continual-harness
 */

import { BLAST_RADIUS_VALUES, HARNESS_SCHEMA_VERSION, KEBAB_CASE_PATTERN, REFINEMENT_KINDS, isBlastRadius } from './domain.ts'
import { validateBundleFiles } from './skills.ts'
import type { SkillBundleLimits } from './skills.ts'
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
/** Existing importers may continue importing this shared constant from refine.ts. */
export { KEBAB_CASE_PATTERN }
/** The same compatibility re-export this constant has always had from here. */
export { BLAST_RADIUS_VALUES }

/** Canonical serialization of an entry for baseline conflict detection. */
export function entryFingerprint(entry: HarnessEntry): string {
  return JSON.stringify({
    version: entry.version,
    content: entry.content,
    title: entry.title,
    description: entry.kind === 'skill' ? (entry as SkillEntry).description : undefined,
    reference: entry.kind === 'skill' ? (entry as SkillEntry).reference : undefined,
    arguments: entry.kind === 'skill' ? (entry as SkillEntry).arguments : undefined,
    files: entry.kind === 'skill'
      ? Object.fromEntries(Object.entries((entry as SkillEntry).files ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      : undefined,
    metadata: entry.metadata,
    protection: entry.protection,
    blastRadius: entry.blastRadius,
  })
}

/** Validate one edit; returns the failure reason or undefined when valid. */
export function validateEdit(
  edit: RefinementEdit,
  opts: { skillBundleLimits?: SkillBundleLimits; scope?: 'local' | 'global'; replay?: boolean } = {},
): string | undefined {
  if (!REFINEMENT_KINDS.includes(edit.kind)) return `unknown kind: ${edit.kind}`
  if (!REFINEMENT_ACTIONS.includes(edit.action)) return `unknown action: ${edit.action}`
  if (edit.id === BASE_SYSTEM_PROMPT_ID) return 'the base system prompt is immutable'
  if (!edit.id) return 'edit id is required'
  if (edit.kind === 'skill' && !KEBAB_CASE_PATTERN.test(edit.id)) return 'skill ids must be kebab-case'
  if ((edit.action === 'update' || edit.action === 'delete')
      && (typeof edit.reason !== 'string' || edit.reason.trim() === '')) {
    return `edit "${edit.id}" rejected: missing reason, please re-add it`
  }
  if (edit.blastRadius === undefined) {
    // 3.4.1: an omission is a missing declaration, not 'unspecified', so it is
    // rejected rather than defaulted. Two writers may omit it: a delete claims
    // no reach at all, and a replay (rollback) re-states recorded history
    // instead of declaring reach.
    if (opts.replay !== true && edit.action !== 'delete') {
      return `edit "${edit.id}" rejected: missing blastRadius, please re-add it`
    }
  } else if (!isBlastRadius(edit.blastRadius)) {
    return `invalid blastRadius: ${edit.blastRadius}`
  } else if (opts.scope !== undefined) {
    // 3.4.1 mutual exclusions, checked against the DESTINATION layer: 'general'
    // claims reach across projects, so it cannot live in the session-local
    // store; 'session' claims one session, so it cannot live where every
    // session reads it. This is the write-time half of the gap 9 fix, and it is
    // why promoting a session-radius local entry to global is rejected. Declared
    // values only: records carry a schema fallback, and treating that fallback
    // as a declaration is a bug (see the create branch of rollbackProposal).
    if (opts.scope === 'local' && edit.blastRadius === 'general') {
      return `edit "${edit.id}" rejected: blastRadius 'general' cannot target the local scope`
    }
    if (opts.scope === 'global' && edit.blastRadius === 'session') {
      return `edit "${edit.id}" rejected: blastRadius 'session' cannot target the global scope`
    }
  }
  if (edit.action !== 'update' && (edit.archive !== undefined || edit.pin !== undefined)) {
    return 'archive/pin only valid on update edits'
  }
  if (edit.action !== 'delete'
      && edit.content === undefined
      && edit.archive === undefined
      && edit.pin === undefined) return 'non-delete edits require content'
  if (edit.kind === 'skill' && edit.files !== undefined) {
    const failure = validateBundleFiles(edit.files, opts.skillBundleLimits)
    if (failure) return `edit "${edit.id}" rejected: ${failure}`
  }
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
  const blastRadius: BlastRadius = isBlastRadius(radius)
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
    /** Kinds the automatic path may not edit at all (create/update/delete). */
    protectedKinds?: readonly RefinementKind[]
    /** Global entries for the local-during-global read-only rule. */
    globalEntries?: HarnessState['entries']
    /** True when the commit rides the automatic path (gate), enabling protected-layer checks. */
    automatic?: boolean
    /** Session provenance stamped on create/content-update edits. */
    sourceSession?: string
    /**
     * Repository the commit is applied in, stamped onto created/updated entries
     * so ranking can prefer this project's entries. Omitted by replay paths
     * (rollback, benchmark derivation) that must stay independent of the machine
     * they run on.
     */
    project?: string
    /** Bundle limits passed to validateEdit for skill files (spec §7.4). */
    skillBundleLimits?: SkillBundleLimits
    /** Per-edit veto hook (e.g. fs-backed create-conflict checks); returns the failure reason. */
    editGate?: (edit: RefinementEdit) => string | undefined
  },
): { result: RefinementResult; state: HarnessState } {
  const now = new Date().toISOString()
  const appliedEdits: AppliedRefinementEdit[] = []
  const next = structuredClone(state)
  for (const edit of proposal.edits) {
    const invalid = validateEdit(edit, {
      ...(options.skillBundleLimits === undefined ? {} : { skillBundleLimits: options.skillBundleLimits }),
      scope: options.scope,
      replay: options.rollbackOf !== undefined,
    })
    if (invalid) {
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: invalid }))
      continue
    }
    // Every write branch below stamps the declared reach, so a declaration the
    // validator forces the model to make is never silently dropped on the floor
    // (archive/pin rebuild the entry from the current one).
    const radiusFields = edit.blastRadius === undefined ? {} : { blastRadius: edit.blastRadius }
    const gated = options.editGate?.(edit)
    if (gated) {
      appliedEdits.push(stampAppliedEdit(edit, { applied: false, error: gated }))
      continue
    }
    // Rule 1a: kinds listed in protectedKinds are immutable on the automatic
    // path — every edit (create/update/delete) on such a kind is rejected.
    // The per-entry `protection` guard (Rule 2) stays as an additional check.
    if (options.automatic === true && options.protectedKinds?.includes(edit.kind)) {
      appliedEdits.push(stampAppliedEdit(edit, {
        applied: false,
        error: `kind ${edit.kind} is protected from automatic refinement`,
      }))
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
        error: 'global entries are read-only during a local refinement; create a local shadow first',
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
        error: 'protected entries are mutable only in explicit user sessions',
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
        error: 'entry growth exceeds the maxEntryGrowth cap',
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
        ...radiusFields,
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
        ...radiusFields,
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
        ...edit.metadata,
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
            ...(edit.files === undefined ? {} : { files: edit.files }),
            ...(edit.protection === undefined ? {} : { protection: edit.protection }),
            ...radiusFields,
            ...(options.project === undefined ? {} : { projects: [options.project] }),
            ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
            updatedAt: now,
          }
        : {
            id: edit.id,
            kind: edit.kind,
            version: 1,
            content,
            ...(edit.title === undefined ? {} : { title: edit.title }),
            ...(edit.protection === undefined ? {} : { protection: edit.protection }),
            ...radiusFields,
            ...(options.project === undefined ? {} : { projects: [options.project] }),
            ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
            updatedAt: now,
          }
      next.entries[edit.kind][edit.id] = entry
      appliedEdits.push(stampAppliedEdit(edit, { after: content, afterEntry: structuredClone(entry), applied: true }))
      continue
    }
    const finalSourceSession = edit.metadata?.sourceSession ?? options.sourceSession
    const metadata = {
      ...currentEntry.metadata,
      ...edit.metadata,
      ...(finalSourceSession === undefined ? {} : { sourceSession: finalSourceSession }),
    }
    const nextEntry = {
      ...currentEntry,
      version: currentEntry.version + 1,
      content,
      ...(edit.title === undefined ? {} : { title: edit.title }),
      ...(edit.protection === undefined ? {} : { protection: edit.protection }),
      // Set-if-present: a declared reach replaces the recorded one; omitting it
      // keeps the current value rather than erasing a claim this edit cannot see.
      ...radiusFields,
      // skill-only fields: set-if-present — the edit carries the new value or
      // the current one is kept, so an update can add a field but rollback
      // (which only re-sets recorded fields) cannot remove one it introduced.
      ...(edit.kind === 'skill' && edit.description !== undefined ? { description: edit.description } : {}),
      ...(edit.kind === 'skill' && edit.reference !== undefined ? { reference: edit.reference } : {}),
      ...(edit.kind === 'skill' && edit.arguments !== undefined ? { arguments: edit.arguments } : {}),
      ...(edit.kind === 'skill' && edit.files !== undefined ? { files: edit.files } : {}),
      // An entry touched from a second project serves both; the union is what
      // keeps a lesson learned in one repo from becoming invisible in the other.
      ...(options.project === undefined ? {} : { projects: projectUnion(currentEntry.projects, options.project) }),
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
  // The state file records conclusions only (no snapshot bodies); the caller
  // journaling the full record (refinements.jsonl) keeps rollback fidelity.
  next.refinements.push(stripRefinementSnapshots(result))
  return { result, state: next }
}

/**
 * Conclusion-only projection of a committed refinement for the state file:
 * applied edits keep their metadata (action/kind/id/blastRadius/applied/
 * error/reason) but drop the content snapshot bodies (before/after/
 * beforeEntry/afterEntry). The full record stays in the refinements.jsonl
 * journal (rollback/audit), so `harness_state.json` only records conclusions
 * and stays small. The in-memory result is unaffected, so diagnostics,
 * materialization, and the tool result still see the full snapshots.
 */
export function stripRefinementSnapshots(result: RefinementResult): RefinementResult {
  return {
    ...result,
    appliedEdits: result.appliedEdits.map(edit => {
      const { before: _before, after: _after, beforeEntry: _beforeEntry, afterEntry: _afterEntry, ...rest } = edit
      return rest
    }),
  }
}

/** Skill entries touched by applied edits; shared by materialization and post-apply diagnostics. */
export function touchedSkillIds(appliedEdits: Array<Pick<AppliedRefinementEdit, 'applied' | 'kind' | 'id'>>): string[] {
  const ids = appliedEdits.filter(edit => edit.applied && edit.kind === 'skill').map(edit => edit.id)
  // Preserve first occurrence order while ensuring each touched skill is
  // diagnosed and materialized at most once.
  return [...new Set(ids)]
}

/** Existing importers may continue importing the rollback surface from refine. */
export { entryToEditFields, rollbackProposal } from './rollback.ts'

/**
 * An entry's project tags after being touched from `project`: the union, so a
 * lesson refined from a second repository serves both. Order is assignment
 * order, which keeps repeated applies byte-identical.
 */
function projectUnion(existing: string[] | undefined, project: string): string[] {
  const tags = existing ?? []
  return tags.includes(project) ? tags : [...tags, project]
}

/** A fresh empty entries map at the current schema version. */
export function freshState(): HarnessState {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  }
}
