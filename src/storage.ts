/**
 * Filesystem storage of continual harness state: atomic writes, corruption
 * degradation to empty state, local/global merge rules, and the cross-session
 * refinement history.
 * @module dsh-continual-harness
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  HARNESS_DIR_NAME,
  HARNESS_SCHEMA_VERSION,
  HARNESS_STATE_FILE_NAME,
  REFINEMENT_HISTORY_FILE_NAME,
  REFINEMENT_KINDS,
  USAGE_EVENTS_FILE_NAME,
} from './domain.ts'
import type { HarnessEntry, HarnessState, RefinementResult } from './types.ts'

const EMPTY_ENTRIES: HarnessState['entries'] = {
  prompt: {},
  memory: {},
  skill: {},
  subagent: {},
}

/** A fresh, empty harness state at the current schema version. */
export function emptyHarnessState(): HarnessState {
  return { schemaVersion: HARNESS_SCHEMA_VERSION, entries: structuredClone(EMPTY_ENTRIES), refinements: [] }
}

/** Directory of the session-local store under the plugin-owned harness home. */
export function getLocalHarnessStateDir(home: string, sessionKey: string): string {
  return join(home, 'sessions', sessionKey)
}

/** Directory of the cross-session global store: the plugin-owned harness home itself. */
export function getGlobalHarnessStateDir(home: string): string {
  return home
}

/** Migrate a parsed state payload to the current schema version. */
export function migrateHarnessState(parsed: unknown): { state: HarnessState; diagnostics: string[] } {
  const diagnostics: string[] = []
  const source = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<HarnessState>
  if (typeof source.schemaVersion === 'number' && source.schemaVersion > HARNESS_SCHEMA_VERSION) {
    throw new Error(`unsupported harness state schemaVersion ${source.schemaVersion}`)
  }
  const entries = structuredClone(EMPTY_ENTRIES)
  const raw = (source.entries ?? {}) as Partial<HarnessState['entries']>
  for (const kind of Object.keys(entries) as Array<keyof HarnessState['entries']>) {
    const candidate = raw[kind]
    if (candidate !== undefined && !isPlainObject(candidate)) {
      diagnostics.push(`skipping invalid ${kind} bucket`)
      continue
    }
    const bucket = (candidate ?? {}) as Record<string, unknown>
    for (const [id, value] of Object.entries(bucket)) {
      if (!isHarnessEntry(value)) {
        diagnostics.push(`skipping invalid ${kind} entry ${id}`)
        continue
      }
      entries[kind][id] = value as HarnessEntry
    }
  }
  const refinements = Array.isArray(source.refinements)
    ? (source.refinements as HarnessState['refinements'])
    : []
  return { state: { schemaVersion: HARNESS_SCHEMA_VERSION, entries, refinements }, diagnostics }
}

/** Read one store file: missing → empty; corrupt/future → empty and never overwritten; old version → migrate. */
export function loadHarnessState(dir: string, onDiagnostics?: (diagnostics: string[]) => void): HarnessState {
  const file = join(dir, HARNESS_STATE_FILE_NAME)
  if (!existsSync(file)) return emptyHarnessState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const migrated = migrateHarnessState(parsed)
    if (migrated.diagnostics.length > 0) onDiagnostics?.(migrated.diagnostics)
    return migrated.state
  } catch {
    return emptyHarnessState()
  }
}

/**
 * Merge a local state over a global one: plain ids resolve to local entries
 * and to global entries the local store does not shadow; a same-id global
 * entry shadowed by a local one survives under a `local:` id prefix.
 * Refinements concatenate with the local history first.
 */
export function mergeHarnessStates(global: HarnessState, local: HarnessState): HarnessState {
  const entries = structuredClone(EMPTY_ENTRIES)
  for (const kind of Object.keys(entries) as Array<keyof HarnessState['entries']>) {
    for (const [id, entry] of Object.entries(global.entries[kind])) {
      if (id in local.entries[kind]) {
        entries[kind][`local:${id}`] = entry
      } else {
        entries[kind][id] = entry
      }
    }
    for (const [id, entry] of Object.entries(local.entries[kind])) {
      entries[kind][id] = entry
    }
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    entries,
    refinements: [...local.refinements, ...global.refinements],
  }
}

/** Atomically persist a state file (tmp file + rename preserves mode). */
export function saveHarnessState(dir: string, state: HarnessState): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, HARNESS_STATE_FILE_NAME)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** Append one refinement record to a refinement journal (jsonl). */
export function appendRefinement(dir: string, result: RefinementResult): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, REFINEMENT_HISTORY_FILE_NAME), `${JSON.stringify(result)}\n`, 'utf8')
}

