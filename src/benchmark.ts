/**
 * Benchmark domain contracts: fixed cases, reference/candidate snapshots, and
 * the pure lifecycle functions that construct and validate them — plus atomic
 * persistence for the `<harnessRoot>/benchmark/` store (cases, snapshots, run
 * records). The snapshot constructor is deliberately named `buildSnapshot` (a
 * pure structured-clone capture) so the persisting `HarnessStore.captureSnapshot`
 * method does not collide with it; `captureReferenceSnapshot` and
 * `loadReferenceSnapshot` are the file-level persist/load helpers.
 * @module dsh-continual-harness
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BENCHMARK_CASES_FILE_NAME,
  BENCHMARK_CASES_SCHEMA_VERSION,
  BENCHMARK_DIR_NAME,
  BENCHMARK_RUNS_FILE_NAME,
  BENCHMARK_SNAPSHOTS_DIR_NAME,
  REFINEMENT_KINDS,
} from './domain.ts'
import type { HarnessState } from './types.ts'

/** A fixed benchmark case. Only `draft` cases may change; `frozen` cases are immutable. */
export interface BenchmarkCase {
  id: string
  title: string
  statement: string
  /** Plaintext MVP rubric; only ever handed to the reviewer. */
  rubric: string
  capability?: string
  state: 'draft' | 'frozen'
  createdAt: string
  frozenAt?: string
}

/** Input fields for creating a draft case; lifecycle fields are stamped. */
export type BenchmarkCaseInput = Omit<BenchmarkCase, 'state' | 'createdAt' | 'frozenAt'>

/**
 * A read-only capture of the merged local/global harness state. `state` is a
 * structured-clone copy; `stateHash` is the canonical projection hash of that
 * copy; `refinementId` marks a candidate as "reference plus this refinement".
 */
export interface HarnessSnapshot {
  snapshotId: string
  state: HarnessState
  stateHash: string
  refinementId?: string
  capturedAt: string
}

/** Structured executor output for one cell; unknown fields are rejected by the evaluator. */
export interface ExecutorEvidence {
  completed: boolean
  summary: string
  actions: string[]
  observations: string[]
  artifacts?: Array<{ name: string; content: string }>
}

/**
 * One A/B cell result. `score` is `0..100` (integer or finite decimal) for an
 * `ok` cell and `null` for a `failed` cell — failure is never counted as 0.
 */
export interface CellScore {
  runId: string
  side: 'reference' | 'candidate'
  caseId: string
  iteration: number
  score: number | null
  status: 'ok' | 'failed'
  failureReason?: string
  feedback?: string
  snapshotId: string
  stateHash: string
  caseHash: string
  executorProvider?: string
  executorModel?: string
  reviewerProvider?: string
  reviewerModel?: string
  durationMs?: number
  recordedAt: string
}

/** Code-owned acceptance decision; the model never decides this. */
export interface BenchmarkDecision {
  runId: string
  refinementId: string
  status: 'ACCEPTED' | 'REJECTED'
  referenceOverall: number | null
  candidateOverall: number | null
  regressionCases: string[]
  failedCells: number
  feedback: string[]
  autoRollback: false
  createdAt: string
}

/** Why a candidate snapshot failed the unique-delta check. */
export type CandidateDeltaFailureReason = 'candidate-delta-mismatch' | 'history-mismatch' | 'refinement-not-found'

/** Structured result of {@link validateCandidateDelta}. */
export type CandidateDeltaResult = { ok: true } | { ok: false; reason: CandidateDeltaFailureReason }

/** Why a cell score failed validation. */
export type CellScoreFailureReason = 'score-non-finite' | 'score-out-of-range' | 'failed-cell-score-not-null' | 'ok-cell-score-required'

/** Structured result of {@link validateCellScore}. */
export type CellScoreValidationResult = { ok: true } | { ok: false; reason: CellScoreFailureReason }

function validateCaseMaterial(input: BenchmarkCaseInput): void {
  if (input.id.trim() === '') throw new Error('benchmark case id must be non-empty')
  if (input.title.trim() === '') throw new Error('benchmark case title must be non-empty')
  if (input.statement.trim() === '') throw new Error('benchmark case statement must be non-empty')
  if (input.rubric.trim() === '') throw new Error('benchmark case rubric must be non-empty')
}

