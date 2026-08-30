/**
 * dsh-continual-harness — a standalone DeepSeek Harness plugin implementing
 * continual harness self-evolution. One plugin mounts the
 * store, the model-facing `harness_refine` tool, the digest-tracked prompt
 * projection, and the automatic refinement gate.
 *
 * Mounting: add this package as a plugin of a dsh profile (e.g. through the
 * profile's cordis.patch.yml or the settings UI). It needs the `tools`,
 * `agents`, and `session` capability packages loaded before it.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { requireGlobalApproval } from './approval.ts'
import {
  DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS, DEFAULT_TOKEN_PER_CHAR_RATIO, MIN_PLANNER_OUTPUT_TOKENS,
} from './budget.ts'
import { completeViaAgent, DEFAULT_PLANNER_MAX_TOKENS } from './complete.ts'
import type { PlannerPrefixCacheMode } from './cache-detect.ts'
import { createRefineCoordinator } from './coordinator.ts'
import { registerRefineCommand } from './command.ts'
import type { CommandsCapability } from './command.ts'
import { createDiagnosticRunner, structuralProvider } from './diagnostics.ts'
import { securityProvider } from './scan.ts'
import { DEFAULT_COOLDOWN_MS, DEFAULT_TURN_INTERVAL } from './driver.ts'
import { DEFAULT_SKILL_BUNDLE_LIMITS } from './skills.ts'
import { HARNESS_REFINEMENT_EVENT, registerSessionEventType } from './domain.ts'
import { attachFileLog, PLUGIN_LOG_FILE_NAME } from './logfile.ts'
import { DEFAULT_TRAJECTORY_MAX_CHARS, DEFAULT_TRAJECTORY_SIGNAL_RATIO } from './store.ts'
import { registerHarnessDriver } from './driver.ts'
import { registerHarnessProjection } from './projection.ts'
import { installHostRequestSnapshot } from './request-snapshot.ts'
import { HarnessStore } from './store.ts'
import { registerBenchmarkTool, registerHarnessTool, registerHarnessWrapup } from './tool.ts'
import type { RefinementKind } from './types.ts'

export const name = 'continual-harness'
export const inject = ['agents', 'tools']

/** Automatic refinement gate configuration. */
export interface AutoRefineConfig {
  /** Whether the gate runs at all. */
  enabled: boolean
  /** Assistant turns between automatic refinement passes. */
  turnInterval: number
  /** Cooldown between automatic refinement attempts. */
  cooldownMs: number
  /** Whether a compaction also triggers a gate pass. */
  compact: boolean
}

/** Explicit benchmark tool configuration (spec §5). */
export interface BenchmarkConfig {
  /** Whether the `harness_benchmark` tool is registered. */
  enabled: boolean
  /** Iterations per case per side when a run omits `runs`. */
  defaultRuns: number
  /** Upper bound for `runs`; a larger explicit value is refused. */
  maxRuns: number
  /** Report-only pass line in 0..100; never gates acceptance (§4.5). */
  passThreshold: number
  /** How far the candidate may fall below the reference before regressing. */
  regressionTolerance: number
  /** Maximum failed candidate cells a run may still accept. */
  maxFailedCells: number
}

