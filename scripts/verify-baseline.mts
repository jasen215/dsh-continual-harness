#!/usr/bin/env tsx
/**
 * 本地基线闸 —— P0-a 卫生层 + P0-b 契约层。
 *
 * 用法：
 *   npm run verify          与 verify/latest.json 比较，退 0=不变/变好，1=变差
 *   npm run verify:accept   接受当前值为新基线（人工裁决后使用）
 *
 * 范围（如实声明）：
 *   - P0-a：测试通过数 / pending / 覆盖率(lines,funcs) / lint diagnostics / tsc 错误
 *   - P0-b：A 真实 refinement 的 validateEdit 判定向量 digest
 *           C 真实 harness_state 条目的 entryFingerprint digest
 *   - 不做 P1（效果层）——那必须靠配对 A/B（harness_benchmark），本脚本回答不了。
 *
 * P0-b 的输入是 verify/corpus/ 下**冻结**的真实数据（本地，不入库，见 D2/C）。
 * 未冻结就没有基线可言，脚本会直接报错退出——不静默跳过。
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
    console.error(`[verify] 缺少${what}：${path}`)
    console.error('[verify] P0-b 需要冻结的真实数据；未冻结就没有可比较的靶子。')
    process.exit(1)
  }
  return readFileSync(path, 'utf8')
}

function run(cmd: string, args: string[], timeout = 900_000) {
  const r = spawnSync(join(BIN, cmd), args, { cwd: ROOT, encoding: 'utf8', timeout })
  if (r.error) throw new Error(`${cmd} 无法执行：${r.error.message}`)
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status ?? 1 }
}

/** git 不在 node_modules/.bin，走 PATH。 */
function git(args: string[]): string {
  return (spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim()
}

// ---------- P0-a 卫生层 ----------
type Values = Record<string, number>

function hygiene(): Values {
  const v: Values = {}

  // 一次 vitest 同时拿到计数与覆盖率（json reporter 写文件，覆盖率走 lcov.info）
  const reportPath = join(ROOT, 'verify/.vitest.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  run('vitest', ['run', '--coverage', '--reporter=json', `--outputFile=${reportPath}`])
  // vitest 用退出码表达测试失败，这里不据此退出——先记录数字，由下面的比较统一裁决
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

  // 覆盖率产物在测试失败时不会生成——而那时正是最需要闸门报告的时刻。
  // 因此记为不可得（-1）并继续测后面的 lint/tsc，让 testsFailed 承担判定。
  const lcovPath = join(ROOT, 'coverage/lcov.info')
  if (!existsSync(lcovPath)) {
    console.warn('[verify] 覆盖率产物缺失（通常因测试失败），lines/funcs 记为 -1=不可得')
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

// ---------- P0-b 契约层 ----------
type AppliedEdit = { action: string; kind: string; id: string; applied?: boolean; after?: Record<string, unknown> }

/**
 * `refinements.jsonl` 的 `appliedEdits[].after` 是**结果内容文本**（字符串），
 * 不是条目对象、也不是哈希；40 条为 null（delete 或 conclusion-only）。
 * 因此这里用它作为 `content` 重建 edit——它能覆盖 content 类规则，
 * 但**不含** description/files/blastRadius 等原始字段，属于近似重建。
 * digest 变化仍可靠表示"判定行为变了"，但不等于"当初那份 edit 原件通过"。
 */
function contractVerdicts(): { digest: string; n: number; rejected: number; noContent: number } {
  const lines = must(join(CORPUS, 'refinements.jsonl'), '冻结的 refinements.jsonl').split('\n').filter((l) => l.trim())
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
        // replay: true 是必需的：非 delete 的 edit 必须有 blastRadius，而回放
        // 是"重述记录下来的历史"，不是"声明作用范围"（见 refine.ts:66-73 的注释）。
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
  const raw = must(join(CORPUS, 'harness_state.json'), '冻结的 harness_state.json')
  const state = JSON.parse(raw) as { entries: Record<string, Record<string, HarnessEntry>> }
  const all = Object.values(state.entries).flatMap((byId) => Object.values(byId))
  const prints = all
    .map((e) => `${e.kind}/${e.id}/${entryFingerprint(e)}`)
    .sort()
  return { digest: sha(prints.join('\n')), n: all.length }
}

/**
 * 判定层的契约：把固定的 cell 组合喂给 `decideBenchmark`，digest 其结果。
 * 没有这一层，`score.ts` 的判定规则可以被随意改写而不被发现——
 * 计数层只在测试数量变化时才报警。
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
  // 同一对状态在两次 run 里给出 [12,0] 与 [0,−13]：负向落在噪声内也不算退化。
  { name: 'drop-inside-noise', cells: [cell('reference', 62, 1), cell('reference', 87, 2), cell('candidate', 62, 1), cell('candidate', 74, 2)] },
  { name: 'equal-scores', cells: [cell('reference', 80, 1), cell('reference', 80, 2), cell('candidate', 80, 1), cell('candidate', 80, 2)] },
  { name: 'partial-reference', cells: [cell('reference', 80, 1), cell('reference', null, 2), cell('candidate', 90, 1), cell('candidate', 90, 2)] },
  { name: 'per-case-regression', cells: [cell('reference', 90, 1), cell('reference', 90, 2), cell('candidate', 70, 1), cell('candidate', 70, 2)] },
  { name: 'candidate-failed', cells: [cell('reference', 80, 1), cell('reference', 80, 2), cell('candidate', null, 1), cell('candidate', 80, 2)] },
  // An empty side is a missing measurement, not evidence of a regression, so the
  // verdict must be INCONCLUSIVE with this exact reason; this row pins the landing
  // that the whole rule exists for.
  { name: 'candidate-all-failed', cells: [cell('reference', 80, 1), cell('candidate', null, 1)] },
  // 失败是"没测到"而非"测出差"：候选侧有失败 cell 不得被当成退化否决，
  // 但真实测出的退化仍须压过失败带来的不完整（下一行）。
  { name: 'candidate-failed-but-improved', cells: [...pairs(6, 15, 80), cell('candidate', null, 7)] },
  { name: 'failed-then-regressed', cells: [cell('reference', 90, 1), cell('reference', 90, 2), cell('candidate', 70, 1), cell('candidate', 70, 2), cell('candidate', null, 3)] },
  // 多 case：噪声必须按 case 度量，否则 case 间的难度差（90 vs 70）会被误当噪声
  // 而吞掉真实改进。这一行专门盯住这个语义。
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

// ---------- 比较与裁决 ----------
// 方向：+1 表示越大越好，-1 表示越小越好，0 表示必须相等（无方向）
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
    console.log(`[verify] ${ACCEPT ? '已接受' : '首次建立'}基线：verify/latest.json`)
    console.log(`  P0-a 测试 ${current.testsPassed}/${current.testsTotal} 通过, pending ${current.testsPending}, lines ${current.linesPct}%, funcs ${current.funcsPct}%, lint ${current.lintDiagnostics}, tsc ${current.tscErrors}`)
    console.log(`  P0-b 判定向量 ${digests.verdictDigest} (${meta.verdictEdits} edits, ${meta.verdictRejected} 非 ok), 条目指纹 ${digests.entryDigest} (${meta.entries} 条), 决策契约 ${digests.decisionDigest} (${meta.decisionCases} 组)`)
    console.log(`       决策样例 ${decisions.statuses.join(' ')}`)
    process.exit(0)
  }

  const prev = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof snapshot
  const worse: string[] = []
  const better: string[] = []
  const changed: string[] = []

  console.log('指标                    基线 → 当前              判定')
  console.log('─'.repeat(64))
  for (const [key, dir] of Object.entries(DIRECTION)) {
    const isDigest = key.endsWith('Digest')
    const before = isDigest ? prev.digests[key] : prev.values[key]
    const after = isDigest ? digests[key] : current[key]
    let verdict: string
    if (before === after) {
      verdict = '不变'
    } else if (isDigest) {
      verdict = '⚠ 变了(需人工裁决)'
      changed.push(key)
    } else if (dir === 0) {
      verdict = '⚠ 变了'
      changed.push(key)
    } else {
      const improved = dir > 0 ? (after as number) > (before as number) : (after as number) < (before as number)
      verdict = improved ? '↑ 变好' : '↓ 变差'
      ;(improved ? better : worse).push(key)
    }
    console.log(`${key.padEnd(18)} ${String(before).padStart(10)} → ${String(after).padEnd(10)} ${verdict}`)
  }
  console.log('─'.repeat(64))
  console.log(`P0-a 变差 ${worse.length} 项，变好 ${better.length} 项；P0-b digest 变化 ${changed.length} 项`)
  // digest 只能证明"变了"，人工裁决必须看到每一行变成了什么状态。
  if (changed.includes('decisionDigest')) {
    console.log(`  [verify] 决策样例（裁决依据）${decisions.statuses.join(' ')}`)
  }

  if (worse.length) {
    console.error(`[verify] 结论：变差（${worse.join(', ')}）`)
    console.error('[verify] 这是确定性量的真实退化。修回，或确认可接受后 npm run verify:accept。')
    process.exit(1)
  }
  if (changed.length) {
    console.error(`[verify] 结论：语义/契约发生变化（${changed.join(', ')}）——digest 是中性的，`)
    console.error('[verify] 它只能证明"变了"，不能证明"更好"。人工裁决后 npm run verify:accept。')
    process.exit(1)
  }
  console.log('[verify] 结论：与基线一致（未变差）。注意：这只说明"没碰坏已知的东西"，')
  console.log('[verify] 不等于"有收益"——效果层必须靠 harness_benchmark 的配对 A/B。')
  process.exit(0)
}

main()