/** Create a mutable draft case; rejects empty material and duplicate ids. */
export function createBenchmarkCase(input: BenchmarkCaseInput, existingIds?: ReadonlySet<string>): BenchmarkCase {
  validateCaseMaterial(input)
  if (existingIds?.has(input.id)) {
    throw new Error(`duplicate benchmark case id: ${input.id}`)
  }
  return { ...input, state: 'draft', createdAt: new Date().toISOString() }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) deepFreeze(record[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Freeze a draft case: stamps `frozenAt` and deep-freezes the result so the
 * evaluation material (`statement`, `rubric`, `capability`) can never change.
 * Refuses non-draft input, so re-freezing a mutated frozen case throws.
 */
export function freezeBenchmarkCase(benchmarkCase: BenchmarkCase): BenchmarkCase {
  if (benchmarkCase.state !== 'draft') {
    throw new Error('cannot freeze a benchmark case that is not in draft state')
  }
  validateCaseMaterial(benchmarkCase)
  return deepFreeze({ ...benchmarkCase, state: 'frozen' as const, frozenAt: new Date().toISOString() })
}

/**
 * Hash only the frozen evaluation material — `id`, `statement`, `rubric`,
 * `capability` — in stable key order. Non-material fields (`title`,
 * `createdAt`, `frozenAt`) never affect the hash. Refuses drafts, whose
 * material is not yet stable.
 */
export function hashBenchmarkCase(benchmarkCase: BenchmarkCase): string {
  if (benchmarkCase.state !== 'frozen') {
    throw new Error('cannot hash a benchmark case that is not frozen')
  }
  const material: { id: string; statement: string; rubric: string; capability?: string } = {
    id: benchmarkCase.id,
    statement: benchmarkCase.statement,
    rubric: benchmarkCase.rubric,
  }
  if (benchmarkCase.capability !== undefined) material.capability = benchmarkCase.capability
  return sha256(canonicalJson(material))
}

/**
 * Build a read-only snapshot from a merged state without persisting anything:
 * structured-clones the state, hashes the clone's canonical projection, and
 * stamps `snapshotId`, optional `refinementId`, and `capturedAt`.
 */
export function buildSnapshot(state: HarnessState, snapshotId: string, refinementId?: string): HarnessSnapshot {
  if (snapshotId.trim() === '') throw new Error('snapshot id must be non-empty')
  const captured = structuredClone(state)
  return {
    snapshotId,
    state: captured,
    stateHash: sha256(canonicalJson(captured)),
    ...(refinementId !== undefined ? { refinementId } : {}),
    capturedAt: new Date().toISOString(),
  }
}

/**
 * Prove that `candidate` is exactly `reference` plus the one refinement
 * `refinementId` — never a drifted state. Compares canonical state projections
 * (not object identity): the candidate's refinement history must extend the
 * reference's by exactly that refinement, and every entry-level difference
 * must be attributable to its applied edits, consistent with the recorded
 * before/after state. Returns a structured failure reason; a drifted candidate
 * is never silently accepted.
 */
export function validateCandidateDelta(reference: HarnessSnapshot, candidate: HarnessSnapshot, refinementId: string): CandidateDeltaResult {
  // A candidate that names a different refinement is drifting by definition.
  if (candidate.refinementId !== undefined && candidate.refinementId !== refinementId) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }

  const refIds = reference.state.refinements.map(result => result.id)
  const candIds = candidate.state.refinements.map(result => result.id)

  // The candidate history must extend the reference history by exactly one
  // refinement — the claimed one — in commit order.
  if (candIds.length !== refIds.length + 1) {
    if (!candIds.includes(refinementId)) return { ok: false, reason: 'refinement-not-found' }
    return { ok: false, reason: 'history-mismatch' }
  }
  for (let index = 0; index < refIds.length; index += 1) {
    if (refIds[index] !== candIds[index]) return { ok: false, reason: 'history-mismatch' }
  }
  if (candIds[candIds.length - 1] !== refinementId) return { ok: false, reason: 'refinement-not-found' }

  const result = candidate.state.refinements[candIds.length - 1]!
  // Only applied edits produce a state delta; rejected edits (applied: false)
  // changed nothing and must not be required to appear in the diff.
  const appliedEdits = result.appliedEdits.filter(edit => edit.applied)
  const editKeys = new Set(appliedEdits.map(edit => `${edit.kind}:${edit.id}`))
  const diffKeys = entryDiffKeys(reference.state, candidate.state)
  if (editKeys.size !== diffKeys.size || [...editKeys].some(key => !diffKeys.has(key))) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }

  for (const edit of appliedEdits) {
    const refEntry = reference.state.entries[edit.kind]?.[edit.id]
    const candEntry = candidate.state.entries[edit.kind]?.[edit.id]
    if (edit.action === 'create') {
      if (refEntry !== undefined || candEntry === undefined) return { ok: false, reason: 'candidate-delta-mismatch' }
    } else if (edit.action === 'delete') {
      if (refEntry === undefined || candEntry !== undefined) return { ok: false, reason: 'candidate-delta-mismatch' }
    } else if (refEntry === undefined || candEntry === undefined) {
      return { ok: false, reason: 'candidate-delta-mismatch' }
    }
    if (edit.beforeEntry !== undefined) {
      if (canonicalJson(refEntry) !== canonicalJson(edit.beforeEntry)) return { ok: false, reason: 'candidate-delta-mismatch' }
    } else if (edit.before !== undefined && refEntry?.content !== edit.before) {
      return { ok: false, reason: 'candidate-delta-mismatch' }
    }
    if (edit.afterEntry !== undefined) {
      if (canonicalJson(candEntry) !== canonicalJson(edit.afterEntry)) return { ok: false, reason: 'candidate-delta-mismatch' }
    } else if (edit.after !== undefined && candEntry?.content !== edit.after) {
      return { ok: false, reason: 'candidate-delta-mismatch' }
    }
  }
  return { ok: true }
}

