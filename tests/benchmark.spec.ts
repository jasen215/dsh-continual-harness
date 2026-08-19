import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendBenchmarkRun,
  buildSnapshot,
  captureReferenceSnapshot,
  createBenchmarkCase,
  freezeBenchmarkCase,
  hashBenchmarkCase,
  loadBenchmark,
  loadReferenceSnapshot,
  saveBenchmarkCases,
  validateCandidateDelta,
  validateCellScore,
} from '../src/benchmark.ts'
import type { BenchmarkCase, BenchmarkDecision, HarnessSnapshot } from '../src/benchmark.ts'
import { HARNESS_SCHEMA_VERSION } from '../src/domain.ts'
import type { CellScore, HarnessEntry, HarnessState, RefinementResult } from '../src/types.ts'

const EMPTY_ENTRIES = { prompt: {}, memory: {}, skill: {}, subagent: {} }

function baseState(): HarnessState {
  return { schemaVersion: HARNESS_SCHEMA_VERSION, entries: structuredClone(EMPTY_ENTRIES), refinements: [] }
}

function memoryEntry(id: string, content: string): HarnessEntry {
  return { id, kind: 'memory', version: 1, content, updatedAt: '2026-08-19T00:00:00.000Z' }
}

/** A committed refinement that creates one memory entry. */
const KNOWN_REFINEMENT: RefinementResult = {
  id: 'refine-1',
  summary: 'Add a durable fact about harness roots',
  scope: 'local',
  committedAt: '2026-08-19T00:00:01.000Z',
  appliedEdits: [{
    action: 'create',
    kind: 'memory',
    id: 'mem-1',
    after: 'the harness root is versioned under the harness home',
    afterEntry: memoryEntry('mem-1', 'the harness root is versioned under the harness home'),
    applied: true,
  }],
}

/** Reference state plus exactly the known refinement (a valid candidate state). */
function applyKnownRefinement(state: HarnessState): HarnessState {
  const next = structuredClone(state)
  next.entries.memory['mem-1'] = structuredClone(KNOWN_REFINEMENT.appliedEdits[0]!.afterEntry!)
  next.refinements.push(structuredClone(KNOWN_REFINEMENT))
  return next
}

/** Candidate state with an unrelated entry the refinement never touched. */
function candidateWithUnrelatedDrift(): HarnessState {
  const next = applyKnownRefinement(baseState())
  next.entries.prompt['prompt-1'] = { id: 'prompt-1', kind: 'prompt', version: 1, content: 'unrelated drift', updatedAt: '2026-08-19T00:00:00.000Z' }
  return next
}

function cellWith(score: number | null, status: CellScore['status']): CellScore {
  return {
    runId: 'run-1',
    side: 'candidate',
    caseId: 'case-1',
    iteration: 1,
    score,
    status,
    snapshotId: 'snap-1',
    stateHash: '0'.repeat(64),
    caseHash: '0'.repeat(64),
    recordedAt: '2026-08-19T00:00:00.000Z',
  }
}

