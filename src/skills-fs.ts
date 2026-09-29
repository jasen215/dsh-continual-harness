/**
 * Filesystem layer for skill bundles: the injectable fs surface, bundle
 * inspection, and reconciliation of a skills directory against the effective
 * skill entries. Split out of `skills.ts` (2026-09-29): that module keeps the
 * pure SKILL.md format, limits and structural validation; this one touches disk.
 * @module dsh-continual-harness
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KEBAB_CASE_PATTERN } from './domain.ts'
import { uniqueTmpPath } from './fs-safe.ts'
import { isHarnessOwnedBundle, isSafeBundleRelative, renderSkillMarkdown, skillBundleDir, unsafeBundleTargetReason } from './skills.ts'
import type { SkillEntryLike } from './skills.ts'
import type { MaterializationErrorCode, MaterializationResult } from './types.ts'

/** Injectable fs surface so materialization write faults are testable (spec §7.11). */
export interface SkillFsOps {
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
  lstatSync(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }
  mkdirSync(path: string, opts?: { recursive?: boolean }): void
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(oldPath: string, newPath: string): void
  readFileSync(path: string, encoding: 'utf8'): string
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
  /** Remove an empty directory only; non-empty or missing throws (walk abort). */
  rmdirSync(path: string): void
}

/** The default fs surface: direct `node:fs` bindings. */
export const defaultSkillFsOps: SkillFsOps = {
  existsSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
  rmdirSync,
}

export interface DiscoveredEntry {
  rel: string
  kind: 'file' | 'symlink' | 'other'
}

function collectRelativeFiles(dir: string, fsOps: SkillFsOps, prefix = '', knownExists = false): DiscoveredEntry[] {
  if (!knownExists && !fsOps.existsSync(dir)) return []
  const entries: DiscoveredEntry[] = []
  for (const name of fsOps.readdirSync(dir)) {
    if (!isSafeBundleRelative(name)) continue // hostile entry; never traverse or delete
    const rel = prefix ? `${prefix}/${name}` : name
    const full = join(dir, name)
    let stat
    try {
      stat = fsOps.lstatSync(full)
    } catch {
      continue // vanished between readdir and lstat; skip
    }
    if (stat.isDirectory()) entries.push(...collectRelativeFiles(full, fsOps, rel, true))
    else if (stat.isSymbolicLink()) entries.push({ rel, kind: 'symlink' })
    else if (stat.isFile()) entries.push({ rel, kind: 'file' })
    else entries.push({ rel, kind: 'other' })
  }
  return entries
}

function recordError(
  result: MaterializationResult,
  path: string | undefined,
  code: MaterializationErrorCode,
  retryable: boolean,
  message: string,
): void {
  result.errors.push({ ...(path === undefined ? {} : { path }), code, retryable, message })
}

/** Remove now-empty parent directories of a deleted file, stopping at the bundle root or the first non-empty dir. */
function removeEmptyParentDirs(bundleRoot: string, rel: string, fsOps: SkillFsOps): void {
  let dir = dirname(rel)
  while (dir !== '.' && dir !== '') {
    const full = join(bundleRoot, dir)
    try {
      fsOps.rmdirSync(full) // rmdirSync only removes an empty dir
    } catch {
      return // non-empty, missing, or otherwise undeletable — stop the walk
    }
    dir = dirname(dir)
  }
}

/** On-disk state of one skill bundle path (spec §7.4 ownership decision). */
export type SkillBundleInspection =
  | { state: 'missing' }
  | { state: 'non-directory'; bundle: string }
  | { state: 'present'; bundle: string; harnessOwned: boolean }

/**
 * Inspect a skill bundle path without mutating anything: missing, an existing
 * non-directory, or a directory whose SKILL.md provenance decides ownership.
 * Both `reconcileSkillFiles` and the store's create-conflict gate share this
 * single ownership decision so policy cannot drift between call sites.
 */
export function inspectSkillBundle(fsOps: SkillFsOps, dir: string, id: string): SkillBundleInspection {
  const bundle = skillBundleDir(dir, id)
  if (!fsOps.existsSync(bundle)) return { state: 'missing' }
  if (!fsOps.lstatSync(bundle).isDirectory()) return { state: 'non-directory', bundle }
  const skillFile = join(bundle, 'SKILL.md')
  const markdown = fsOps.existsSync(skillFile) ? fsOps.readFileSync(skillFile, 'utf8') : ''
  return { state: 'present', bundle, harnessOwned: isHarnessOwnedBundle(markdown) }
}

/**
 * Materialize the bundle files (SKILL.md + entry.files) for the skill ids
 * touched by a committed refinement (spec §7.5/§7.7). JSON is the source of
 * truth; the disk is a renderable projection. Only kebab-case ids are ever
 * touched; ids outside `touchedIds` are never touched. A bundle is only
 * written to or deleted when its existing SKILL.md carries the full harness
 * provenance; otherwise it is skipped with a `not-harness-owned` entry.
 * Stale regular files in owned bundles are deleted; symlink/special files
 * are skipped with warnings. Write faults are collected; the committed
 * refinement is never failed by this function.
 */