/** Append one global refinement to the cross-session history. */
export function appendGlobalRefinement(home: string, result: RefinementResult): void {
  appendRefinement(getGlobalHarnessStateDir(home), result)
}

/** Append one session-local refinement to the session's history journal. */
export function appendLocalRefinement(home: string, sessionKey: string, result: RefinementResult): void {
  appendRefinement(getLocalHarnessStateDir(home, sessionKey), result)
}

/** Read one refinement journal; a corrupt line is skipped. */
function loadRefinementHistory(dir: string): RefinementResult[] {
  const file = join(dir, REFINEMENT_HISTORY_FILE_NAME)
  if (!existsSync(file)) return []
  const results: RefinementResult[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      results.push(JSON.parse(line) as RefinementResult)
    } catch {
      // skip corrupt line
    }
  }
  return results
}

/** Read the cross-session refinement history. */
export function loadGlobalRefinementHistory(home: string): RefinementResult[] {
  return loadRefinementHistory(getGlobalHarnessStateDir(home))
}

/** Read the session-local refinement history (full records kept for rollback). */
export function loadSessionRefinementHistory(home: string, sessionKey: string): RefinementResult[] {
  return loadRefinementHistory(getLocalHarnessStateDir(home, sessionKey))
}

/** Merge histories with local session events first, de-duplicated by id. */
export function mergeRefinementHistory(local: RefinementResult[], global: RefinementResult[]): RefinementResult[] {
  const seen = new Set<string>()
  const merged: RefinementResult[] = []
  for (const result of [...local, ...global]) {
    if (seen.has(result.id)) continue
    seen.add(result.id)
    merged.push(result)
  }
  return merged
}

/** Append one injection telemetry event line under the harness home. */
export function appendUsageEvent(home: string, event: { key: string; at: string }): void {
  mkdirSync(home, { recursive: true })
  appendFileSync(join(home, USAGE_EVENTS_FILE_NAME), `${JSON.stringify(event)}\n`, 'utf8')
}

/** Append many telemetry events in one open/write (batch, same timestamp). */
export function appendUsageEvents(home: string, events: Array<{ key: string; at: string }>): void {
  if (events.length === 0) return
  mkdirSync(home, { recursive: true })
  const lines = events.map(event => `${JSON.stringify(event)}\n`).join('')
  appendFileSync(join(home, USAGE_EVENTS_FILE_NAME), lines, 'utf8')
}

/** Read the injection telemetry log; missing file → empty, bad lines skipped. */
export function loadUsageEvents(home: string): Array<{ key: string; at: string }> {
  const file = join(home, USAGE_EVENTS_FILE_NAME)
  if (!existsSync(file)) return []
  const events: Array<{ key: string; at: string }> = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { key?: unknown; at?: unknown }
      if (typeof event.key === 'string' && typeof event.at === 'string') {
        events.push({ key: event.key, at: event.at })
      }
    } catch {
      // skip the corrupt line
    }
  }
  return events
}

/** Resolve the default harness home under the dsh home directory. */
export function defaultHarnessHome(): string {
  return dshHomePath(HARNESS_DIR_NAME)
}

/** Directory of a harness store's parent file, for diagnostics. */
export function storeParentDir(dir: string): string {
  return dirname(dir)
}

/** Whether a directory exists (used by the invariant companion). */
export function storeDirExists(dir: string): boolean {
  return existsSync(dir)
}

/** Whether a value is a plain object suitable for an id-to-entry map or metadata. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Validate an entry record shape (used by the invariant companion). */
export function isHarnessEntry(value: unknown): value is HarnessEntry {
  if (!isPlainObject(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string'
    || !REFINEMENT_KINDS.includes(entry.kind as (typeof REFINEMENT_KINDS)[number])
    || typeof entry.version !== 'number'
    || typeof entry.content !== 'string'
    || typeof entry.updatedAt !== 'string') return false
  if (entry.metadata !== undefined) {
    if (!isPlainObject(entry.metadata)) return false
    const metadata = entry.metadata
    const lifecycleState = metadata.lifecycleState
    if (lifecycleState !== undefined && lifecycleState !== 'active' && lifecycleState !== 'archived') return false
    if (metadata.sourceSession !== undefined && typeof metadata.sourceSession !== 'string') return false
    if (metadata.pinned !== undefined && typeof metadata.pinned !== 'boolean') return false
    if (metadata.lastInjectedAt !== undefined && typeof metadata.lastInjectedAt !== 'string') return false
  }
  return true
}
