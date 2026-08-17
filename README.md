# dsh-continual-harness

English | [中文](docs/readme/README.zh.md)

A **continual self-refinement plugin** for DeepSeek Harness: one plugin gives the agent a closed loop of *persistent memory + periodic review-and-refine + cross-session shared knowledge + automatic rollback on failure* (plan → validate → apply → rollback), implemented through dsh's plugin mechanisms (session events, agent-scoped events, pre-step waterfall, tools service).

The design is inspired by the open-source [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) from Prime Intellect, a self-improving coding harness.

## One plugin is enough

There is no need to split into multiple packages: this plugin is a single npm package (`dsh-continual-harness`) that takes effect through the following extension points once mounted:

| Capability | Mechanism |
| --- | --- |
| State projection (inject harness context each step) | `agent/pre-step` waterfall listener; incremental injection when the content digest changes |
| Review and automatic refinement | `session/event` listener on turn interval / compaction end; runs LLM review → plan → apply automatically |
| Manual refinement tool | Registers the `harness_refine` tool (directly callable by the LLM, supports rollback) |
| In-session review trajectory | Rebuilt from session logs (tail-biased truncation) |
| Invariant guard | `harness/refinement` event validation + batched failure reporting |

## Architecture

```
src/
  domain.ts      event declaration merging (SessionEventMap / MessageSourceMap / cordis Events)
  types.ts       HarnessState / RefinementProposal / RefinementResult and other types
  storage.ts     disk read/write of state and history (atomic writes, corruption degradation, local/global merge, jsonl history)
  refine.ts      validation, application, rollback (baseline conflict detection, version increments, content-shrink guard)
  render.ts      model-facing overview / summary / history rendering
  planner.ts     LLM planning prompts and JSON parsing (plan / auto-refine review prompts)
  store.ts       HarnessStore: combined storage + event publishing (session events + agent-scoped events)
  complete.ts    completeViaAgent: completion through ctx.get('llm')
  tool.ts        harness_refine tool
  projection.ts  pre-step projection (digest dedup, <harness_state> injection)
  driver.ts      automatic refinement driver (turn-interval gate / compaction gate / cooldown / re-entry guard)
  invariant.ts   runtime invariant plugin
  index.ts       plugin entry and Config
tests/           7 specs, 46 cases (storage / refine / planner / store / driver / invariant / plugin integration)
```

### Data layout

```
<harnessRoot>/                      harness/ under the default dsh data dir (overridable via Config.harnessRoot)
  harness_state.json                cross-session global state
  refinements.jsonl                 global refinement history (append-only)
  sessions/<sessionKey>/harness/
    harness_state.json              session-local state (shadows same-id global entries)
    refinements.jsonl               session refinement history
```

- Entries are stored in four kinds — `prompt / memory / skill / subagent` — each with a `version` (incremented on every update).
- Merged view: local entries win; a shadowed global entry remains visible under the `local:<id>` prefix.
- Baseline validation on apply: an edit is rejected if the entry changed concurrently during planning (`entry changed during refinement planning`).
- `base_system_prompt` is a protected id; any edit to it is rejected.

### Experience Solidification Protocol (ESP)

The Experience Solidification Protocol (ESP) is the **protocol surface** of this capability set, decoupled from this package's implementation:

| Protocol element | Carrier | Description |
| --- | --- | --- |
| Experience state schema | `harness_state.json` (`schemaVersion: 1`) | Four kinds of entries — `prompt / memory / skill / subagent` — each with `id / kind / version / content / updatedAt` |
| Experience history | `refinements.jsonl` (append-only) | One `RefinementResult` record per apply/rollback; rollback by id |
| Refinement event | session event `harness/refinement` | Written to the session log on apply/rollback (model-visible ⟺ logged) |
| Refinement notification | agent event `harness/refined` | Payload `{agent, result}`; subscribable by invariant and other plugins |
| Experience injection | message source `harness-state` (carries `digest`) | Pre-injected into the model context; deduplicated by digest change |