/**
 * Validate a cell score: an `ok` cell needs a finite score in `0..100`
 * (integer or finite decimal); a `failed` cell must carry `null` — failure is
 * never counted as 0 or any other number.
 */
export function validateCellScore(cell: CellScore): CellScoreValidationResult {
  if (cell.status === 'failed') {
    if (cell.score !== null) return { ok: false, reason: 'failed-cell-score-not-null' }
    return { ok: true }
  }
  if (cell.score === null) return { ok: false, reason: 'ok-cell-score-required' }
  if (!Number.isFinite(cell.score)) return { ok: false, reason: 'score-non-finite' }
  if (cell.score < 0 || cell.score > 100) return { ok: false, reason: 'score-out-of-range' }
  return { ok: true }
}

/**
 * Load the fixed benchmark cases from `<home>/benchmark/cases.json`. A missing
 * store reads as an empty list; malformed JSON, an unknown schema version, an
 * invalid case shape, or a frozen case whose material no longer matches its
 * recorded hash all fail loudly (never silent acceptance, never a repair write).
 */
export function loadBenchmark(home: string): BenchmarkCase[] {
  const file = benchmarkCasesFile(home)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`malformed benchmark cases file ${file}: ${String(error)}`)
  }
  if (!isBenchmarkCasesEnvelope(parsed)) {
    throw new Error(`unsupported benchmark cases schema in ${file}`)
  }
  const envelope = parsed as BenchmarkCasesEnvelope
  if (envelope.schemaVersion !== BENCHMARK_CASES_SCHEMA_VERSION) {
    throw new Error(`unsupported benchmark cases schemaVersion ${envelope.schemaVersion}`)
  }
  for (const benchmarkCase of envelope.cases) {
    if (benchmarkCase.state === 'frozen') {
      const recorded = envelope.caseHashes[benchmarkCase.id]
      if (recorded === undefined || recorded !== hashBenchmarkCase(benchmarkCase)) {
        throw new Error(`frozen benchmark case hash mismatch: ${benchmarkCase.id}`)
      }
    }
  }
  return envelope.cases
}

/**
 * Atomically persist the fixed benchmark cases to `<home>/benchmark/cases.json`
 * (sibling `.tmp` + rename), recording the material hash of every frozen case
 * so a later load can detect tampering. Drafts are never hashed.
 */
export function saveBenchmarkCases(home: string, cases: BenchmarkCase[]): void {
  const caseHashes: Record<string, string> = {}
  for (const benchmarkCase of cases) {
    if (benchmarkCase.state === 'frozen') caseHashes[benchmarkCase.id] = hashBenchmarkCase(benchmarkCase)
  }
  const envelope: BenchmarkCasesEnvelope = {
    schemaVersion: BENCHMARK_CASES_SCHEMA_VERSION,
    cases,
    caseHashes,
  }
  atomicWriteJson(benchmarkCasesFile(home), envelope)
}

/**
 * Append one benchmark run record as a JSON line to `<home>/benchmark/runs.jsonl`.
 * Only the benchmark run log is touched — the audit gate's `reviews.jsonl` is
 * never rewritten. The record is `{ runId, cells, decision, createdAt }` as
 * assembled by the `run` action in `src/tool.ts`. The append is not atomic
 * (a torn trailing line is possible on crash); readers tolerate it.
 */