describe('BenchmarkCase', () => {
  it('creates a draft case and freezes its immutable material', () => {
    const draft = createBenchmarkCase({ id: 'case-1', title: 'Task', statement: 'Do X', rubric: 'X is correct' })
    expect(draft.state).toBe('draft')
    const frozen = freezeBenchmarkCase(draft)
    expect(frozen.state).toBe('frozen')
    expect(frozen.frozenAt).toEqual(expect.any(String))
    expect(hashBenchmarkCase(frozen)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => freezeBenchmarkCase({ ...frozen, statement: 'changed' })).toThrow()
  })

  it('rejects empty required material', () => {
    for (const bad of [
      { id: '', title: 'Task', statement: 'Do X', rubric: 'X is correct' },
      { id: 'case-1', title: '', statement: 'Do X', rubric: 'X is correct' },
      { id: 'case-1', title: 'Task', statement: '', rubric: 'X is correct' },
      { id: 'case-1', title: 'Task', statement: 'Do X', rubric: '' },
    ]) {
      expect(() => createBenchmarkCase(bad)).toThrow()
    }
  })

  it('rejects duplicate ids against existing cases', () => {
    const existing = new Set(['case-1'])
    expect(() => createBenchmarkCase({ id: 'case-1', title: 'Task', statement: 'Do X', rubric: 'X is correct' }, existing)).toThrow(/duplicate/i)
  })

  it('prevents mutation of frozen material', () => {
    const frozen = freezeBenchmarkCase(createBenchmarkCase({ id: 'case-1', title: 'Task', statement: 'Do X', rubric: 'X is correct' }))
    expect(() => { (frozen as { statement: string }).statement = 'mutated' }).toThrow()
  })

  it('refuses to hash a draft', () => {
    const draft = createBenchmarkCase({ id: 'case-1', title: 'Task', statement: 'Do X', rubric: 'X is correct' })
    expect(() => hashBenchmarkCase(draft)).toThrow()
  })

  it('hashes only frozen material in stable key order', () => {
    const frozen = (id: string, title: string, statement: string, rubric: string, capability?: string) =>
      freezeBenchmarkCase(createBenchmarkCase({ id, title, statement, rubric, ...(capability !== undefined ? { capability } : {}) }))
    const base = frozen('case-1', 'Task', 'Do X', 'X is correct', 'cap')
    // title, createdAt and frozenAt are not evaluation material
    expect(hashBenchmarkCase(frozen('case-1', 'A different title', 'Do X', 'X is correct', 'cap'))).toBe(hashBenchmarkCase(base))
    // statement, rubric and capability are
    expect(hashBenchmarkCase(frozen('case-1', 'Task', 'Do Y', 'X is correct', 'cap'))).not.toBe(hashBenchmarkCase(base))
    expect(hashBenchmarkCase(frozen('case-1', 'Task', 'Do X', 'Y is correct', 'cap'))).not.toBe(hashBenchmarkCase(base))
    expect(hashBenchmarkCase(frozen('case-1', 'Task', 'Do X', 'X is correct'))).not.toBe(hashBenchmarkCase(base))
  })
})

describe('HarnessSnapshot', () => {
  it('captures a structured-clone copy of the merged state', () => {
    const state = baseState()
    const snapshot = buildSnapshot(state, 'ref-1')
    state.entries.memory['mem-1'] = memoryEntry('mem-1', 'late mutation')
    expect(snapshot.state.entries.memory['mem-1']).toBeUndefined()
    expect(snapshot.stateHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('includes snapshotId, stateHash, capturedAt and optional refinementId', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    expect(reference.snapshotId).toBe('ref-1')
    expect(reference.stateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(reference.capturedAt).toEqual(expect.any(String))
    expect('refinementId' in reference).toBe(false)
    const candidate = buildSnapshot(applyKnownRefinement(baseState()), 'refine-1', 'refine-1')
    expect(candidate.refinementId).toBe('refine-1')
  })

  it('stateHash is deterministic across equal states', () => {
    expect(buildSnapshot(baseState(), 'a').stateHash).toBe(buildSnapshot(baseState(), 'b').stateHash)
  })

  it('rejects an empty snapshot id', () => {
    expect(() => buildSnapshot(baseState(), '  ')).toThrow()
  })
})

describe('validateCandidateDelta', () => {
  it('accepts a candidate that is exactly reference plus one refinement', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    const candidate = buildSnapshot(applyKnownRefinement(baseState()), 'refine-1')
    expect(validateCandidateDelta(reference, candidate, 'refine-1')).toEqual({ ok: true })
  })

  it('rejects a candidate containing unrelated state drift', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    const result = validateCandidateDelta(reference, buildSnapshot(candidateWithUnrelatedDrift(), 'refine-1'), 'refine-1')
    expect(result).toEqual({ ok: false, reason: 'candidate-delta-mismatch' })
  })

  it('rejects a candidate whose refinement history is not exactly reference plus one', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    // candidate applies refine-1 and then a second refinement
    const second = structuredClone(applyKnownRefinement(baseState()))
    second.refinements.push(structuredClone({ ...KNOWN_REFINEMENT, id: 'refine-2' }))
    expect(validateCandidateDelta(reference, buildSnapshot(second, 'cand-1'), 'refine-1')).toEqual({ ok: false, reason: 'history-mismatch' })
    // candidate does not contain the claimed refinement at all
    const untouched = buildSnapshot(baseState(), 'cand-1')
    expect(validateCandidateDelta(reference, untouched, 'refine-1')).toEqual({ ok: false, reason: 'refinement-not-found' })
  })

  it('accepts a candidate whose refinement also recorded a rejected edit', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    // refine-1 applied its create but also carries a rejected duplicate edit
    const withRejected = structuredClone(KNOWN_REFINEMENT)
    withRejected.appliedEdits.push({
      action: 'create',
      kind: 'memory',
      id: 'mem-2',
      reason: 'duplicate',
      applied: false,
      error: 'entry already exists',
    })
    const next = structuredClone(baseState())
    next.entries.memory['mem-1'] = structuredClone(withRejected.appliedEdits[0]!.afterEntry!)
    next.refinements.push(withRejected)
    expect(validateCandidateDelta(reference, buildSnapshot(next, 'refine-1'), 'refine-1')).toEqual({ ok: true })
  })

  it('rejects a candidate whose edits are inconsistent with the recorded refinement', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    // the recorded edit claims to create mem-1 but candidate content differs
    const forged = structuredClone(applyKnownRefinement(baseState()))
    forged.entries.memory['mem-1'] = memoryEntry('mem-1', 'forged content')
    expect(validateCandidateDelta(reference, buildSnapshot(forged, 'cand-1'), 'refine-1')).toEqual({ ok: false, reason: 'candidate-delta-mismatch' })
  })

  it('rejects a candidate whose snapshot claims a different refinement id', () => {
    const reference = buildSnapshot(baseState(), 'ref-1')
    const candidate = buildSnapshot(applyKnownRefinement(baseState()), 'cand-1', 'refine-9')
    expect(validateCandidateDelta(reference, candidate, 'refine-1')).toEqual({ ok: false, reason: 'candidate-delta-mismatch' })
  })
})

