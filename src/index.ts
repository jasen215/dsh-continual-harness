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
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PLANNER_MAX_TOKENS } from './complete.ts'
import { DEFAULT_COOLDOWN_MS, DEFAULT_TURN_INTERVAL } from './driver.ts'
import { DEFAULT_TRAJECTORY_MAX_CHARS } from './store.ts'
import { registerHarnessDriver } from './driver.ts'
import { registerHarnessProjection } from './projection.ts'
import { HarnessStore } from './store.ts'
import { registerHarnessTool } from './tool.ts'
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
  /** Automatic refinement gate settings. */
  autoRefine?: AutoRefineConfig
  /** Require explicit human approval before a global refinement commits. */
  requireGlobalApproval: boolean
  /** Audit automatic review verdicts into the session log. */
  auditReviews: boolean
  /** Persist harness logs to a file. */
  logToFile: boolean
  /** Cap on the harness log file size in bytes. */
  logMaxBytes: number
  /** Per-commit entry growth fraction cap; 0 disables the check. */
  maxEntryGrowth: number
  /** Kinds the automatic path may not modify. */
  protectedKinds: RefinementKind[]
}

/** Schemastery configuration for the continual harness plugin. */
export const Config: z<Config> = z.object({
  harnessRoot: z.string(),
  skillsDir: z.string(),
  defaultGlobal: z.boolean().required(),
  maxTrajectoryChars: z.number().step(1).min(1).default(DEFAULT_TRAJECTORY_MAX_CHARS),
  plannerMaxTokens: z.number().step(1).min(1).default(DEFAULT_PLANNER_MAX_TOKENS),
  autoRefine: z.object({
    enabled: z.boolean().default(true),
    turnInterval: z.number().step(1).min(1).default(DEFAULT_TURN_INTERVAL),
    cooldownMs: z.number().step(1).min(1).default(DEFAULT_COOLDOWN_MS),
    compact: z.boolean().default(true),
  }).default({ enabled: true, turnInterval: DEFAULT_TURN_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS, compact: true }),
  requireGlobalApproval: z.boolean().default(false),
  auditReviews: z.boolean().default(true),
  logToFile: z.boolean().default(true),
  logMaxBytes: z.number().step(1).min(1).default(5 * 1024 * 1024),
  maxEntryGrowth: z.number().min(0).default(0.5),
  protectedKinds: z.array(z.union(['prompt', 'memory', 'skill', 'subagent'])).default(['skill']),
})

/**
 * Mount the continual harness: store, tool, projection, and driver. All
 * contributions register through effect-based APIs and dispose with the
 * context.
 * @param ctx - Cordis context carrying the tools and agents services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new HarnessStore(ctx, {
    ...(config.harnessRoot === undefined ? {} : { harnessRoot: config.harnessRoot }),
    ...(config.skillsDir === undefined ? {} : { skillsDir: config.skillsDir }),
    maxEntryGrowth: config.maxEntryGrowth,
    protectedKinds: config.protectedKinds,
  })
  registerHarnessTool(ctx, store, {
    defaultGlobal: config.defaultGlobal,
    maxTrajectoryChars: config.maxTrajectoryChars,
    plannerMaxTokens: config.plannerMaxTokens,
  })
  registerHarnessProjection(ctx, store)
  const autoRefine = config.autoRefine ?? { enabled: true, turnInterval: DEFAULT_TURN_INTERVAL, cooldownMs: DEFAULT_COOLDOWN_MS, compact: true }
  registerHarnessDriver(ctx, store, {
    enabled: autoRefine.enabled,
    turnInterval: autoRefine.turnInterval,
    cooldownMs: autoRefine.cooldownMs,
    compact: autoRefine.compact,
    plannerMaxTokens: config.plannerMaxTokens,
    maxTrajectoryChars: config.maxTrajectoryChars,
  })
}
