#!/usr/bin/env tsx
/**
 * Local baseline gate — P0-a hygiene layer + P0-b contract layer.
 *
 * Usage:
 *   npm run verify          Compare against verify/latest.json; exit 0 = unchanged/better, 1 = worse
 *   npm run verify:accept   Accept the current values as the new baseline (after a human verdict)
 *
 * Scope (declared honestly):
 *   - P0-a: tests passed / pending / coverage (lines, funcs) / lint diagnostics / tsc errors
 *   - P0-b: A real refinements' validateEdit verdict vector digest
 *           C real harness_state entries' entryFingerprint digest
 *   - P1 (the effect layer) is NOT covered — that needs a paired A/B (harness_benchmark),
 *     which this script cannot answer.
 *
 * The P0-b inputs are the **frozen** real data under verify/corpus/ (local, never committed,
 * see D2/C). Without that freeze there is no baseline to speak of, and the script exits with
 * an error instead of skipping silently.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { entryFingerprint, validateEdit } from '../src/refine.ts'
import { decideBenchmark } from '../src/score.ts'
import type { CellScore } from '../src/benchmark.ts'
import type { HarnessEntry } from '../src/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = join(ROOT, 'verify/corpus')
const BASELINE = join(ROOT, 'verify/latest.json')
const ACCEPT = process.argv.includes('--accept')
const BIN = join(ROOT, 'node_modules/.bin')

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function must(path: string, what: string): string {
  if (!existsSync(path)) {
    console.error(`[verify] missing ${what}: ${path}`)
    console.error('[verify] P0-b needs the frozen real data; without the freeze there is no target to compare against.')
    process.exit(1)
  }
  return readFileSync(path, 'utf8')
}

function run(cmd: string, args: string[], timeout = 900_000) {
  const r = spawnSync(join(BIN, cmd), args, { cwd: ROOT, encoding: 'utf8', timeout })
  if (r.error) throw new Error(`${cmd} could not be executed: ${r.error.message}`)
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status ?? 1 }
}

/** git is not in node_modules/.bin, so it comes from PATH. */
function git(args: string[]): string {
  return (spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim()
}

// ---------- P0-a hygiene layer ----------
type Values = Record<string, number>

function hygiene(): Values {
  const v: Values = {}

  // One vitest run yields both the counts and the coverage (json reporter writes the file, coverage goes to lcov.info)
  const reportPath = join(ROOT, 'verify/.vitest.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  run('vitest', ['run', '--coverage', '--reporter=json', `--outputFile=${reportPath}`])
  // vitest signals test failures through its exit code; do not exit on it here — record the
  // numbers first and let the comparison below decide everything in one place.
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    numPassedTests: number
    numFailedTests: number
    numPendingTests: number
    numTotalTests: number
  }
  v.testsPassed = report.numPassedTests
  v.testsFailed = report.numFailedTests
  v.testsPending = report.numPendingTests
  v.testsTotal = report.numTotalTests

  // The coverage artifact is not produced when tests fail — which is exactly the moment the gate
  // most needs to report. So record it as unavailable (-1) and keep measuring lint/tsc, leaving the
  // judgement to testsFailed.
  const lcovPath = join(ROOT, 'coverage/lcov.info')
  if (!existsSync(lcovPath)) {
    console.warn('[verify] coverage artifact missing (usually because tests failed); lines/funcs recorded as -1 = unavailable')
    v.linesPct = -1
    v.funcsPct = -1
  } else {
    let lf = 0, lh = 0, fnf = 0, fnh = 0
    for (const line of readFileSync(lcovPath, 'utf8').split('\n')) {
      if (line.startsWith('LF:')) lf += Number(line.slice(3))
      else if (line.startsWith('LH:')) lh += Number(line.slice(3))
      else if (line.startsWith('FNF:')) fnf += Number(line.slice(4))
      else if (line.startsWith('FNH:')) fnh += Number(line.slice(4))
    }
    v.linesPct = lf ? Math.round((lh / lf) * 10000) / 100 : 0
    v.funcsPct = fnf ? Math.round((fnh / fnf) * 10000) / 100 : 0
  }

  const lint = run('oxlint', ['src', 'tests', '--format=json'])
  v.lintDiagnostics = (JSON.parse(lint.out || '{"diagnostics":[]}') as { diagnostics?: unknown[] }).diagnostics?.length ?? 0

  const tsc = run('tsc', ['-p', 'tsconfig.json', '--noEmit'])
  v.tscErrors = (tsc.out + tsc.err).split('\n').filter((l) => l.includes('error TS')).length

  return v
}

// ---------- P0-b contract layer ----------
type AppliedEdit = { action: string; kind: string; id: string; applied?: boolean; after?: Record<string, unknown> }

/**
 * `appliedEdits[].after` in `refinements.jsonl` is the **result content text** (a string),
 * not the entry object and not a hash; 40 of them are null (delete or conclusion-only).
 * So it is used here as the `content` to reconstruct the edit — that covers the content
 * rules, but it **omits** the original description/files/blastRadius fields, making this an
 * approximate reconstruction. A digest change still reliably means "the verdict behaviour
 * changed", but it does not mean "that original edit object would pass".
 */
function contractVerdicts(): { digest: string; n: number; rejected: number; noContent: number } {
  const lines = must(join(CORPUS, 'refinements.jsonl'), 'the frozen refinements.jsonl').split('\n').filter((l) => l.trim())
  const verdicts: string[] = []
  let rejected = 0
  let noContent = 0
  for (const line of lines) {
    const rec = JSON.parse(line) as { appliedEdits?: AppliedEdit[] }
    for (const a of rec.appliedEdits ?? []) {
      const content = typeof a.after === 'string' ? a.after : undefined
      if (content === undefined && a.action !== 'delete') noContent += 1
      const edit = {
        action: a.action,
        kind: a.kind,
        id: a.id,
        ...(a.action !== 'delete' && content !== undefined ? { content } : {}),
        reason: 'reconstructed-from-appliedEdits',
      }
      let verdict: string
      try {
        // replay: true is required: a non-delete edit must carry a blastRadius, and a replay
        // restates the recorded history rather than declaring a reach (see the comment at refine.ts:66-73).
        verdict = (validateEdit(edit as never, { replay: true }) as string | undefined) ?? 'ok'
      } catch (e) {
        verdict = `throw:${(e as Error).message.slice(0, 60)}`
      }
      if (verdict !== 'ok') rejected += 1
      verdicts.push(`${a.action}/${a.kind}/${a.id}:${verdict}`)
    }
  }
  return { digest: sha(verdicts.join('\n')), n: verdicts.length, rejected, noContent }
}

function contractEntries(): { digest: string; n: number } {
  const raw = must(join(CORPUS, 'harness_state.json'), 'the frozen harness_state.json')
  const state = JSON.parse(raw) as { entries: Record<string, Record<string, HarnessEntry>> }
  const all = Object.values(state.entries).flatMap((byId) => Object.values(byId))
  const prints = all
    .map((e) => `${e.kind}/${e.id}/${entryFingerprint(e)}`)
    .sort()
  return { digest: sha(prints.join('\n')), n: all.length }
}

/**
 * The decision layer's contract: feed a fixed set of cell combinations to `decideBenchmark`
 * and digest the result. Without this layer, the rules in `score.ts` could be rewritten at will
 * without anyone noticing — the counting layer only raises an alarm when the test count changes.
 */
function cell(side: 'reference' | 'candidate', score: number | null, iteration = 1): CellScore {
  return {
    runId: 'verify', side, caseId: 'c', iteration, score,
    status: score === null ? 'failed' : 'ok',
    snapshotId: 'verify', stateHash: 'verify', caseHash: 'verify',
    recordedAt: 'verify',
  }
}

/**
 * `n` paired iterations whose candidate scores `delta` above the reference.
 * Six is the smallest count the acceptance-side sign test can call significant
 * (p = 2·(1/2)⁶ = 0.031), so the rows that must end in ACCEPTED use six.
 */
function pairs(n: number, delta: number, reference: number, caseId = 'c'): CellScore[] {
  return Array.from({ length: n }, (_, index) => index + 1).flatMap(iteration => [
    { ...cell('reference', reference, iteration), caseId },
    { ...cell('candidate', reference + delta, iteration), caseId },
  ])
}

const DECISION_TABLE: Array<{ name: string; cells: CellScore[] }> = [
  { name: 'improve-above-noise', cells: pairs(6, 5, 80) },
  // The acceptance-side sign test: an improvement that clears the noise bar but
  // rests on too few agreeing pairs is a coincidence, not an improvement. Two
  // identical +5 pairs give a zero-width interval and p = 0.5.
  { name: 'improve-too-few-consistent-pairs', cells: pairs(2, 5, 80) },
  { name: 'single-iteration', cells: [cell('reference', 80), cell('candidate', 95)] },
  { name: 'improve-inside-noise', cells: [cell('reference', 80, 1), cell('reference', 90, 2), cell('candidate', 85, 1), cell('candidate', 90, 2)] },
  // The same pair states give [12,0] and [0,−13] across two runs: a negative shift inside
  // the noise is not a regression either.
  { name: 'drop-inside-noise', cells: [cell('reference', 62, 1), cell('reference', 87, 2), cell('candidate', 62, 1), cell('candidate', 74, 2)] },
  { name: 'equal-scores', cells: [cell('reference', 80, 1), cell('reference', 80, 2), cell('candidate', 80, 1), cell('candidate', 80, 2)] },
  { name: 'partial-reference', cells: [cell('reference', 80, 1), cell('reference', null, 2), cell('candidate', 90, 1), cell('candidate', 90, 2)] },
  { name: 'per-case-regression', cells: [cell('reference', 90, 1), cell('reference', 90, 2), cell('candidate', 70, 1), cell('candidate', 70, 2)] },
  { name: 'candidate-failed', cells: [cell('reference', 80, 1), cell('reference', 80, 2), cell('candidate', null, 1), cell('candidate', 80, 2)] },
  // An empty side is a missing measurement, not evidence of a regression, so the
  // verdict must be INCONCLUSIVE with this exact reason; this row pins the landing
  // that the whole rule exists for.
  { name: 'candidate-all-failed', cells: [cell('reference', 80, 1), cell('candidate', null, 1)] },
  // A failure is "never measured", not "measured bad": a failed cell on the candidate side must
  // not veto the run as a regression, but a regression the run did measure must still outrank the
  // incompleteness the failures bring (next row).
  { name: 'candidate-failed-but-improved', cells: [...pairs(6, 15, 80), cell('candidate', null, 7)] },
  { name: 'failed-then-regressed', cells: [cell('reference', 90, 1), cell('reference', 90, 2), cell('candidate', 70, 1), cell('candidate', 70, 2), cell('candidate', null, 3)] },
  // Multiple cases: the noise must be measured per case, otherwise the difficulty gap between
  // cases (90 vs 70) is mistaken for noise and swallows a real improvement. This row watches that
  // semantic specifically.
  { name: 'multi-case-gap-is-not-noise', cells: [...pairs(3, 2, 90, 'hard'), ...pairs(3, 1, 70, 'easy')] },
]

function contractDecisions(): { digest: string; n: number; statuses: string[] } {
  const rows = DECISION_TABLE.map((entry) => {
    const d = decideBenchmark({
      runId: 'verify',
      refinementId: 'verify',
      cells: entry.cells,
      now: () => new Date(0),
    })
    return { name: entry.name, status: d.status, reason: d.inconclusiveReason ?? '-', row: `${entry.name}:${d.status}:${d.inconclusiveReason ?? '-'}:${d.pairedDelta}:${d.pairs}:${d.noiseFloor}:${d.regressionCases.join(',')}` }
  })
  return {
    digest: sha(rows.map((r) => r.row).join('\n')),
    n: rows.length,
    statuses: rows.map((r) => `${r.name}=${r.status}${r.reason === '-' ? '' : `(${r.reason})`}`),
  }
}

// ---------- comparison and verdict ----------
// Direction: +1 means higher is better, -1 means lower is better, 0 means it must be equal (no direction)
const DIRECTION: Record<string, 1 | -1 | 0> = {
  testsPassed: 1,
  testsFailed: -1,
  testsPending: -1,
  testsTotal: 1,
  linesPct: 1,
  funcsPct: 1,
  lintDiagnostics: -1,
  tscErrors: -1,
  verdictDigest: 0,
  entryDigest: 0,
  decisionDigest: 0,
}

function main() {
  const hygieneValues = hygiene()
  const verdicts = contractVerdicts()
  const entries = contractEntries()
  const decisions = contractDecisions()

  const current: Values = { ...hygieneValues }
  const digests: Record<string, string> = {
    verdictDigest: verdicts.digest,
    entryDigest: entries.digest,
    decisionDigest: decisions.digest,
  }
  const meta = {
    verdictEdits: verdicts.n,
    verdictRejected: verdicts.rejected,
    verdictNoContent: verdicts.noContent,
    entries: entries.n,
    decisionCases: decisions.n,
    head: git(['rev-parse', '--short', 'HEAD']),
    at: new Date().toISOString(),
  }

  const snapshot = { values: current, digests, meta }

  if (ACCEPT || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(`[verify] ${ACCEPT ? 'accepted' : 'established'} the baseline: verify/latest.json`)
    console.log(`  P0-a tests ${current.testsPassed}/${current.testsTotal} passed, pending ${current.testsPending}, lines ${current.linesPct}%, funcs ${current.funcsPct}%, lint ${current.lintDiagnostics}, tsc ${current.tscErrors}`)
    console.log(`  P0-b verdict vector ${digests.verdictDigest} (${meta.verdictEdits} edits, ${meta.verdictRejected} not ok), entry fingerprints ${digests.entryDigest} (${meta.entries} entries), decision contract ${digests.decisionDigest} (${meta.decisionCases} rows)`)
    console.log(`       decision samples ${decisions.statuses.join(' ')}`)
    process.exit(0)
  }

  const prev = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof snapshot
  const worse: string[] = []
  const better: string[] = []
  const changed: string[] = []

  console.log('metric                  baseline         → current            verdict')
  console.log('─'.repeat(64))
  for (const [key, dir] of Object.entries(DIRECTION)) {
    const isDigest = key.endsWith('Digest')
    const before = isDigest ? prev.digests[key] : prev.values[key]
    const after = isDigest ? digests[key] : current[key]
    let verdict: string
    if (before === after) {
      verdict = 'unchanged'
    } else if (isDigest) {
      verdict = '⚠ changed (needs a human verdict)'
      changed.push(key)
    } else if (dir === 0) {
      verdict = '⚠ changed'
      changed.push(key)
    } else {
      const improved = dir > 0 ? (after as number) > (before as number) : (after as number) < (before as number)
      verdict = improved ? '↑ better' : '↓ worse'
      ;(improved ? better : worse).push(key)
    }
    console.log(`${key.padEnd(18)} ${String(before).padStart(10)} → ${String(after).padEnd(10)} ${verdict}`)
  }
  console.log('─'.repeat(64))
  console.log(`P0-a ${worse.length} worse, ${better.length} better; P0-b ${changed.length} digest change(s)`)
  // A digest can only prove "something changed"; a human verdict has to see what state every row became.
  if (changed.includes('decisionDigest')) {
    console.log(`  [verify] decision samples (basis for the verdict) ${decisions.statuses.join(' ')}`)
  }

  if (worse.length) {
    console.error(`[verify] verdict: worse (${worse.join(', ')})`)
    console.error('[verify] That is a real, deterministically measured regression. Fix it, or accept it explicitly with npm run verify:accept.')
    process.exit(1)
  }
  if (changed.length) {
    console.error(`[verify] verdict: the semantics/contract changed (${changed.join(', ')}) — a digest is neutral,`)
    console.error('[verify] it can only prove "changed", never "better". Run npm run verify:accept after a human verdict.')
    process.exit(1)
  }
  console.log('[verify] verdict: consistent with the baseline (nothing got worse). Note that this only means')
  console.log('[verify] known things were not broken — not that there is a gain. The effect layer must be shown by a paired A/B in harness_benchmark.')
  process.exit(0)
}

main()