/** Continual harness plugin configuration. */
export interface Config {
  /** Harness home; defaults under the dsh home directory. */
  harnessRoot?: string
  /**
   * Directory where skill entries materialize as dsh SKILL.md bundles.
   * Defaults to the dsh user skills root (`$DSH_HOME/skills`), which dsh's
   * filesystem skill provider scans live.
   */
  skillsDir?: string
  /**
   * Required deployment choice for the store the tool targets when a call
   * omits `global`: local keeps lessons session-scoped, global makes them
   * cross-session.
   */
  defaultGlobal: boolean
  /** Tail-biased trajectory window fed to the planner. */
  maxTrajectoryChars: number
  /** Output budget for the planning call. */
  plannerMaxTokens: number
  /** Planner prefix-cache routing: auto-detect, force session prefix, or off. */
  plannerPrefixCache?: PlannerPrefixCacheMode
  /**
   * Legacy compatibility key retained for schema compatibility only. Route A
   * no longer truncates or caps the session prefix — it reuses the host-loop
   * request snapshot verbatim (spec §2.2), so this value bounds nothing and is
   * not forwarded to the coordinator. Kept so existing configs keep validating.
   */
  plannerPrefixMaxChars?: number
  /** Route B: fraction of the trajectory budget reserved for the verbatim signal layer. */
  trajectorySignalRatio?: number
  /** Shared char→token estimate ratio for planner budget control (A and B). */
  plannerTokenPerCharRatio?: number
  /** Tokens reserved inside the context window for safety. */
  plannerSafetyReserveTokens?: number
  /** Minimum output tokens a planner route must be able to produce. */
  minPlannerOutputTokens?: number
  /** Automatic refinement gate settings. */
  autoRefine?: AutoRefineConfig
  /** Require explicit human approval before a global refinement commits. */
  requireGlobalApproval: boolean
  /** Per-kind cap for ranked injection into the model-visible overview. */
  maxInjectedEntriesPerKind: number
  /** Register the harness_wrapup tool. */
  wrapupEnabled: boolean
  /** Audit automatic review verdicts into the session log. */
  auditReviews: boolean
  /** Explicit benchmark tool settings (spec §5). */
  benchmark?: BenchmarkConfig
  /** Persist harness logs to a file. */
  logToFile: boolean
  /** Cap on the harness log file size in bytes. */
  logMaxBytes: number
  /** Per-commit entry growth fraction cap; 0 disables the check. */
  maxEntryGrowth: number
  /** Kinds the automatic path may not modify. */
  protectedKinds: RefinementKind[]
  /** Skill bundle limits (spec §7.10): file count, per-file bytes, total bytes (UTF-8). */
  maxSkillFiles: number
  maxSkillFileBytes: number
  maxSkillBundleBytes: number
  /** Run post-apply diagnostics after each committed refinement. */
  diagnosticsEnabled: boolean
  /** Enable the local L3 security provider inside the diagnostics runner. */
  securityEnabled: boolean
}

/** Benchmark configuration (spec §5) with its MVP defaults. */
export interface BenchmarkConfig {
  /** Whether the benchmark tool is registered at all. */
  enabled: boolean
  /** Iterations when the tool call omits `runs`. */
  defaultRuns: number
  /** Hard cap on iterations per run. */
  maxRuns: number
  /** Report-only pass line; never gates ACCEPTED (spec §4.5). */
  passThreshold: number
  /** Allowed downward drift of candidate vs reference before regression. */
  regressionTolerance: number
  /** Candidate failed cells above this count reject the run. */
  maxFailedCells: number
}

/** Benchmark config defaults (spec §5); shared by the schema and the apply fallback. */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  enabled: true,
  defaultRuns: 1,
  maxRuns: 3,
  passThreshold: 60,
  regressionTolerance: 0,
  maxFailedCells: 0,
}

