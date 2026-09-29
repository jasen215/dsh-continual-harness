/**
 * Benchmark domain contracts: fixed cases, reference/candidate snapshots, and
 * the pure lifecycle functions that construct and validate them. The snapshot
 * constructor is deliberately named `buildSnapshot` (a pure structured-clone
 * capture) so the persisting `HarnessStore.captureSnapshot` method does not
 * collide with it. Atomic persistence for the `<harnessRoot>/benchmark/` store
 * lives in `benchmark-store.ts` (split out 2026-09-29).
 * @module dsh-continual-harness
 */

import { createHash } from 'node:crypto'
import { REFINEMENT_KINDS } from './domain.ts'
import { mergeHarnessStates } from './storage.ts'
import type { AppliedRefinementEdit, HarnessEntry, HarnessState, RefinementKind, RefinementResult } from './types.ts'

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
 * When `layers` is present (captured by the store), the two source layers are
 * retained so a candidate can be derived by applying a refinement to its own
 * layer and re-merging — a shadowed global entry must never be overwritten.
 */
export interface HarnessSnapshot {
  snapshotId: string
  state: HarnessState
  stateHash: string
  refinementId?: string
  capturedAt: string
  /** The local/global layers at capture time; `state` is their merge. */
  layers?: { local: HarnessState; global: HarnessState }
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

/** Hard caps guarding model-driven benchmark growth (spec 项 7). */
export const MAX_BENCH_CASES = 50
export const MAX_CASE_FIELD_CHARS = 20_000

function validateCaseMaterial(input: BenchmarkCaseInput): void {
  if (input.id.trim() === '') throw new Error('benchmark case id must be non-empty')
  if (input.title.trim() === '') throw new Error('benchmark case title must be non-empty')
  if (input.statement.trim() === '') throw new Error('benchmark case statement must be non-empty')
  if (input.rubric.trim() === '') throw new Error('benchmark case rubric must be non-empty')
  if (input.statement.length > MAX_CASE_FIELD_CHARS) {
    throw new Error(`benchmark case statement exceeds ${MAX_CASE_FIELD_CHARS} chars`)
  }
  if (input.rubric.length > MAX_CASE_FIELD_CHARS) {
    throw new Error(`benchmark case rubric exceeds ${MAX_CASE_FIELD_CHARS} chars`)
  }
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
 * stamps `snapshotId`, optional `refinementId`, and `capturedAt`. When the
 * source layers are passed, they are stored as structured clones and the
 * merged `state` must be their merge (the caller builds it that way).
 */
export function buildSnapshot(
  state: HarnessState,
  snapshotId: string,
  refinementId?: string,
  layers?: { local: HarnessState; global: HarnessState },
): HarnessSnapshot {
  if (snapshotId.trim() === '') throw new Error('snapshot id must be non-empty')
  const captured = structuredClone(state)
  return {
    snapshotId,
    state: captured,
    stateHash: sha256(canonicalJson(captured)),
    ...(refinementId !== undefined ? { refinementId } : {}),
    ...(layers === undefined ? {} : { layers: structuredClone(layers) }),
    capturedAt: new Date().toISOString(),
  }
}

/** The two source layers retained by a snapshot. */
export type SnapshotLayers = NonNullable<HarnessSnapshot['layers']>

/** Resolve the scope/other layer pair for a refinement scope. */
export function scopeLayerPair(scope: 'local' | 'global'): { scope: 'local' | 'global'; other: 'local' | 'global' } {
  return scope === 'global' ? { scope: 'global', other: 'local' } : { scope: 'local', other: 'global' }
}

/** Whether `candIds` is `refIds` plus exactly `id` appended at the end. */
function historyExtendsByIds(refIds: string[], candIds: string[], id: string): 'ok' | 'history-mismatch' | 'refinement-not-found' {
  if (candIds.length !== refIds.length + 1) {
    return candIds.includes(id) ? 'history-mismatch' : 'refinement-not-found'
  }
  for (let index = 0; index < refIds.length; index += 1) {
    if (refIds[index] !== candIds[index]) return 'history-mismatch'
  }
  return candIds[candIds.length - 1] === id ? 'ok' : 'refinement-not-found'
}

/** Whether the merged view of the layers canonical-equals the given state. */
export function layersMergeToState(layers: SnapshotLayers, state: HarnessState): boolean {
  return canonicalJson(mergeHarnessStates(layers.global, layers.local)) === canonicalJson(state)
}

/**
 * Verify every applied edit against ref/cand entry accessors: presence rules
 * per action plus before/after entry matching (with content-only fallback for
 * legacy edits lacking full snapshots). Returns false on any mismatch.
 */
function verifyAppliedEdits(
  appliedEdits: AppliedRefinementEdit[],
  refEntryFor: (kind: RefinementKind, id: string) => HarnessEntry | undefined,
  candEntryFor: (kind: RefinementKind, id: string) => HarnessEntry | undefined,
): boolean {
  for (const edit of appliedEdits) {
    const refEntry = refEntryFor(edit.kind, edit.id)
    const candEntry = candEntryFor(edit.kind, edit.id)
    if (edit.action === 'create') {
      if (refEntry !== undefined || candEntry === undefined) return false
    } else if (edit.action === 'delete') {
      if (refEntry === undefined || candEntry !== undefined) return false
    } else if (refEntry === undefined || candEntry === undefined) {
      return false
    }
    if (edit.beforeEntry !== undefined) {
      if (canonicalJson(refEntry) !== canonicalJson(edit.beforeEntry)) return false
    } else if (edit.before !== undefined && refEntry?.content !== edit.before) {
      return false
    }
    if (edit.afterEntry !== undefined) {
      if (canonicalJson(candEntry) !== canonicalJson(edit.afterEntry)) return false
    } else if (edit.after !== undefined && candEntry?.content !== edit.after) {
      return false
    }
  }
  return true
}

/**
 * Prove that `candidate` is exactly `reference` plus the one refinement
 * `refinementId` — never a drifted state. When both snapshots carry `layers`,
 * the proof runs per layer: the refinement's own layer (by `result.scope`)
 * must differ by exactly its applied edits with matching before/after entries,
 * the other layer must be canonical-identical, and the candidate's merged
 * `state` must equal the merge of its layers. Legacy single-layer snapshots
 * (no `layers`) fall back to the merged-state comparison. Returns a
 * structured failure reason; a drifted candidate is never silently accepted.
 */
export function validateCandidateDelta(reference: HarnessSnapshot, candidate: HarnessSnapshot, refinementId: string): CandidateDeltaResult {
  // A candidate that names a different refinement is drifting by definition.
  if (candidate.refinementId !== undefined && candidate.refinementId !== refinementId) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }

  const result = candidate.state.refinements.find(r => r.id === refinementId)
  if (result === undefined) return { ok: false, reason: 'refinement-not-found' }

  if (reference.layers !== undefined && candidate.layers !== undefined) {
    return validateCandidateDeltaLayered(reference.layers, candidate.layers, candidate.state, result)
  }

  // Legacy merged-only path for pre-layer snapshots.
  const history = historyExtendsByIds(
    reference.state.refinements.map(r => r.id),
    candidate.state.refinements.map(r => r.id),
    refinementId,
  )
  if (history !== 'ok') return { ok: false, reason: history }

  // Only applied edits produce a state delta; rejected edits (applied: false)
  // changed nothing and must not be required to appear in the diff.
  const appliedEdits = result.appliedEdits.filter(edit => edit.applied)
  const editKeys = new Set(appliedEdits.map(edit => `${edit.kind}:${edit.id}`))
  const diffKeys = entryDiffKeys(reference.state, candidate.state)
  if (editKeys.size !== diffKeys.size || [...editKeys].some(key => !diffKeys.has(key))) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }
  if (!verifyAppliedEdits(
    appliedEdits,
    (kind, id) => reference.state.entries[kind]?.[id],
    (kind, id) => candidate.state.entries[kind]?.[id],
  )) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }
  return { ok: true }
}

