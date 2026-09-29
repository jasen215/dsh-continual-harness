#!/usr/bin/env node
/**
 * Backfill the `projects` tag on entries committed before project tagging existed.
 *
 * WHY this is needed: project ownership is what lets the stable-anchor index put
 * the working project first, and the tag is only written by commits made after
 * the field landed. Entries written earlier carry no tag, so they rank as
 * project-agnostic and the ownership signal is missing exactly where the corpus
 * is already large. Asking the model to tag them would be a judgement call over
 * data it cannot see; the tag is recoverable as a fact instead:
 *
 *   - every entry records `metadata.sourceSession`, and
 *   - DSH records each session's creation cwd in
 *     `storages/session_projcache/sessions/<id>.json` (`record.identity.cwd`).
 *
 * Applying the plugin's own `projectTagFor` to that cwd yields exactly what a
 * live commit in that session would have stamped, so a backfilled corpus and a
 * freshly grown one agree by construction.
 *
 * Entries are skipped, never guessed, when the session or its cwd is unknown.
 * A session-local store is attributed by its own directory name, which is the
 * session id, so local entries are recoverable even without `sourceSession`.
 *
 * Usage:
 *   node scripts/backfill-project-tags.mjs [--home ~/.dsh] [--apply]
 *
 * Without --apply this is a dry run that prints what it would change; with it,
 * each rewritten file is copied to `<file>.bak-backfill-<timestamp>` first.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { projectTagFor } from '../lib/types/project.js'

const USAGE = `Backfill the projects tag on harness entries from recorded session cwds.

Usage:
  node scripts/backfill-project-tags.mjs [options]

Options:
  --home <dir>   DSH home holding harness/ and storages/ (default: $DSH_HOME or ~/.dsh)
  --apply        Write the backfill; without it nothing is modified
  -h, --help     Print this help
`

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), apply: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--home requires a directory')
      options.home = value
      index += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** Session id → creation cwd, from DSH's own session projection cache. */
function sessionCwdIndex(home) {
  const index = new Map()
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(dir)) return index
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const cwd = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.record?.identity?.cwd
      if (typeof cwd === 'string' && cwd !== '') index.set(name.replace(/\.json$/, '').replace(/^session-/, ''), cwd)
    } catch {
      // An unreadable projection is not a reason to fail a backfill; the entry
      // it would have attributed is simply skipped and counted.
    }
  }
  return index
}

const normalizeSession = id => String(id).replace(/^session-/, '')

/**
 * Tag one state file. Returns the changes it would make plus the reason counts
 * for entries it refuses to touch.
 */
function plan(state, cwdFor) {
  const changes = []
  const skipped = { tagged: 0, noSource: 0, unknownSession: 0 }
  for (const [kind, bucket] of Object.entries(state.entries ?? {})) {
    for (const entry of Object.values(bucket)) {
      if (entry.projects !== undefined) {
        skipped.tagged += 1
        continue
      }
      const source = entry.metadata?.sourceSession
      if (source === undefined) {
        skipped.noSource += 1
        continue
      }
      const cwd = cwdFor(normalizeSession(source))
      if (cwd === undefined) {
        skipped.unknownSession += 1
        continue
      }
      const project = projectTagFor(cwd)
      if (project === undefined) {
        skipped.unknownSession += 1
        continue
      }
      changes.push({ kind, id: entry.id, project })
    }
  }
  return { changes, skipped }
}

function applyChanges(path, state, changes, stamp) {
  for (const change of changes) state.entries[change.kind][change.id].projects = [change.project]
  const backup = `${path}.bak-backfill-${stamp}`
  copyFileSync(path, backup)
  // Same serialization and same-directory rename as the store, so a concurrent
  // reader never sees a half-written state file.
  const tmp = `${path}.backfill-tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
  return backup
}

function backfillStateFile(path, cwdFor, options, report, stamp) {
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const { changes, skipped } = plan(state, cwdFor)
  const byProject = new Map()
  for (const change of changes) byProject.set(change.project, (byProject.get(change.project) ?? 0) + 1)
  report.tagged += changes.length
  report.alreadyTagged += skipped.tagged
  report.noSource += skipped.noSource
  report.unknownSession += skipped.unknownSession
  process.stdout.write(`${path}\n`)
  process.stdout.write(`  tag: ${changes.length} (already tagged: ${skipped.tagged}, no source session: ${skipped.noSource}, unknown session cwd: ${skipped.unknownSession})\n`)
  for (const [project, count] of [...byProject.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${project}: ${count}\n`)
  }
  if (options.apply && changes.length > 0) report.backups.push(applyChanges(path, state, changes, stamp))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const cwdIndex = sessionCwdIndex(options.home)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const report = { tagged: 0, alreadyTagged: 0, noSource: 0, unknownSession: 0, backups: [] }

  process.stdout.write(`home: ${options.home}\n`)
  process.stdout.write(`sessions with a recorded cwd: ${cwdIndex.size}\n`)

  const globalFile = join(options.home, 'harness', 'harness_state.json')
  if (existsSync(globalFile)) backfillStateFile(globalFile, id => cwdIndex.get(id), options, report, stamp)

  // A session-local store belongs to its own session, so its directory name is
  // the authoritative answer even when an entry lost its sourceSession.
  const sessionsDir = join(options.home, 'harness', 'sessions')
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir).sort()) {
      const file = join(sessionsDir, name, 'harness_state.json')
      if (!existsSync(file)) continue
      const localCwd = cwdIndex.get(normalizeSession(name))
      backfillStateFile(file, id => cwdIndex.get(id) ?? localCwd, options, report, stamp)
    }
  }

  process.stdout.write(`total tagged: ${report.tagged}\n`)
  process.stdout.write(`left untagged: ${report.noSource + report.unknownSession} (no source session: ${report.noSource}, unknown session cwd: ${report.unknownSession})\n`)
  if (options.apply) process.stdout.write(`backups written: ${report.backups.length}\n`)
  else if (report.tagged > 0) process.stdout.write('dry run: pass --apply to write the backfill\n')
}

main()