/** Schemastery configuration for the continual harness plugin. */
export const Config: z<Config> = z.object({
  harnessRoot: z.string(),
  skillsDir: z.string(),
  defaultGlobal: z.boolean().required(),
  maxTrajectoryChars: z.number().step(1).min(1).default(DEFAULT_TRAJECTORY_MAX_CHARS),
  plannerMaxTokens: z.number().step(1).min(1).default(DEFAULT_PLANNER_MAX_TOKENS),
  // schemastery v3 has no `enum`; the union-of-literals idiom matches
  // `protectedKinds` below and validates identically.
  plannerPrefixCache: z.union(['auto', 'session', 'off']).default('auto'),
  // object fields are optional unless `.required()` (schemastery v3 has no
  // `.optional()` combinator); accepted for schema compatibility only — Route A
  // reuses the host prefix verbatim and never truncates it.
  plannerPrefixMaxChars: z.number().step(1).min(1),
  trajectorySignalRatio: z.number().min(0).max(1).default(DEFAULT_TRAJECTORY_SIGNAL_RATIO),
  plannerTokenPerCharRatio: z.number().min(0).max(1).default(DEFAULT_TOKEN_PER_CHAR_RATIO),
  plannerSafetyReserveTokens: z.number().step(1).min(0).default(DEFAULT_PLANNER_SAFETY_RESERVE_TOKENS),
  minPlannerOutputTokens: z.number().step(1).min(1).default(MIN_PLANNER_OUTPUT_TOKENS),
  autoRefine: z.object({
    enabled: z.boolean().default(true),
    turnInterval: z.number().step(1).min(1).default(DEFAULT_TURN_INTERVAL),
    cooldownMs: z.number().step(1).min(1).default(DEFAULT_COOLDOWN_MS),
    compact: z.boolean().default(true),
  }).default({ enabled: true, turnInterval: DEFAULT_TURN_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS, compact: true }),
  requireGlobalApproval: z.boolean().default(false),
  maxInjectedEntriesPerKind: z.number().step(1).min(1).default(6),
  wrapupEnabled: z.boolean().default(true),
  auditReviews: z.boolean().default(true),
  benchmark: z.object({
    enabled: z.boolean().default(DEFAULT_BENCHMARK_CONFIG.enabled),
    defaultRuns: z.number().step(1).min(1).default(DEFAULT_BENCHMARK_CONFIG.defaultRuns),
    maxRuns: z.number().step(1).min(1).default(DEFAULT_BENCHMARK_CONFIG.maxRuns),
    passThreshold: z.number().min(0).max(100).default(DEFAULT_BENCHMARK_CONFIG.passThreshold),
    regressionTolerance: z.number().min(0).default(DEFAULT_BENCHMARK_CONFIG.regressionTolerance),
    maxFailedCells: z.number().step(1).min(0).default(DEFAULT_BENCHMARK_CONFIG.maxFailedCells),
  }).default(DEFAULT_BENCHMARK_CONFIG),
  logToFile: z.boolean().default(true),
  logMaxBytes: z.number().step(1).min(1).default(5 * 1024 * 1024),
  maxEntryGrowth: z.number().min(0).default(0.5),
  protectedKinds: z.array(z.union(['prompt', 'memory', 'skill', 'subagent'])).default(['skill']),
  maxSkillFiles: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillFiles),
  maxSkillFileBytes: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillFileBytes),
  maxSkillBundleBytes: z.number().step(1).min(1).default(DEFAULT_SKILL_BUNDLE_LIMITS.maxSkillBundleBytes),
  diagnosticsEnabled: z.boolean().default(true),
  securityEnabled: z.boolean().default(false),
})

