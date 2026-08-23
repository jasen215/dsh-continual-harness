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

/** Soft cap on the skill id length: short, memorable, easy to type (L2). */
export const MAX_SKILL_ID_CHARS = 30

/** Soft cap on the kebab-case id segment count: no long descriptive phrases (L2). */
export const MAX_SKILL_ID_SEGMENTS = 3

/** Soft cap on the SKILL.md body line count (L2). */
export const MAX_SKILL_BODY_LINES = 500

/** Trigger-word hints the description heuristic looks for (L2, advisory). */
const TRIGGER_HINTS = ['use ', 'uses ', 'when ', 'whenever ', 'trigger', 'run ', 'runs ', 'handles', 'for ']

/** Provenance marker: this plugin authored the materialized skill. */
export const SKILL_AUTHOR = 'dsh-continual-harness'
/** Provenance marker: the skill came out of the experience-solidification loop. */
export const SKILL_SOURCE = 'esp'

/** Skill bundle size/number limits (spec §7.4/§7.10). */
export interface SkillBundleLimits {
  maxSkillFiles: number
  maxSkillFileBytes: number
  maxSkillBundleBytes: number
}

/** Default bundle limits: 20 files, 256 KiB per file, 1 MiB total (UTF-8 bytes). */
export const DEFAULT_SKILL_BUNDLE_LIMITS: SkillBundleLimits = {
  maxSkillFiles: 20,
  maxSkillFileBytes: 256 * 1024,
  maxSkillBundleBytes: 1024 * 1024,
}

/**
 * L1 hard validation of a skill bundle `files` map (spec §7.4): returns the
 * failure reason or undefined when every key passes. Runs before any write.
 */
export function validateBundleFiles(
  files: Record<string, string>,
  limits: SkillBundleLimits = DEFAULT_SKILL_BUNDLE_LIMITS,
): string | undefined {
  const keys = Object.keys(files)
  if (keys.length === 0) return undefined
  if (keys.length > limits.maxSkillFiles) {
    return `skill bundle exceeds maxSkillFiles (${keys.length} > ${limits.maxSkillFiles})`
  }
  let totalBytes = 0
  for (const key of keys) {
    if (key === '') return 'bundle file key must not be empty'
    if (key.includes('\\')) return `bundle file key "${key}" must use forward slashes`
    if (key.startsWith('/')) return `bundle file key "${key}" must be relative`
    if (key.startsWith('./')) return `bundle file key "${key}" must not start with "./"`
    if (key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      return `bundle file key "${key}" contains an invalid path segment`
    }
    if (key === 'SKILL.md') return 'SKILL.md is generated from content and must not appear in files'
    if (!/^(scripts|references)\//.test(key)) {
      return `bundle file key "${key}" must start with scripts/ or references/`
    }
    if (/%[0-9a-fA-F]{2}/.test(key)) {
      return `bundle file key "${key}" must not contain URL-encoded characters`
    }
    const bytes = Buffer.byteLength(files[key]!, 'utf8')
    if (bytes > limits.maxSkillFileBytes) {
      return `bundle file "${key}" exceeds maxSkillFileBytes (${bytes} > ${limits.maxSkillFileBytes})`
    }
    totalBytes += bytes
  }
  if (totalBytes > limits.maxSkillBundleBytes) {
    return `skill bundle exceeds maxSkillBundleBytes (${totalBytes} > ${limits.maxSkillBundleBytes})`
  }
  return undefined
}

/** Skill entries may carry the optional one-line description. */
export type SkillEntryLike = HarnessEntry & { description?: string }

/**
 * Render one skill entry as a `<name>/SKILL.md` bundle body: YAML frontmatter
 * with the dsh-required `name` and `description` keys, a `metadata` provenance
 * block marking the author and source, plus the markdown body verbatim. The
 * description falls back to the first line of the body and is emitted as a
 * double-quoted YAML scalar so `: `, `#`, quotes, or leading special
 * characters can never invalidate the frontmatter.
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
description: ${JSON.stringify(safe)}
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

/** One L2 structural-quality finding for a skill entry. Advisory: never blocks a write (L0/L1 are the hard gates). */
export interface SkillBundleIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
}

/** Parse the `name:` field out of a rendered SKILL.md frontmatter block; undefined when unparseable. */
export function parseFrontmatterName(markdown: string): string | undefined {
  if (!markdown.startsWith('---\n')) return undefined
  const end = markdown.indexOf('\n---', 4)
  if (end < 0) return undefined
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^name:\s*(.+)$/.exec(line)
    if (match) return match[1]!.trim()
  }
  return undefined
}

