/**
 * Pins the cross-package assumption behind `registerSessionEventType`
 * (`src/domain.ts`): the runtime `KNOWN_SESSION_EVENT_TYPES` Set that the
 * plugin mutates on mount is the SAME instance the real persistence
 * coordinator consults when it refuses a stored log containing an unknown
 * non-ignorable event type (`SessionFormatUnsupportedError`, "refusing to
 * interpret the log").
 *
 * This drives the real read path end-to-end — the real
 * `PersistenceCoordinator` from `@deepseek-ai/dsh-session-persistence` through
 * its real JSONL file backend — over hand-seeded legacy session logs. Every
 * package here resolves to one deduplicated `@deepseek-ai/dsh-session`
 * rc.7 instance, so a refusal (or acceptance) at `load()` proves the Set is
 * shared at the module level — the exact property a production harness
 * deployment (a single dsh-session version, one instance) relies on.
 * @module dsh-continual-harness
 */

import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { HARNESS_REFINEMENT_EVENT, registerSessionEventType } from '../src/domain.ts'

const tempDirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-persistence-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One plain event envelope, optionally carrying the `ignorable` marker. */
function event(type: string, seq: number, data: unknown, ignorable?: true): Record<string, unknown> {
  return { type, seq, time: Date.now(), data, ...(ignorable ? { ignorable: true } : {}) }
}

/** A refinement result as committed by pre-`8ac1ac00` plugin builds. */
const legacyRefinement = { id: 'legacy-ref-1', summary: 'written before the ignorable probe landed' }

/**
 * Seed a legacy-style stored log (header line + plain JSONL event lines,
 * uncompressed, unpacked) at the exact artifact path the real JSONL backend
 * resolves, then return the live backend wired to a real `PersistenceCoordinator`.
 */
function seedLegacyLog(
  root: string,
  id: string,
  events: readonly Record<string, unknown>[],
): JsonlSessionPersistence {
  const ctx = new Context()
  // The coordinator's write path calls `ctx.sessions.list()` at construction,
  // so the session store must be registered before the backend is built.
  // Cordis `Service` constructors register synchronously (unlike `ctx.plugin`,
  // which defers startup), so direct construction is required here.
  new SessionStore(ctx)
  const persistence = new JsonlSessionPersistence(ctx, { root, compression: 'none', packChunks: false })
  const header = Session.create(SessionId(id)).header
  const headerLine = JSON.stringify({
    type: 'session',
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    delegationDepth: header.delegationDepth ?? 0,
  })
  const path = persistence.locate(header).path
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${headerLine}\n${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  return persistence
}

describe('persistence read gate (real coordinator + JSONL backend)', () => {
  it('refuses a stored log containing an unregistered out-of-repo event type (gate is live)', async () => {
    const persistence = seedLegacyLog(tempRoot(), 'control-unknown-type', [
      event('todo/write', 0, { todos: [] }),
      event('harness/control-unknown', 1, { anything: true }),
    ])
    const refusal = await persistence.load(SessionId('control-unknown-type')).then(
      () => { throw new Error('expected SessionFormatUnsupportedError') },
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(SessionFormatUnsupportedError)
    expect(String(refusal)).toContain('harness/control-unknown')
    expect(String(refusal)).toContain('refusing to interpret the log')
  })

  it('loads a legacy bare harness/refinement log once the type is registered (shared Set pin)', async () => {
    const root = tempRoot()
    const id = 'registered-bare-refinement'
    const persistence = seedLegacyLog(root, id, [
      event('todo/write', 0, { todos: [] }),
      event(HARNESS_REFINEMENT_EVENT, 1, legacyRefinement),
    ])
    registerSessionEventType(HARNESS_REFINEMENT_EVENT)
    const inspection = await persistence.load(SessionId(id))
    const types = inspection.events.map(e => e.type)
    expect(types).toContain('todo/write')
    expect(types).toContain(HARNESS_REFINEMENT_EVENT)
    expect(inspection.events.find(e => e.type === HARNESS_REFINEMENT_EVENT)?.data).toMatchObject(legacyRefinement)
  })

  it('loads an ignorable-marked harness/refinement log without any registration', async () => {
    const root = tempRoot()
    const id = 'ignorable-refinement'
    const persistence = seedLegacyLog(root, id, [
      event(HARNESS_REFINEMENT_EVENT, 0, legacyRefinement, true),
    ])
    const inspection = await persistence.load(SessionId(id))
    expect(inspection.events.map(e => e.type)).toContain(HARNESS_REFINEMENT_EVENT)
  })
})
