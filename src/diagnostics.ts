/**
 * Post-apply diagnostics: a protocol-independent runner that aggregates
 * independent providers (L2 structural, optional L3 security) over the touched
 * skills of a committed refinement. Diagnostics only diagnose: they never
 * roll back, never block an already-produced commit status, never write files,
 * and never scan untouched entries (spec §1/§2/§4).
 * @module dsh-continual-harness
 */

import { validateBundleFiles, validateSkillBundle } from './skills.ts'
import type {
  DiagnosticProvider,
  DiagnosticReport,
  DiagnosticRequest,
  SecurityIssue,
  SkillBundleIssue,
} from './types.ts'

/** A post-apply diagnostics runner injected into the coordinator hook. */
export interface DiagnosticRunner {
  run(request: DiagnosticRequest): Promise<DiagnosticReport>
}

/** Construction options for the aggregating runner. */
export interface DiagnosticRunnerOptions {
  /** L2 structural provider over touched skills only. */
  structural?: DiagnosticProvider<SkillBundleIssue>
  /** Optional L3 security provider; runs only when enableSecurity is true. */
  security?: DiagnosticProvider<SecurityIssue>
  /** Whether the security provider is enabled for this runner. */
  enableSecurity: boolean
}

/** Extract a stable error code and message from a provider rejection. */
function providerError(reason: unknown): { code: string; message: string } {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (typeof reason === 'object' && reason !== null
      && typeof (reason as { code?: unknown }).code === 'string') {
    return { code: (reason as { code: string }).code, message }
  }
  return { code: 'provider-failed', message }
}

/** Append issues to the report array matching a provider key (structural vs security). */
function appendIssues(
  report: DiagnosticReport,
  key: 'structural' | 'security',
  items: unknown[],
): void {
  if (key === 'structural') report.structural.push(...(items as SkillBundleIssue[]))
  else report.security.push(...(items as SecurityIssue[]))
}

/**
 * Create the aggregating runner. Enabled providers run with
 * `Promise.allSettled` so one failure never discards another provider's
 * findings. Successful findings are preserved, failures become
 * `{ provider, code, message }` errors, and the report is `partial` when at
 * least one enabled provider failed or the signal was aborted. With no enabled
 * provider the report is `disabled` rather than an empty success.
 */
export function createDiagnosticRunner(options: DiagnosticRunnerOptions): DiagnosticRunner {
  return {
    async run(request) {
      const enabled: Array<{
        name: string
        key: 'structural' | 'security'
        run: (request: DiagnosticRequest) => Promise<SkillBundleIssue[] | SecurityIssue[]>
      }> = []
      if (options.structural !== undefined) {
        enabled.push({ name: options.structural.name, key: 'structural', run: options.structural.run })
      }
      if (options.security !== undefined && options.enableSecurity) {
        enabled.push({ name: options.security.name, key: 'security', run: options.security.run })
      }
      if (enabled.length === 0) {
        return {
          status: 'disabled',
          structural: [],
          security: [],
          errors: [],
        }
      }
      const settled = await Promise.allSettled(enabled.map(provider => provider.run(request)))
      const report: DiagnosticReport = {
        status: 'completed',
        structural: [],
        security: [],
        errors: [],
      }
      let failed = false
      settled.forEach((outcome, index) => {
        const provider = enabled[index]!
        if (outcome.status === 'fulfilled') {
          appendIssues(report, provider.key, outcome.value)
          return
        }
        failed = true
        // A provider rejection may carry collected issues (e.g. ScanTruncatedError):
        // keep them in the report so truncation never discards findings.
        const reason = outcome.reason as { issues?: unknown[] } | undefined
        if (Array.isArray(reason?.issues)) appendIssues(report, provider.key, reason.issues)
        const error = providerError(outcome.reason)
        report.errors.push({ provider: provider.name, code: error.code, message: error.message })
      })
      if (failed || request.signal?.aborted) report.status = 'partial'
      return report
    },
  }
}

/**
 * The L2 structural provider (spec §2/§4): pure validation over
 * `request.entries` and `request.touchedSkillIds` only. For each touched id it
 * reports an issue when the effective entry is absent, its bundle `files` map
 * violates the L1 bundle limits, or its content fails the existing L2 skill
 * checks (via `validateBundleFiles`/`validateSkillBundle`). It never writes
 * files, never re-reads Store state or the filesystem, and a request with no
 * touched ids completes with empty findings without any full-store scan.
 */
export const structuralProvider: DiagnosticProvider<SkillBundleIssue> = {
  name: 'structural',
  async run(request) {
    const issues: SkillBundleIssue[] = []
    for (const skillId of request.touchedSkillIds) {
      const entry = request.entries[skillId]
      if (entry === undefined) {
        issues.push({
          skillId,
          code: 'entry-missing',
          message: `no effective entry found for touched skill "${skillId}"`,
        })
        continue
      }
      const bundleFailure = validateBundleFiles(entry.files ?? {})
      if (bundleFailure !== undefined) {
        issues.push({ skillId, code: 'invalid-bundle-files', message: bundleFailure })
      }
      for (const finding of validateSkillBundle(entry)) {
        issues.push({ skillId, code: finding.code, message: finding.message })
      }
    }
    return issues
  },
}
