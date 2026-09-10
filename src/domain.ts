/**
 * Domain constants and typed extension surfaces of the continual harness
 * plugin: the legacy `harness/refinement` session event type (kept readable
 * for old logs, no longer written), the model-visible harness-state overview
 * source, and the scoped `harness/refined` event.
 * @module dsh-continual-harness
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { RefinementResult } from './types.ts'

/** Directory name of a harness store. */
export const HARNESS_DIR_NAME = 'harness'
/** State file name inside a harness store directory. */
export const HARNESS_STATE_FILE_NAME = 'harness_state.json'
/** Cross-session global refinement history file name. */
export const REFINEMENT_HISTORY_FILE_NAME = 'refinements.jsonl'
/**
 * Package identity stamped on plugin-authored message sources (and skill
 * provenance). One spelling across the package: message sources and skill
 * authors must not drift into a second `continual-harness` variant.
 */
export const PLUGIN_NAME = 'dsh-continual-harness'
/** Legacy session event type written by older plugin builds for a committed refinement result. */
export const HARNESS_REFINEMENT_EVENT = 'harness/refinement'
/**
 * Presentation form of an injected harness-state overview. The overview rides a
 * platform-classified `plugin` source: a plugin-defined source kind is legal in
 * memory but unclassified by the released v2->v3 Session migration, so one
 * logged occurrence makes the whole artifact unreadable.
 */
export const HARNESS_STATE_FORM = 'instructions'
/** Legacy source kind written by plugin builds before the classified-source switch. */
export const HARNESS_STATE_LEGACY_KIND = 'harness-state'
/** Monotonic schema version of the harness state file. */
export const HARNESS_SCHEMA_VERSION = 2
/** Prefix shared by the active injection telemetry log and its epoch-stamped archives. */
export const USAGE_ARCHIVE_PREFIX = 'usage.events.'
/** Append-only injection telemetry event log under the harness home. */
export const USAGE_EVENTS_FILE_NAME = `${USAGE_ARCHIVE_PREFIX}jsonl`
/** Kind names accepted by the harness layer. */
export const REFINEMENT_KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const
/** Kebab-case pattern dsh requires for skill names (and the safe path form). */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Benchmark store directory name under the harness home. */
export const BENCHMARK_DIR_NAME = 'benchmark'
/** Fixed-case store file name (cases and frozen state). */
export const BENCHMARK_CASES_FILE_NAME = 'cases.json'
/** Append-only benchmark run record file name. */
export const BENCHMARK_RUNS_FILE_NAME = 'runs.jsonl'
/** Read-only serialized reference/candidate snapshot directory name. */
export const BENCHMARK_SNAPSHOTS_DIR_NAME = 'snapshots'
/** Monotonic schema version of the benchmark cases file. */
export const BENCHMARK_CASES_SCHEMA_VERSION = 1

/**
 * Register a plugin-owned session event type with the persistence read path.
 * The harness core's generated KNOWN_SESSION_EVENT_TYPES only contains
 * in-repo vocabulary, and a reader meeting an unrecognized non-ignorable
 * type refuses the whole log (SessionFormatUnsupportedError). The runtime
 * Set is shared with dsh-session-persistence, so registering the type keeps
 * logs containing it readable — needed for legacy logs written without the
 * `ignorable` marker. The plugin no longer writes this type at all (an
 * append would make the whole log refuse a cold read), so this registration
 * exists purely for legacy log readability and can be dropped once those
 * logs age out.
 */
export function registerSessionEventType(type: string): void {
  (KNOWN_SESSION_EVENT_TYPES as Set<string>).add(type)
}

/**
 * Whether one logged message source is a harness-state overview: the current
 * plugin-source form, or the legacy kind still present on the surface of
 * sessions written by plugin builds up to 0.3.0.
 */
export function isHarnessStateSource(source: MessageSource): boolean {
  if ((source.kind as string) === HARNESS_STATE_LEGACY_KIND) return true
  return source.kind === 'plugin' && source.plugin === PLUGIN_NAME && source.form === HARNESS_STATE_FORM
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A continual harness refinement was committed to the session store.
     * @param result - the durable refinement result, including applied edits.
     */
    'harness/refinement': RefinementResult
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A continual harness refinement was committed to a session store.
     * @mode emit
     * @param agent - the agent whose store changed.
     * @param result - the committed refinement result.
     */
    'harness/refined'(this: import('@deepseek-ai/dsh-scope').Scoped<import('@deepseek-ai/dsh-agent').Agent>, payload: { agent: import('@deepseek-ai/dsh-agent').Agent; result: RefinementResult }): void
  }
}