/**
 * Mount the continual harness: store, tool, projection, and driver. All
 * contributions register through effect-based APIs and dispose with the
 * context.
 * @param ctx - Cordis context carrying the tools and agents services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Legacy compatibility: older plugin builds wrote the `harness/refinement`
  // session event without an `ignorable` envelope marker; register the type
  // so those historical logs stay readable (removable once they age out).
  registerSessionEventType(HARNESS_REFINEMENT_EVENT)

  const store = new HarnessStore(ctx, {
    ...(config.harnessRoot === undefined ? {} : { harnessRoot: config.harnessRoot }),
    ...(config.skillsDir === undefined ? {} : { skillsDir: config.skillsDir }),
    maxEntryGrowth: config.maxEntryGrowth,
    protectedKinds: config.protectedKinds,
    skillBundleLimits: {
      maxSkillFiles: config.maxSkillFiles,
      maxSkillFileBytes: config.maxSkillFileBytes,
      maxSkillBundleBytes: config.maxSkillBundleBytes,
    },
    maxInjectedEntriesPerKind: config.maxInjectedEntriesPerKind,
  })
  // One protocol-independent coordinator owns request validation, planner
  // context capture, approval gating, commit serialization, and result
  // projection for both the tool and the automatic driver. The same
  // coordinator carries the post-apply diagnostics runner, so tool, command,
  // and automatic gate all see one report per commit.
  const hostRequests = installHostRequestSnapshot(ctx)
  const coordinator = createRefineCoordinator({
    store,
    logger: ctx.logger('harness'),
    completeFor: agent => completeViaAgent(ctx, agent, config.plannerMaxTokens),
    maxTrajectoryChars: config.maxTrajectoryChars,
    hostRequests,
    resolveContextWindow: async (provider, model, signal) => {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model, signal)
        return info?.context?.contextWindow
      } catch {
        return undefined
      }
    },
    // exactOptionalPropertyTypes: only present the optional fields when set.
    ...(config.plannerTokenPerCharRatio === undefined ? {} : { plannerTokenPerCharRatio: config.plannerTokenPerCharRatio }),
    ...(config.plannerSafetyReserveTokens === undefined ? {} : { plannerSafetyReserveTokens: config.plannerSafetyReserveTokens }),
    ...(config.minPlannerOutputTokens === undefined ? {} : { minPlannerOutputTokens: config.minPlannerOutputTokens }),
    plannerMaxTokens: config.plannerMaxTokens,
    // exactOptionalPropertyTypes: only present the optional fields when set.
    ...(config.plannerPrefixCache === undefined ? {} : { plannerPrefixCache: config.plannerPrefixCache }),
    ...(config.trajectorySignalRatio === undefined ? {} : { trajectorySignalRatio: config.trajectorySignalRatio }),
    ...(config.diagnosticsEnabled
      ? {
        diagnostics: createDiagnosticRunner({
          structural: structuralProvider,
          ...(config.securityEnabled ? { security: securityProvider } : {}),
          enableSecurity: config.securityEnabled,
        }),
      }
      : {}),
    // The conservative approval gate rides the tool plan path only: the user
    // sees the planner's own summary before any global write commits. The
    // thrown message keeps the historical "global write not approved" wording
    // so the tool's not-committed summary stays recognizable.
    ...(config.requireGlobalApproval
      ? {
        requireGlobalApproval: async (agent, signal, summary) => {
          try {
            await requireGlobalApproval(ctx, agent, signal, `Target: global store; planner plan: ${summary}`)
          } catch (error) {
            throw new Error(`global write not approved: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
        requireGlobalApprovalForTool: true,
      }
      : {}),
  })
  registerHarnessTool(ctx, coordinator, {
    defaultGlobal: config.defaultGlobal,
  })
  // The /refine command adapter is an optional host capability: it registers
  // only when the Cordis context provides a `commands` service, and the
  // registration disposes with the plugin context. A missing capability logs
  // exactly one warning and never prevents the rest of the plugin from loading.
  // The adapter's default reporter delivers the settled outcome as a
  // plugin-source session message plus a harness log line.
  const commands = ctx.get('commands') as CommandsCapability | undefined
  if (commands) {
    ctx.effect(() => {
      const registration = registerRefineCommand(commands, coordinator, { defaultGlobal: config.defaultGlobal })
      return () => registration.dispose()
    })
  } else {
    ctx.logger('harness').warn('commands capability not available; the /refine command is not registered')
  }
  if (config.wrapupEnabled) {
    registerHarnessWrapup(ctx, store)
  }
  const benchmark = config.benchmark ?? DEFAULT_BENCHMARK_CONFIG
  if (benchmark.enabled) {
    registerBenchmarkTool(ctx, store, {
      defaultRuns: benchmark.defaultRuns,
      maxRuns: benchmark.maxRuns,
      passThreshold: benchmark.passThreshold,
      regressionTolerance: benchmark.regressionTolerance,
      maxFailedCells: benchmark.maxFailedCells,
    })
  }
  registerHarnessProjection(ctx, store)
  const autoRefine = config.autoRefine ?? { enabled: true, turnInterval: DEFAULT_TURN_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS, compact: true }
  registerHarnessDriver(ctx, coordinator, store, {
    enabled: autoRefine.enabled,
    turnInterval: autoRefine.turnInterval,
    cooldownMs: autoRefine.cooldownMs,
    compact: autoRefine.compact,
    plannerMaxTokens: config.plannerMaxTokens,
    maxTrajectoryChars: config.maxTrajectoryChars,
    trajectorySignalRatio: config.trajectorySignalRatio ?? DEFAULT_TRAJECTORY_SIGNAL_RATIO,
    auditReviews: config.auditReviews,
  })
  if (config.logToFile) {
    attachFileLog(ctx, {
      file: join(store.home, PLUGIN_LOG_FILE_NAME),
      maxBytes: config.logMaxBytes,
    })
  }
}
