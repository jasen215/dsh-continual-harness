/**
 * Pure L3 skill security scanner (spec): runs stable, low-false-positive
 * detectors over one in-memory SkillEntry — description, SKILL.md body, and
 * sorted files. Never reads the filesystem, never executes scanned scripts,
 * never scans beyond the single entry handed to it.
 * @module dsh-continual-harness
 */

import type { DiagnosticProvider, SecurityIssue, SkillEntry } from './types.ts'

/** Hard internal findings cap per scanSkillBundle call (spec §4); not configurable. */
export const MAX_FINDINGS = 100

/** Thrown when scanSkillBundle hits MAX_FINDINGS; carries the issues collected so far. */
export class ScanTruncatedError extends Error {
  readonly code = 'findings-truncated'
  constructor(readonly issues: SecurityIssue[]) {
    super('security scan stopped at the findings limit')
    this.name = 'ScanTruncatedError'
  }
}

/** Scan options: an optional abort signal checked between scan blocks. */
export interface ScanOptions {
  signal?: AbortSignal
}

interface SecretPattern {
  evidence: string
  pattern: RegExp
}

/** Credential-like patterns (spec §2): evidence is a typed label, never the matched text. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { evidence: 'sk-key-like', pattern: /sk-[A-Za-z0-9]{16,}/ },
  { evidence: 'sk-modern-key-like', pattern: /sk-(?:proj|ant|svcacct)-[A-Za-z0-9_-]{20,}/ },
  { evidence: 'github-token-like', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { evidence: 'github-pat-like', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { evidence: 'slack-token-like', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { evidence: 'stripe-key-like', pattern: /sk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { evidence: 'jwt-like', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { evidence: 'private-key-header', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { evidence: 'google-api-key-like', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { evidence: 'aws-access-key-like', pattern: /AKIA[0-9A-Z]{16}/ },
]

/** One independent rule; `match` returns a redacted evidence label or undefined. */
interface Detector {
  code: string
  severity: 'low' | 'medium' | 'high'
  message: string
  match(line: string): string | undefined
}

const secretDetector: Detector = {
  code: 'secret-exposure',
  severity: 'high',
  message: 'touched skill content looks like a credential; rotate and remove it before sharing',
  match(line) {
    for (const { evidence, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) return evidence
    }
    return undefined
  },
}

/** Zero-width, RTL/LTR override, invisible bidi marks, and other hidden control characters (spec §2). */
// oxlint-disable-next-line no-control-regex -- matching control characters is this pattern's purpose
const HIDDEN_CONTROL_PATTERN = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u200E\u200F\u061C\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

const hiddenControlDetector: Detector = {
  code: 'hidden-control-chars',
  severity: 'medium',
  message: 'skill text contains hidden Unicode control or zero-width characters; they can conceal instructions',
  match(line) {
    return HIDDEN_CONTROL_PATTERN.test(line) ? 'control-character-present' : undefined
  },
}

/** Full-phrase instruction-override signals; never single trigger words (spec §5). */
const OVERRIDE_PATTERNS: readonly RegExp[] = [
  /ignore\s+all\s+(previous|prior)\s+(instructions|prompts)/i,
  /ignore\s+the\s+(system|above|original)\s+prompt/i,
  /ignore\s+the\s+instructions\s+above/i,
  /override\s+(your|the)\s+system\s+prompt/i,
  /disregard\s+(all\s+)?(previous\s+)?(instructions|guidelines)/i,
  /you\s+are\s+now\s+(without|no\s+longer)\s+(bound|constrained|restricted)/i,
]

const overrideDetector: Detector = {
  code: 'instruction-override',
  severity: 'medium',
  message: 'text asks the agent to ignore or override its instructions; confirm the skill really needs this',
  match(line) {
    return OVERRIDE_PATTERNS.some(pattern => pattern.test(line)) ? 'instruction-override-phrase' : undefined
  },
}

const DETECTORS: readonly Detector[] = [secretDetector, hiddenControlDetector, overrideDetector]

/** Scan one text block; one finding per rule/file/line, capped at MAX_FINDINGS. */
function scanText(
  issues: SecurityIssue[],
  skillId: string,
  file: string,
  text: string,
  reportLines: boolean,
  options?: ScanOptions,
): void {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (options?.signal?.aborted) return
    const line = lines[i]!
    for (const detector of DETECTORS) {
      const evidence = detector.match(line)
      if (evidence === undefined) continue
      const lineNo = reportLines ? i + 1 : undefined
      issues.push({
        skillId,
        code: detector.code,
        message: detector.message,
        severity: detector.severity,
        file,
        ...(lineNo === undefined ? {} : { line: lineNo }),
        evidence,
      })
      if (issues.length >= MAX_FINDINGS) throw new ScanTruncatedError(issues)
    }
  }
}

/**
 * Scan one skill entry (spec §3.2). Order is stable: description (file
 * 'SKILL.md', no line), SKILL.md body (file 'SKILL.md', 1-based lines), the
 * legacy reference/arguments fields (file 'SKILL.md', no line — they reach the
 * model overview without a separate file), then files sorted by relative path
 * (1-based lines). Does not scan version, updatedAt, or provenance metadata.
 */
export function scanSkillBundle(skillId: string, entry: SkillEntry, options?: ScanOptions): SecurityIssue[] {
  const issues: SecurityIssue[] = []
  if (options?.signal?.aborted) return issues
  if (entry.description !== undefined) {
    scanText(issues, skillId, 'SKILL.md', entry.description, false, options)
  }
  if (options?.signal?.aborted) return issues
  scanText(issues, skillId, 'SKILL.md', entry.content, true, options)
  const legacy = [entry.reference, entry.arguments].filter((value): value is string => value !== undefined)
  for (const value of legacy) {
    scanText(issues, skillId, 'SKILL.md', value, false, options)
  }
  const files = entry.files ?? {}
  for (const path of Object.keys(files).sort()) {
    if (options?.signal?.aborted) return issues
    scanText(issues, skillId, path, files[path]!, true, options)
  }
  return issues
}

/**
 * Post-apply diagnostics adapter (spec §3.3): scans only
 * `request.touchedSkillIds` and aggregates findings per skill. A
 * ScanTruncatedError from any skill keeps that skill's findings and still
 * lets later touched skills scan; the aggregated truncation is re-thrown so
 * the runner records a `findings-truncated` error with all collected issues.
 */
export const securityProvider: DiagnosticProvider<SecurityIssue> = {
  name: 'security',
  async run(request) {
    const issues: SecurityIssue[] = []
    let truncated = false
    for (const skillId of request.touchedSkillIds) {
      const entry = request.entries[skillId]
      if (entry === undefined) continue
      try {
        const scanOptions = request.signal === undefined ? {} : { signal: request.signal }
        issues.push(...scanSkillBundle(skillId, entry, scanOptions))
      } catch (error) {
        if (error instanceof ScanTruncatedError) {
          issues.push(...error.issues)
          truncated = true
        } else {
          throw error
        }
      }
    }
    if (truncated) throw new ScanTruncatedError(issues)
    return issues
  },
}