describe('validateCellScore', () => {
  it('accepts an ok score in range and a failed cell', () => {
    expect(validateCellScore(cellWith(100, 'ok'))).toEqual({ ok: true })
    expect(validateCellScore(cellWith(99.5, 'ok'))).toEqual({ ok: true })
    expect(validateCellScore(cellWith(null, 'failed'))).toEqual({ ok: true })
  })

  it('rejects non-finite scores', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(validateCellScore(cellWith(bad, 'ok'))).toEqual({ ok: false, reason: 'score-non-finite' })
    }
  })

  it('rejects scores outside 0..100', () => {
    for (const bad of [-0.01, -1, 100.01, 101]) {
      expect(validateCellScore(cellWith(bad, 'ok'))).toEqual({ ok: false, reason: 'score-out-of-range' })
    }
  })

  it('rejects a failed cell carrying a numeric score', () => {
    expect(validateCellScore(cellWith(0, 'failed'))).toEqual({ ok: false, reason: 'failed-cell-score-not-null' })
  })

  it('rejects an ok cell without a score', () => {
    expect(validateCellScore(cellWith(null, 'ok'))).toEqual({ ok: false, reason: 'ok-cell-score-required' })
  })
})

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-benchmark-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function frozenCase(id = 'case-1'): BenchmarkCase {
  return freezeBenchmarkCase(createBenchmarkCase({ id, title: 'Task', statement: 'Do X', rubric: 'X is correct' }))
}

function runRecord(runId: string): Record<string, unknown> {
  const decision: BenchmarkDecision = {
    runId,
    refinementId: 'refine-1',
    status: 'ACCEPTED',
    referenceOverall: 80,
    candidateOverall: 90,
    regressionCases: [],
    failedCells: 0,
    feedback: ['improved'],
    autoRollback: false,
    createdAt: '2026-08-19T00:00:02.000Z',
  }
  return { runId, cells: [], decision, createdAt: '2026-08-19T00:00:02.000Z' }
}