export function reconcileSkillFiles(
  dir: string,
  effectiveSkills: Readonly<Record<string, SkillEntryLike>>,
  touchedIds: ReadonlyArray<string>,
  fsOps: SkillFsOps = defaultSkillFsOps,
): MaterializationResult {
  const result: MaterializationResult = {
    status: 'completed',
    written: [],
    unchanged: [],
    skipped: [],
    removed: [],
    errors: [],
  }
  let removedCount = 0
  for (const id of touchedIds) {
    if (!KEBAB_CASE_PATTERN.test(id)) continue
    const bundle = skillBundleDir(dir, id)
    const entry = effectiveSkills[id]
    if (entry === undefined) {
      // delete/archive: only a harness-owned bundle may be removed
      const inspected = inspectSkillBundle(fsOps, dir, id)
      if (inspected.state === 'non-directory') {
        recordError(result, inspected.bundle, 'not-a-directory', true, `"${id}" bundle path is not a directory; skipped`)
        result.skipped.push(inspected.bundle)
        continue
      }
      if (inspected.state === 'present') {
        if (inspected.harnessOwned) {
          try {
            fsOps.rmSync(inspected.bundle, { recursive: true, force: true })
            removedCount += 1
          } catch (error) {
            recordError(result, inspected.bundle, 'remove-failed', true, String(error))
          }
        } else {
          recordError(result, inspected.bundle, 'not-harness-owned', false, `"${id}" bundle is not harness-owned; left untouched`)
          result.skipped.push(inspected.bundle)
        }
      }
      continue
    }
    const targets: Record<string, string> = {
      'SKILL.md': renderSkillMarkdown(entry),
      ...(entry.files === undefined ? {} : entry.files),
    }
    // ownership: an existing bundle path must be harness-owned to write; a missing path is a create
    const inspected = inspectSkillBundle(fsOps, dir, id)
    if (inspected.state === 'non-directory') {
      recordError(result, inspected.bundle, 'not-a-directory', true, `"${id}" bundle path is not a directory; skipped`)
      result.skipped.push(inspected.bundle)
      continue
    }
    if (inspected.state === 'present' && !inspected.harnessOwned) {
      recordError(result, inspected.bundle, 'not-harness-owned', false, `"${id}" bundle is not harness-owned; skipped`)
      result.skipped.push(inspected.bundle)
      continue
    }
    // discovered entries: symlink/special files are skipped with warnings;
    // stale regular files in an owned bundle are deleted
    for (const item of collectRelativeFiles(bundle, fsOps, '', inspected.state === 'present')) {
      if (item.kind !== 'file') {
        recordError(
          result,
          join(bundle, item.rel),
          item.kind === 'symlink' ? 'symlink-skipped' : 'special-file-skipped',
          false,
          `"${item.rel}" is ${item.kind === 'symlink' ? 'a symbolic link' : 'a special file'}; skipped`,
        )
        continue
      }
      if (targets[item.rel] !== undefined) continue
      // Deliberately escape-only (not the full write-path rule): stale-file
      // cleanup must keep removing any regular file inside an owned bundle
      // (e.g. a leftover extra.md), so the scripts/|references/ prefix rule
      // does not gate discovery. The message is sourced from the shared
      // helper so the two loops' unsafe-path texts cannot drift apart.
      if (!isSafeBundleRelative(item.rel)) {
        recordError(result, join(bundle, item.rel), 'unsafe-path', false, `"${item.rel}" ${unsafeBundleTargetReason(item.rel)}; skipped`)
        continue
      }
      const file = join(bundle, item.rel)
      try {
        fsOps.rmSync(file, { force: true })
        result.removed.push(file)
        removeEmptyParentDirs(bundle, item.rel, fsOps)
      } catch (error) {
        recordError(result, file, 'remove-failed', true, String(error))
      }
    }
    for (const [rel, content] of Object.entries(targets)) {
      // The generated SKILL.md has a fixed, harness-controlled name and is
      // exempt; every other target comes from entry.files and is re-checked
      // here because store state may predate the edit-path validation that
      // validateBundleFiles enforces.
      const reason = rel === 'SKILL.md' ? undefined : unsafeBundleTargetReason(rel)
      if (reason !== undefined) {
        recordError(result, join(bundle, rel), 'unsafe-path', false, `"${rel}" ${reason}; skipped`)
        continue
      }
      const file = join(bundle, rel)
      if (fsOps.existsSync(file) && fsOps.readFileSync(file, 'utf8') === content) {
        result.unchanged.push(file)
        continue
      }
      const tmp = uniqueTmpPath(file)
      try {
        fsOps.mkdirSync(join(bundle, dirname(rel)), { recursive: true })
        fsOps.writeFileSync(tmp, content, 'utf8')
        fsOps.renameSync(tmp, file)
        result.written.push(file)
      } catch (error) {
        try {
          fsOps.rmSync(tmp, { force: true })
        } catch {
          // best-effort cleanup; the original write error is the finding
        }
        recordError(result, file, 'write-failed', true, String(error))
      }
    }
  }
  const successful = result.written.length + result.unchanged.length + result.removed.length + removedCount
  const fatal = result.errors.some(error => error.retryable)
  if (fatal) {
    result.status = successful > 0 || result.skipped.length > 0 ? 'partial' : 'failed'
  } else if (result.errors.length > 0 || result.skipped.length > 0) {
    result.status = 'partial'
  }
  return result
}
