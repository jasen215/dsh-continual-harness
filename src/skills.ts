/**
 * Materialization of skill entries as real dsh skills: renders the dsh
 * SKILL.md bundle format (YAML frontmatter + markdown body) and reconciles a
 * skills directory against the effective (merged) skill entries touched by a
 * refinement commit, so dsh's filesystem skill provider discovers generated
 * skills live.
 * @module dsh-continual-harness
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEBAB_CASE_PATTERN } from './refine.ts'
import type { HarnessEntry } from './types.ts'

/** Length cap for the single-line frontmatter description. */
export const MAX_DESCRIPTION_CHARS = 200

/** Provenance marker: this plugin authored the materialized skill. */
export const SKILL_AUTHOR = 'dsh-continual-harness'
/** Provenance marker: the skill came out of the experience-solidification loop. */
export const SKILL_SOURCE = 'esp'

/** Skill entries may carry the optional one-line description. */
export type SkillEntryLike = HarnessEntry & { description?: string }

/**
 * Render one skill entry as a `<name>/SKILL.md` bundle body: YAML frontmatter
 * with the dsh-required `name` and `description` keys, a `metadata` provenance
 * block marking the author and source, plus the markdown body verbatim. The
 * description falls back to the first line of the body.
 */
export function renderSkillMarkdown(entry: SkillEntryLike): string {
  const description = entry.description !== undefined
    ? entry.description.replace(/\s+/g, ' ').trim()
    : firstLine(entry.content)
  const safe = description.length > MAX_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : description
  return `---
name: ${entry.id}
description: ${safe}
metadata:
  author: ${SKILL_AUTHOR}
  source: ${SKILL_SOURCE}
---

${entry.content}
`
}

/** First non-empty line of a body, trimmed (frontmatter description fallback). */
export function firstLine(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, MAX_DESCRIPTION_CHARS)
  }
  return ''
}

/** Path of a skill's SKILL.md bundle inside a skills directory. */
export function skillBundleDir(dir: string, id: string): string {
  return join(dir, id)
}

/**
 * Reconcile the SKILL.md files for the skill ids touched by a committed
 * refinement against the effective (merged) skill entries: write the bundle
 * for ids that still have an effective entry, remove the bundle directory for
 * ids that no longer do (deleted or unshadowed-away). Only kebab-case ids are
 * ever written or removed; ids outside `touchedIds` are never touched, so
 * user-owned skills in the same directory are left alone.
 * @returns the absolute paths of files written, in stable order.
 */
export function reconcileSkillFiles(
  dir: string,
  effectiveSkills: Readonly<Record<string, SkillEntryLike>>,
  touchedIds: ReadonlyArray<string>,
): string[] {
  const written: string[] = []
  for (const id of touchedIds) {
    if (!KEBAB_CASE_PATTERN.test(id)) continue
    const bundle = skillBundleDir(dir, id)
    const entry = effectiveSkills[id]
    if (entry === undefined) {
      rmSync(bundle, { recursive: true, force: true })
      continue
    }
    const content = renderSkillMarkdown(entry)
    const file = join(bundle, 'SKILL.md')
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue
    mkdirSync(bundle, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
    written.push(file)
  }
  return written
}