/** Parse the provenance fields out of a rendered SKILL.md frontmatter block; undefined when unparseable. */
export function parseFrontmatterProvenance(markdown: string): { author?: string; source?: string } | undefined {
  if (!markdown.startsWith('---\n')) return undefined
  const end = markdown.indexOf('\n---', 4)
  if (end < 0) return undefined
  let inMetadata = false
  let author: string | undefined
  let source: string | undefined
  for (const line of markdown.slice(4, end).split('\n')) {
    if (line === 'metadata:') {
      inMetadata = true
      continue
    }
    if (inMetadata && /^ +[a-z]+:/.test(line)) {
      const match = /^ +(author|source):\s*(.+)$/.exec(line)
      if (match) {
        if (match[1] === 'author') author = match[2]!.trim()
        else source = match[2]!.trim()
      }
      continue
    }
    if (inMetadata && !line.startsWith(' ')) inMetadata = false
  }
  return {
    ...(author === undefined ? {} : { author }),
    ...(source === undefined ? {} : { source }),
  }
}

/**
 * True only when the bundle carries the full hard-coded harness provenance
 * (spec §7.4): both author and source must match the constants. LLMs never
 * participate in this decision.
 */
export function isHarnessOwnedBundle(markdown: string): boolean {
  const provenance = parseFrontmatterProvenance(markdown)
  return provenance?.author === SKILL_AUTHOR && provenance?.source === SKILL_SOURCE
}

/** Every `scripts/` or `references/` path mentioned in a skill body. */
export function referencedFilePaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(/\b(?:scripts|references)\/[a-z0-9._-]+/g)) paths.add(match[0])
  return [...paths]
}

/** Every `scripts/` or `references/` path declared as a fenced-block target (```` ```scripts/x ````). */
export function embeddedFilePaths(content: string): Set<string> {
  const paths = new Set<string>()
  for (const match of content.matchAll(/^```(?:scripts|references)\/[a-z0-9._-]+\s*$/gm)) {
    paths.add(match[0].slice(3).trim())
  }
  return paths
}

/**
 * L2 structural-quality validation (design §7): id brevity, trigger-word
 * description, frontmatter name consistency, scripts/+references/ fenced-block
 * coverage, and body length. All findings are advisory — callers surface them
 * as a post-creation self-check report; they never reject a write.
 */
export function validateSkillBundle(entry: SkillEntryLike): SkillBundleIssue[] {
  const issues: SkillBundleIssue[] = []

  if (entry.id.length > MAX_SKILL_ID_CHARS) {
    issues.push({
      severity: 'warning',
      code: 'id-too-long',
      message: `skill id "${entry.id}" is ${entry.id.length} chars; keep ids short and easy to type (≤ ${MAX_SKILL_ID_CHARS})`,
    })
  }
  const segments = entry.id.split('-').length
  if (segments > MAX_SKILL_ID_SEGMENTS) {
    issues.push({
      severity: 'warning',
      code: 'id-too-wordy',
      message: `skill id "${entry.id}" has ${segments} segments; avoid long descriptive phrases like 'omlx-oq-quantization-workflow'`,
    })
  }

  const description = (entry.description ?? '').replace(/\s+/g, ' ').trim()
  if (description === '') {
    issues.push({
      severity: 'error',
      code: 'description-missing',
      message: 'skill has no description; add a one-line when-to-use description (rendered into the SKILL.md frontmatter)',
    })
  } else if (!TRIGGER_HINTS.some(hint => description.toLowerCase().includes(hint))) {
    issues.push({
      severity: 'warning',
      code: 'description-no-trigger',
      message: `description may lack trigger phrasing: "${description.slice(0, 80)}…" — lead with when-to-use words (use/when/trigger/run/handles) so the skill auto-invokes`,
    })
  }

  const name = parseFrontmatterName(renderSkillMarkdown(entry))
  if (name !== entry.id) {
    issues.push({
      severity: 'error',
      code: 'frontmatter-name-mismatch',
      message: `rendered frontmatter name "${name ?? '(unparseable)'}" does not match skill id "${entry.id}"`,
    })
  }

  const embedded = embeddedFilePaths(entry.content)
  for (const path of referencedFilePaths(entry.content)) {
    if (!embedded.has(path)) {
      issues.push({
        severity: 'warning',
        code: 'file-not-embedded',
        message: `"${path}" is referenced but has no matching fenced code block (\`\`\`${path}); it will not materialize from the bundle alone`,
      })
    }
  }

  const lines = entry.content.split('\n').length
  if (lines > MAX_SKILL_BODY_LINES) {
    issues.push({
      severity: 'warning',
      code: 'body-too-long',
      message: `skill body is ${lines} lines; keep it under ${MAX_SKILL_BODY_LINES} (soft)`,
    })
  }

  return issues
}