describe('benchmark persistence', () => {
  it('loads an empty case list when the benchmark directory is missing', () => {
    const home = tempHome()
    expect(loadBenchmark(home)).toEqual([])
    expect(existsSync(join(home, 'benchmark'))).toBe(false)
  })

  it('round-trips draft and frozen cases through save and load', () => {
    const home = tempHome()
    const draft = createBenchmarkCase({ id: 'draft-1', title: 'Draft', statement: 'Do Y', rubric: 'Y is correct' })
    const frozen = frozenCase('frozen-1')
    saveBenchmarkCases(home, [draft, frozen])
    const loaded = loadBenchmark(home)
    expect(loaded).toEqual([draft, frozen])
    expect(loaded[1]!.state).toBe('frozen')
    expect(loaded[1]!.frozenAt).toEqual(expect.any(String))
    expect(hashBenchmarkCase(loaded[1]!)).toBe(hashBenchmarkCase(frozen))
  })

  it('replaces the cases file atomically on a second save', () => {
    const home = tempHome()
    const first = frozenCase('case-1')
    const second = frozenCase('case-2')
    saveBenchmarkCases(home, [first])
    saveBenchmarkCases(home, [first, second])
    expect(loadBenchmark(home)).toEqual([first, second])
    expect(existsSync(join(home, 'benchmark', 'cases.json.tmp'))).toBe(false)
    const raw = JSON.parse(readFileSync(join(home, 'benchmark', 'cases.json'), 'utf8')) as { cases: unknown[] }
    expect(raw.cases).toHaveLength(2)
  })

  it('rejects malformed cases.json without overwriting the existing valid file', () => {
    const home = tempHome()
    const frozen = frozenCase()
    saveBenchmarkCases(home, [frozen])
    writeFileSync(join(home, 'benchmark', 'cases.json'), '{ not json', 'utf8')
    expect(() => loadBenchmark(home)).toThrow()
    // the malformed file is left untouched: a failed load never repairs it
    expect(readFileSync(join(home, 'benchmark', 'cases.json'), 'utf8')).toBe('{ not json')
  })

  it('rejects an unsupported cases schema version', () => {
    const home = tempHome()
    mkdirSync(join(home, 'benchmark'), { recursive: true })
    writeFileSync(join(home, 'benchmark', 'cases.json'), JSON.stringify({ schemaVersion: 99, cases: [] }), 'utf8')
    expect(() => loadBenchmark(home)).toThrow(/schema/i)
  })

  it('fails loudly when a frozen case hash does not match its stored material', () => {
    const home = tempHome()
    const frozen = frozenCase()
    saveBenchmarkCases(home, [frozen])
    // tamper with the frozen material behind the stored hash's back
    const file = join(home, 'benchmark', 'cases.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { cases: Array<{ id: string; statement: string }> }
    stored.cases[0]!.statement = 'tampered'
    writeFileSync(file, JSON.stringify(stored), 'utf8')
    expect(() => loadBenchmark(home)).toThrow(/hash/i)
  })

  it('appends run records to runs.jsonl and never touches reviews.jsonl', () => {
    const home = tempHome()
    const reviews = join(home, 'reviews.jsonl')
    writeFileSync(reviews, '{"existing":"verdict"}\n', 'utf8')
    appendBenchmarkRun(home, runRecord('run-1'))
    appendBenchmarkRun(home, runRecord('run-2'))
    const lines = readFileSync(join(home, 'benchmark', 'runs.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map(line => JSON.parse(line).runId)).toEqual(['run-1', 'run-2'])
    // the audit gate's file keeps its schema and content untouched
    expect(readFileSync(reviews, 'utf8')).toBe('{"existing":"verdict"}\n')
  })

  it('captures and loads a reference snapshot round trip', () => {
    const home = tempHome()
    const snapshot = buildSnapshot(baseState(), 'ref-1')
    captureReferenceSnapshot(home, snapshot)
    expect(existsSync(join(home, 'benchmark', 'snapshots', 'ref-1.json'))).toBe(true)
    expect(existsSync(join(home, 'benchmark', 'snapshots', 'ref-1.json.tmp'))).toBe(false)
    expect(loadReferenceSnapshot(home, 'ref-1')).toEqual(snapshot)
  })

  it('returns undefined for a missing snapshot', () => {
    expect(loadReferenceSnapshot(tempHome(), 'missing')).toBeUndefined()
  })

  it('rejects malformed snapshot JSON', () => {
    const home = tempHome()
    mkdirSync(join(home, 'benchmark', 'snapshots'), { recursive: true })
    writeFileSync(join(home, 'benchmark', 'snapshots', 'ref-1.json'), '{ nope', 'utf8')
    expect(() => loadReferenceSnapshot(home, 'ref-1')).toThrow()
  })

  it('fails loudly when a stored snapshot stateHash does not match its state', () => {
    const home = tempHome()
    const snapshot = buildSnapshot(baseState(), 'ref-1')
    captureReferenceSnapshot(home, snapshot)
    // rewrite the snapshot file with a drifted state but the old stateHash
    const tampered: HarnessSnapshot = {
      ...snapshot,
      state: { ...snapshot.state, entries: { ...snapshot.state.entries, memory: { mem: { id: 'mem', kind: 'memory', version: 1, content: 'drift', updatedAt: '2026-08-19T00:00:00.000Z' } } } },
    }
    writeFileSync(join(home, 'benchmark', 'snapshots', 'ref-1.json'), JSON.stringify(tampered), 'utf8')
    expect(() => loadReferenceSnapshot(home, 'ref-1')).toThrow(/hash/i)
  })

  it('refuses to persist a snapshot id that is not a safe file name', () => {
    const home = tempHome()
    const snapshot = buildSnapshot(baseState(), '../escape')
    expect(() => captureReferenceSnapshot(home, snapshot)).toThrow()
  })
})