/**
 * Layer-aware delta proof for snapshots that carry both source layers. The
 * refinement's scope picks its layer; the merged history check is skipped
 * because a local refinement lands mid-list in the merged view
 * (`[...local, ...global]`).
 */
function validateCandidateDeltaLayered(
  refLayers: SnapshotLayers,
  candLayers: SnapshotLayers,
  candState: HarnessState,
  result: RefinementResult,
): CandidateDeltaResult {
  const { scope, other } = scopeLayerPair(result.scope)
  const refScope = refLayers[scope]
  const candScope = candLayers[scope]

  // The scope layer's history extends by exactly the one refinement.
  const history = historyExtendsByIds(
    refScope.refinements.map(r => r.id),
    candScope.refinements.map(r => r.id),
    result.id,
  )
  if (history !== 'ok') return { ok: false, reason: history }

  // The other layer is untouched: refinements and entries must be identical.
  if (canonicalJson(refLayers[other].refinements) !== canonicalJson(candLayers[other].refinements)) {
    return { ok: false, reason: 'history-mismatch' }
  }
  if (canonicalJson(refLayers[other].entries) !== canonicalJson(candLayers[other].entries)) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }

  // The candidate's merged state must equal the merge of its layers.
  if (!layersMergeToState(candLayers, candState)) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }

  // The scope-layer diff must equal exactly the applied edit keys.
  const appliedEdits = result.appliedEdits.filter(edit => edit.applied)
  const editKeys = new Set(appliedEdits.map(edit => `${edit.kind}:${edit.id}`))
  const layerDiffKeys = entryDiffKeys(refScope, candScope)
  if (editKeys.size !== layerDiffKeys.size || [...editKeys].some(key => !layerDiffKeys.has(key))) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
  }
  if (!verifyAppliedEdits(
    appliedEdits,
    (kind, id) => refScope.entries[kind]?.[id],
    (kind, id) => candScope.entries[kind]?.[id],
  )) {
    return { ok: false, reason: 'candidate-delta-mismatch' }
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
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