export function appendBenchmarkRun(home: string, record: Record<string, unknown>): void {
  const file = benchmarkRunsFile(home)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Persist a reference snapshot read-only to `<home>/benchmark/snapshots/<snapshotId>.json`
 * via an atomic tmp + rename write. The snapshot id must be a safe file name;
 * the snapshot object itself is written as-is (its `stateHash` is validated
 * on load, not re-stamped here).
 */
export function captureReferenceSnapshot(home: string, snapshot: HarnessSnapshot): void {
  assertSafeSnapshotId(snapshot.snapshotId)
  atomicWriteJson(benchmarkSnapshotFile(home, snapshot.snapshotId), snapshot)
}

/**
 * Load a previously captured snapshot. A missing snapshot returns `undefined`;
 * malformed JSON or a stored `state` whose canonical projection hash no longer
 * matches the recorded `stateHash` fails loudly.
 */
export function loadReferenceSnapshot(home: string, snapshotId: string): HarnessSnapshot | undefined {
  assertSafeSnapshotId(snapshotId)
  const file = benchmarkSnapshotFile(home, snapshotId)
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`malformed benchmark snapshot file ${file}: ${String(error)}`)
  }
  if (!isHarnessSnapshot(parsed)) {
    throw new Error(`unsupported benchmark snapshot shape in ${file}`)
  }
  const snapshot = parsed as HarnessSnapshot
  if (snapshot.stateHash !== sha256(canonicalJson(snapshot.state))) {
    throw new Error(`benchmark snapshot stateHash mismatch: ${snapshotId}`)
  }
  return snapshot
}

/** Entry keys whose canonical projection differs between two states. */
function entryDiffKeys(a: HarnessState, b: HarnessState): Set<string> {
  const keys = new Set<string>()
  for (const kind of REFINEMENT_KINDS) {
    const ids = new Set([...Object.keys(a.entries[kind]), ...Object.keys(b.entries[kind])])
    for (const id of ids) {
      if (canonicalJson(a.entries[kind]?.[id]) !== canonicalJson(b.entries[kind]?.[id])) {
        keys.add(`${kind}:${id}`)
      }
    }
  }
  return keys
}

/** Stable deterministic serialization: object keys sorted, arrays kept in order. */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** On-disk envelope of the benchmark cases file. */
interface BenchmarkCasesEnvelope {
  schemaVersion: number
  cases: BenchmarkCase[]
  /** Material hash of every frozen case, keyed by case id; drafts carry none. */
  caseHashes: Record<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBenchmarkCase(value: unknown): value is BenchmarkCase {
  if (!isPlainObject(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.statement === 'string'
    && typeof candidate.rubric === 'string'
    && (candidate.state === 'draft' || candidate.state === 'frozen')
    && typeof candidate.createdAt === 'string'
    && (candidate.frozenAt === undefined || typeof candidate.frozenAt === 'string')
    && (candidate.capability === undefined || typeof candidate.capability === 'string')
}

function isBenchmarkCasesEnvelope(value: unknown): value is BenchmarkCasesEnvelope {
  if (!isPlainObject(value)) return false
  const envelope = value as Record<string, unknown>
  return typeof envelope.schemaVersion === 'number'
    && Array.isArray(envelope.cases)
    && envelope.cases.every(isBenchmarkCase)
    && isPlainObject(envelope.caseHashes)
    && Object.values(envelope.caseHashes).every(hash => typeof hash === 'string')
}

function isHarnessSnapshot(value: unknown): value is HarnessSnapshot {
  if (!isPlainObject(value)) return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.snapshotId === 'string'
    && isPlainObject(snapshot.state)
    && typeof snapshot.stateHash === 'string'
    && typeof snapshot.capturedAt === 'string'
    && (snapshot.refinementId === undefined || typeof snapshot.refinementId === 'string')
}

function benchmarkCasesFile(home: string): string {
  return join(home, BENCHMARK_DIR_NAME, BENCHMARK_CASES_FILE_NAME)
}

function benchmarkRunsFile(home: string): string {
  return join(home, BENCHMARK_DIR_NAME, BENCHMARK_RUNS_FILE_NAME)
}

function benchmarkSnapshotFile(home: string, snapshotId: string): string {
  return join(home, BENCHMARK_DIR_NAME, BENCHMARK_SNAPSHOTS_DIR_NAME, `${snapshotId}.json`)
}

/** Atomic JSON write: sibling `.tmp` file, then rename, mirroring storage.ts. */
function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** A snapshot id becomes a file name; the allowlist rejects path escapes and platform-invalid characters. */
const SAFE_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** A snapshot id becomes a file name; reject anything that could escape the snapshots dir. */
function assertSafeSnapshotId(snapshotId: string): void {
  if (!SAFE_SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error(`unsafe benchmark snapshot id: ${snapshotId}`)
  }
}
