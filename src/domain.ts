/**
 * Domain constants and typed extension surfaces of the continual harness
 * plugin: the durable `harness/refinement` session event, the model-visible
 * `harness-state` message source, and the scoped `harness/refined` event.
 * @module dsh-continual-harness
 */

import type { RefinementResult } from './types.ts'

/** Directory name of a harness store. */
export const HARNESS_DIR_NAME = 'harness'
/** State file name inside a harness store directory. */
export const HARNESS_STATE_FILE_NAME = 'harness_state.json'
/** Cross-session global refinement history file name. */
export const REFINEMENT_HISTORY_FILE_NAME = 'refinements.jsonl'
/** Session event type carrying a committed refinement result. */
export const HARNESS_REFINEMENT_EVENT = 'harness/refinement'
/** Message source kind of injected harness-state overviews. */
export const HARNESS_STATE_SOURCE = 'harness-state'
/** Monotonic schema version of the harness state file. */
export const HARNESS_SCHEMA_VERSION = 2
/** Append-only injection telemetry event log under the harness home. */
export const USAGE_EVENTS_FILE_NAME = 'usage.events.jsonl'
/** Kind names accepted by the harness layer. */
export const REFINEMENT_KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const
/** Benchmark store directory name under the harness home. */
export const BENCHMARK_DIR_NAME = 'benchmark'
/** Fixed-case store file name (cases and frozen state). */
export const BENCHMARK_CASES_FILE_NAME = 'cases.json'
/** Append-only benchmark run record file name. */
export const BENCHMARK_RUNS_FILE_NAME = 'runs.jsonl'
/** Read-only serialized reference/candidate snapshot directory name. */
export const BENCHMARK_SNAPSHOTS_DIR_NAME = 'snapshots'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A continual harness refinement was committed to the session store.
     * @param result - the durable refinement result, including applied edits.
     */
    'harness/refinement': RefinementResult
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Model-visible harness-state overview injected before a step.
     * @param digest - content hash of the injected overview.
     */
    'harness-state': { kind: 'harness-state'; digest: string }
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
