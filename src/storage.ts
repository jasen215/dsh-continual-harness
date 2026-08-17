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

/** Directory of the session-local store. */
export function getLocalHarnessStateDir(home: string, sessionKey: string): string {
  return join(home, 'sessions', sessionKey, HARNESS_DIR_NAME)
}

/** Directory of the cross-session global store. */
export function getGlobalHarnessStateDir(home: string): string {
  return join(home, HARNESS_DIR_NAME)
}

/** Read one store file; a missing or corrupt file degrades to empty state. */
export function loadHarnessState(dir: string): HarnessState {
  const file = join(dir, HARNESS_STATE_FILE_NAME)
  if (!existsSync(file)) return emptyHarnessState()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<HarnessState>
    if (parsed.schemaVersion !== HARNESS_SCHEMA_VERSION) return emptyHarnessState()
    return {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      entries: {
        prompt: parsed.entries?.prompt ?? {},
        memory: parsed.entries?.memory ?? {},
        skill: parsed.entries?.skill ?? {},
        subagent: parsed.entries?.subagent ?? {},
      },
      refinements: Array.isArray(parsed.refinements) ? parsed.refinements : [],
    }
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

/** Append one global refinement to the cross-session history. */
export function appendGlobalRefinement(home: string, result: RefinementResult): void {
  const dir = getGlobalHarnessStateDir(home)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, REFINEMENT_HISTORY_FILE_NAME), `${JSON.stringify(result)}\n`, 'utf8')
}

/** Read the cross-session refinement history; a corrupt line is skipped. */
export function loadGlobalRefinementHistory(home: string): RefinementResult[] {
  const file = join(getGlobalHarnessStateDir(home), REFINEMENT_HISTORY_FILE_NAME)
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

/** Validate an entry record shape (used by the invariant companion). */
export function isHarnessEntry(value: unknown): value is HarnessEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.kind === 'string'
    && typeof entry.version === 'number'
    && typeof entry.content === 'string'
    && typeof entry.updatedAt === 'string'
}
