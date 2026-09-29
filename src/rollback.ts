/**
 * Rollback proposal construction: revert a committed result into the edits that
 * undo it, plus the entry→edit field mapping a rollback (or a promote) shares so
 * every persisted field is restored. Split out of refine.ts to keep that file
 * under the 500-line ceiling; refine.ts re-exports both for existing importers.
 */
import type { HarnessEntry, RefinementEdit, RefinementProposal, RefinementResult, SkillEntry } from './types.ts'

/** Revert a committed result: reverse edit order, restoring full entries from
 * snapshots when available; legacy content-only records degrade and are marked. */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = []
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) continue
    const reason = `rollback:${target.id}`
    if (edit.action === 'create') {
      // A delete claims no reach, and the record's blastRadius is a
      // schema-valid fallback rather than a declaration, so carrying it here
      // would promote that fallback into a false declaration.
      edits.push({ action: 'delete', kind: edit.kind, id: edit.id, reason })
    } else if (edit.action === 'delete') {
      const before: HarnessEntry | undefined = edit.beforeEntry
        ?? (edit.before === undefined ? undefined : { content: edit.before } as HarnessEntry)
      if (before === undefined) continue
      edits.push({
        action: 'create', kind: edit.kind, id: edit.id,
        ...entryToEditFields(before),
        reason,
        ...(edit.beforeEntry === undefined ? { rollbackDegraded: true } : {}),
      })
    } else if (edit.beforeEntry !== undefined) {
      edits.push({
        action: 'update', kind: edit.kind, id: edit.id,
        ...entryToEditFields(edit.beforeEntry),
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

/** Map a full entry snapshot onto edit fields so a rollback (or a promote)
 * restores every persisted field: content, title, metadata, protection,
 * blastRadius, and the skill-only description/reference/arguments. Legacy
 * records carry only content. The single source of truth for the entry→edit
 * field mapping. */
export function entryToEditFields(before: HarnessEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = { content: before.content }
  if (before.blastRadius !== undefined) fields.blastRadius = before.blastRadius
  if (before.title !== undefined) fields.title = before.title
  if (before.metadata !== undefined) fields.metadata = before.metadata
  if (before.protection !== undefined) fields.protection = before.protection
  if (before.kind === 'skill') {
    const skill = before as SkillEntry
    if (skill.description !== undefined) fields.description = skill.description
    if (skill.reference !== undefined) fields.reference = skill.reference
    if (skill.arguments !== undefined) fields.arguments = skill.arguments
    fields.files = skill.files ?? {}
  }
  return fields
}
