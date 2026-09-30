/**
 * Atomic persistence for the `<harnessRoot>/benchmark/` store (cases, snapshots,
 * run records) plus the structural guards that validate what is read back.
 * Split out of `benchmark.ts` (2026-09-29): that module keeps the pure domain
 * contracts, lifecycle and snapshot validation; this one owns the filesystem.
 * @module dsh-continual-harness
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, hashBenchmarkCase, layersMergeToState, sha256 } from './benchmark.ts'
import type { BenchmarkCase, BenchmarkCriterion, HarnessSnapshot } from './benchmark.ts'
import {
  BENCHMARK_CASES_FILE_NAME,
  BENCHMARK_CASES_SCHEMA_VERSION,
  BENCHMARK_DIR_NAME,
  BENCHMARK_RUNS_FILE_NAME,
  BENCHMARK_SNAPSHOTS_DIR_NAME,
} from './domain.ts'
import { uniqueTmpPath } from './fs-safe.ts'
import type { HarnessState } from './types.ts'

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
  if (snapshot.layers !== undefined && !layersMergeToState(snapshot.layers, snapshot.state)) {
    throw new Error(`benchmark snapshot layers do not merge to its state: ${snapshotId}`)
  }
  return snapshot
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
    && (candidate.criteria === undefined || isBenchmarkCriteria(candidate.criteria))
}

/**
 * Whether a value is a usable criteria list: non-empty, with unique ids.
 * Emptiness matters because `scoreFromVerdicts` divides by the weight total (an
 * empty list scored `NaN` and only surfaced later as a non-finite cell score),
 * and a duplicate id would count one dimension twice.
 */
function isBenchmarkCriteria(value: unknown): value is BenchmarkCriterion[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const ids = new Set<string>()
  for (const entry of value) {
    if (!isBenchmarkCriterion(entry) || ids.has(entry.id)) return false
    ids.add(entry.id)
  }
  return true
}

/** Whether a value is a criterion with a non-empty id/check and a positive weight. */
function isBenchmarkCriterion(value: unknown): value is BenchmarkCriterion {
  if (!isPlainObject(value)) return false
  const criterion = value as Record<string, unknown>
  return typeof criterion.id === 'string' && criterion.id !== ''
    && typeof criterion.check === 'string' && criterion.check !== ''
    && typeof criterion.weight === 'number' && Number.isFinite(criterion.weight) && criterion.weight > 0
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
    && (snapshot.layers === undefined || isSnapshotLayers(snapshot.layers))
}

/** Whether a value is a `{ local, global }` pair of harness states (light shape check). */
function isSnapshotLayers(value: unknown): value is { local: HarnessState; global: HarnessState } {
  if (!isPlainObject(value)) return false
  const layers = value as Record<string, unknown>
  return isHarnessStateShape(layers.local) && isHarnessStateShape(layers.global)
}

/** Light harness-state shape check for snapshot layers (entries + refinements). */
function isHarnessStateShape(value: unknown): value is HarnessState {
  if (!isPlainObject(value)) return false
  const state = value as Record<string, unknown>
  return typeof state.schemaVersion === 'number'
    && isPlainObject(state.entries)
    && Array.isArray(state.refinements)
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

/** Atomic JSON write: unique sibling temp via `uniqueTmpPath`, then rename. */
function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = uniqueTmpPath(file)
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