Any dsh plugin can read and write experience through this protocol (write state files, append history, publish events, inject messages); this package is the protocol's **reference implementation and primary consumer** (planning / refinement / projection / automatic gate). If the experience read/write layer is ever extracted into a standalone reusable protocol package, `dsh-esp` can be split out along these lines, with the harness degrading to a consumer of ESP.

### Events and message sources

- Session event `harness/refinement` (RefinementResult) — written to the session log on every apply/rollback (model-visible ⟺ logged).
- Agent-scoped event `harness/refined` (payload `{agent, result}`) — subscribable by invariant and other plugins.
- Pre-injected message `source.kind === 'harness-state'`, carrying a `digest` for deduplication.

## Mounting (dsh profile)

Overlay it onto a dsh profile as `cordis.patch.yml` (e.g. `~/.dsh/profiles/<name>/cordis.patch.yml`); see the [cordis.patch.yml](cordis.patch.yml) example in this repo. A patch layer must be a **top-level YAML array** (`insert` rows append plugin entries; id-targeted rows override an existing row):

```yaml
- insert:
    - id: continual-harness
      name: dsh-continual-harness
      config:
        defaultGlobal: true
```

Install:

```sh
pnpm add dsh-continual-harness        # or link: to this repo's source (see below)
pnpm dsh --profile <name> "…"
```

Prerequisites: the `tools`, `agents`, `session`, `llm`, `systemPrompt` capability plugins must load before this plugin (its `inject` declaration enforces that; mounting is deferred until they load).

## Config

| Field | Default | Description |
| --- | --- | --- |
| `harnessRoot` | dsh data dir `harness/` | State root directory (temporary dir in tests) |
| `defaultGlobal` | required | Target scope when the tool call omits `global` |
| `maxTrajectoryChars` | 80000 | Max characters of the review trajectory (tail-biased truncation) |
| `plannerMaxTokens` | 32000 | Max tokens for the planner LLM call |
| `autoRefine` | `{turnInterval: 25, compact: true, cooldownMs: 1200000}` | Auto-refine: turn-interval gate, compaction-end gate, cooldown, disable switch |

## Development (pre-release status)

The published `@deepseek-ai/dsh-*` package versions are mutually inconsistent (e.g. `dsh-agent@0.1.0-rc.6` declares peer `dsh-invariants@^0.1.0-rc.6`, but only `0.0.1-rc.1` is published), so they cannot be installed against each other. During development:

- `devDependencies` in `package.json` point at the monorepo source via `link:../deepseek-harness/packages/…`;
- `peerDependencies` declare semver ranges for consumers after a real release;
- `tsconfig.json` (typecheck) and `tsconfig.src.json` (vitest) are two facades over the same paths: the former points at the monorepo's built `lib/types/*.d.ts`, the latter at `src`; vitest runs the whole dependency graph on the source plane through Vite's native `resolve.alias` (all 160 mappings). The monorepo checkout root defaults to the sibling `../deepseek-harness`; override it with the `DEEPSEEK_HARNESS_ROOT` environment variable for other layouts or CI;
- Run: `pnpm run typecheck`, `pnpm test`, `pnpm run build` (tsc emits `lib/types/*.js + *.d.ts`; the `"."` and `"./invariant"` exports point at the artifacts). Runtime still requires consistently released dsh packages, as above.

## Known Limitations and Deferred Work

- No end-to-end tests with a real LLM: `completeViaAgent` depends on the loaded `llm` capability and provider/model configuration; tests cover the planning/review paths with a stub `Complete`. Real e2e requires `DEEPSEEK_API_KEY`.
- `compaction/end` is not part of the plugin's type union; the driver triggers it via string comparison after type narrowing, and the gate is silently skipped when the compaction capability is not loaded.
- Projection dedup is an in-process `WeakMap<Agent, digest>`: the first step after a session restart re-injects (stateless and idempotent, but one extra injection).
- Concurrent writes are last-writer-wins: multiple processes refining the same directory concurrently may overwrite each other; baseline conflict detection during planning can only catch read-after-write races, not serialize them.
- `skill` entries are currently text records of "description + arguments" without executable code; making them callable skills requires wiring into dsh's skill registration mechanism later.
- A failed automatic refinement degrades silently (only logged) and never interrupts the session.
