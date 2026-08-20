# dsh-continual-harness

English | [中文](docs/readme/README.zh.md)

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/dsh-continual-harness"><img src="https://img.shields.io/npm/v/dsh-continual-harness?cacheSeconds=86400" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-22+-339933.svg" alt="Node Version">
  <img src="https://img.shields.io/badge/typescript-6.0+-3178C6.svg" alt="TypeScript">
  <a href="https://github.com/jasen215/dsh-continual-harness/actions/workflows/ci.yml"><img src="https://github.com/jasen215/dsh-continual-harness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dsh-continual-harness"><img src="https://img.shields.io/npm/dm/dsh-continual-harness?cacheSeconds=86400" alt="npm downloads"></a>
</p>

A **continual self-refinement plugin** for DeepSeek Harness: one plugin gives the agent a closed loop of *persistent memory + periodic review-and-refine + cross-session shared knowledge + automatic rollback on failure* (plan → validate → apply → rollback), implemented through dsh's plugin mechanisms (session events, agent-scoped events, pre-step waterfall, tools service).

The design is inspired by the open-source [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) from Prime Intellect, a self-improving coding harness.

## One plugin is enough

There is no need to split into multiple packages: this plugin is a single npm package (`dsh-continual-harness`) that takes effect through the following extension points once mounted:

| Capability | Mechanism |
| --- | --- |
| State projection (inject harness context each step) | `agent/pre-step` waterfall listener; incremental injection when the content digest changes |
| Review and automatic refinement | `session/event` listener on turn interval / compaction end; runs LLM review → plan → apply automatically |
| Manual refinement tool | Registers the `harness_refine` tool (directly callable by the LLM, supports rollback) |
| Memory lifecycle | Manual archive/unarchive/pin through refinement metadata; archived entries are hidden from injection and skill materialization |
| Ranked injection | Queries the latest effective direct-user message (up to 400 chars), ranks title matches above content matches, then applies freshness/id tie-breaks and a per-kind cap |
| Session wrap-up | Optional `harness_wrapup` tool gives mechanical keep/promote/archive advice; promotion is copy-only and conflicts return a deterministic error |
| In-session review trajectory | Rebuilt from session logs (tail-biased truncation) |
| Invariant guard | `harness/refinement` event validation + batched failure reporting |
| Explicit A/B benchmark | Single `harness_benchmark` action tool: fixed frozen cases, pre-refinement reference snapshots, and same-round reference/candidate A/B runs with code-owned decisions |

## Architecture

```
src/
  domain.ts      event declaration merging (SessionEventMap / MessageSourceMap / cordis Events)
  types.ts       HarnessState / RefinementProposal / RefinementResult and other types
  storage.ts     disk read/write of state and history (atomic writes, corruption degradation, local/global merge, jsonl history)
  refine.ts      validation, application, rollback (baseline conflict detection, version increments, growth limit)
  skills.ts      SKILL.md rendering + file reconciliation (generated skills are real dsh skills)
  render.ts      model-facing overview / summary / history rendering (ranked injection)
  usage.ts       injection telemetry keys and in-memory usage aggregation
  wrapup.ts      deterministic session wrap-up suggestions (keep/promote/archive)
  planner.ts     LLM planning prompts and JSON parsing (plan / auto-refine review prompts)
  store.ts       HarnessStore: combined storage + event publishing (session events + agent-scoped events)
  complete.ts    completeViaAgent: completion through ctx.get('llm')
  benchmark.ts   benchmark cases/snapshots + atomic benchmark store persistence
  evaluate.ts    isolated per-cell executor/reviewer evaluation (evidence + score)
  score.ts       code-owned aggregation and ACCEPTED/REJECTED decisions
  tool.ts        harness_refine / harness_wrapup / harness_benchmark tools
  projection.ts  pre-step projection (digest dedup, <harness_state> injection)
  driver.ts      automatic refinement driver (turn-interval gate / compaction gate / cooldown / re-entry guard)
  invariant.ts   runtime invariant plugin
  index.ts       plugin entry and Config
tests/           23 test files, 287 cases (storage / store / refine / rules / planner / driver / approval / audit / logfile / skills / invariant / plugin integration / rank / projection / archive / usage / wrapup / benchmark / evaluate / score / isolation / tool / benchmark integration)
```

### Data layout

```
<harnessRoot>/                      shared ESP experience root; defaults to ~/.dsh/harness/
  harness_state.json                cross-session global state (ESP)
  refinements.jsonl                 global refinement history (append-only, ESP)
  reviews.jsonl                     cross-batch gate/audit history (ESP extension)
  continual-harness.log             continual-harness implementation log (JSONL, 0600)
  continual-harness.log.1           rotated continual-harness log
  usage.events.jsonl                append-only injection telemetry (lazily loaded into memory on first access)
  benchmark/                        explicit benchmark store (validation layer)
    cases.json                      fixed benchmark cases (draft/frozen + frozen material hashes)
    snapshots/<snapshotId>.json     captured reference snapshots (read-only merged harness state)
    runs.jsonl                      append-only A/B run records (cells + evidence + code-owned decision)
  sessions/<sessionKey>/
    harness_state.json              session-local state (shadows same-id global entries)
    refinements.jsonl               session refinement history
```

- Entries are stored in four kinds — `prompt / memory / skill / subagent` — each with a `version` (incremented on every update).
- Merged view: local entries win; a shadowed global entry remains visible under the `local:<id>` prefix.
- Baseline validation on apply: an edit is rejected if the entry changed concurrently during planning (`entry changed during refinement planning`).
- `base_system_prompt` is a protected id; any edit to it is rejected.
- **No auto-migration from the legacy layout:** installs that predate the flat layout (state under `~/.dsh/harness/harness/` and `sessions/<id>/harness/`) are **not auto-migrated** — move the state files into the flat layout above (or re-seed) to keep using the harness. New installs are unaffected.
- **Skills are real dsh skills.** Every applied skill edit materializes the effective merged entry as a `<name>/SKILL.md` bundle (YAML `name` + `description` frontmatter, kebab-case id) under `Config.skillsDir` (default `$DSH_HOME/skills`), where dsh's filesystem skill provider (`dsh-skill-filesystem`) discovers it live and `dsh-tool-skill` exposes it to the model. Deletes remove the bundle; rollbacks restore it. Only ids touched by a commit are written or removed, so user-owned skills in the same directory are never touched. Each bundle stamps a `metadata` provenance block (`author: dsh-continual-harness`, `source: esp`) so generated skills are distinguishable from hand-written ones.

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

Install into a profile in one line (published to npm):

```sh
dsh plugin --profile <name> add dsh-continual-harness
```

The package declares `dsh.bundle`, so `dsh plugin` installs it as a profile
layer: the dependency is added and its `cordis.patch.yml` is applied as that
bundle's patch. The plugin's runtime imports of `@deepseek-ai/*` resolve
through the profile's flat fallback `node_modules` directory. Update with
`dsh plugin --profile <name> update dsh-continual-harness@latest`.

Manual overlay (before publish, or to pin a local checkout): apply
[cordis.patch.yml](cordis.patch.yml) onto the profile, e.g.
`~/.dsh/profiles/<name>/cordis.patch.yml`; a patch layer must be a
**top-level YAML array** (`insert` rows append plugin entries; id-targeted rows override an existing row):

```yaml
- insert:
    - id: continual-harness
      name: dsh-continual-harness
      config:
        defaultGlobal: true
```

Prerequisites: the `tools`, `agents`, `session`, `llm`, `systemPrompt` capability plugins must load before this plugin (its `inject` declaration enforces that; mounting is deferred until they load).

## Config

| Field | Default | Description |
| --- | --- | --- |
| `harnessRoot` | dsh data dir `harness/` | State root directory (temporary dir in tests) |
| `skillsDir` | `$DSH_HOME/skills` | Directory where skill entries materialize as dsh SKILL.md bundles (dsh's user skill root) |
| `defaultGlobal` | required | Target scope when the tool call omits `global` |
| `maxTrajectoryChars` | 80000 | Max characters of the review trajectory (tail-biased truncation) |
| `plannerMaxTokens` | 32000 | Max tokens for the planner LLM call |
| `autoRefine` | `{turnInterval: 25, compact: true, cooldownMs: 1200000}` | Auto-refine: turn-interval gate, compaction-end gate, cooldown, disable switch |
| `requireGlobalApproval` | `false` | Require explicit human approval before a global write commits (conservative mode) |
| `maxInjectedEntriesPerKind` | `6` | Positive-integer cap (step 1, minimum 1) for ranked injected entries per kind |
| `wrapupEnabled` | `true` | Register the optional `harness_wrapup` session wrap-up tool |
| `auditReviews` | `true` | Append every gate verdict to `reviews.jsonl` under the harness root |
| `logToFile` | `true` | Persist harness logs to `continual-harness.log` (JSONL, `0600`, rotated) |
| `logMaxBytes` | `5242880` (5 MB) | Rotation cap for the harness log file |
| `maxEntryGrowth` | `0.5` | Per-commit entry growth fraction cap; `0` disables the check |
| `protectedKinds` | `['skill']` | Kinds the automatic path may not modify (reserved; per-entry `protection` is the enforced guard) |
| `benchmark` | `{enabled: true, defaultRuns: 1, maxRuns: 3, passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0}` | Explicit `harness_benchmark` tool: iterations per case per side, run cap, report-only pass line, non-regression tolerance, max failed candidate cells |

## Governance

Every write path — the `harness_refine` tool and the automatic gate — funnels through a rule layer with three tiers, plus a reversibility backstop:

1. **Impact minimization** — every edit is validated against a fixed contract before any write. `create` may omit a `reason`; `update`/`delete` must carry a one-line `reason` (a missing one rejects the edit with `edit "<id>" rejected: missing reason`). Optional `blastRadius` (`general | project | session`) defaults to `general`. `base_system_prompt` is immutable. `maxEntryGrowth` (default `0.5`) caps how much an update may grow an entry in one commit (`entry growth exceeds the maxEntryGrowth cap`; `0` disables the check).
2. **Legality hard rejects** — Protected entries (those carrying `protection`) are immutable on the automatic path (`protected entries are mutable only in explicit user sessions`); during a `local` refinement the global store is read-only, so touching an unshadowed global entry requires creating a local shadow first (`global entries are read-only during a local refinement; create a local shadow first`).
3. **Necessity soft gate** — before any automatic refinement the review gate decides whether persisting now is worthwhile; a declined review never reaches the store, and every verdict is audited.

**Reversibility** is the backstop: every committed refinement rolls back by id, and rollbacks carry a system-generated `rollback:<id>` reason.

Global writes are **zero-approval by default**: the tool commits a global refinement without consulting any approval service. Set `requireGlobalApproval: true` for the conservative mode, in which a global write first asks the user through the `dsh-user-questions` service and is skipped on rejection (`global write not approved: <error>`).

The gate and the plugin keep two artifacts under the harness root: every gate verdict is appended to `reviews.jsonl` (outcomes `approved | declined | assessed | failed`), and harness log lines from the `harness` / `continual-harness` loggers are appended to `continual-harness.log` (JSONL, `0600`, rotated to `.1` once `logMaxBytes` is exceeded).

Watch the plugin log live with:

```sh
tail -f ~/.dsh/harness/continual-harness.log
```

(A dedicated tool entry for governance is deferred.)

## Benchmark

The validation layer is **explicit and single-entry**: one `harness_benchmark` action tool drives the whole workflow, and it never auto-triggers a refinement — nothing in the benchmark path starts a `harness_refine` or the automatic gate, and a `REJECTED` decision never auto-rolls back. The benchmark store lives under `<harnessRoot>/benchmark/` (`cases.json`, `snapshots/`, `runs.jsonl`).

The minimal sequence:

```
new → add-case → freeze → capture-reference → apply refinement → run → status
```

1. `new` — initialize the benchmark store.
2. `add-case` — add a draft case (`case_id`, `title`, `statement`, `rubric`, optional `capability`).
3. `freeze` — freeze the draft; frozen case material is immutable and hashed.
4. `capture-reference` — persist a reference snapshot of the merged harness state **BEFORE** applying the refinement you want to validate (`snapshot_id`). Reference capture must precede the refinement: the candidate is later derived as *this captured reference plus exactly that refinement*, so capturing after the change would make the delta unprovable.
5. Apply the refinement (`harness_refine`, or any path that lands a refinement in the store history) — the run needs its real id.
6. `run` — evaluate the named refinement A/B against the reference snapshot (`reference_snapshot_id` + `refinement_id`). The candidate must be the **single specified delta**: the run derives it from the captured reference plus the refinement's recorded applied edits and proves it in code before any evaluation; a drifted or multi-change candidate is refused with a `benchmark:run:candidate-delta` error. Both sides run the same frozen cases in stored order with the same `runs`/`provider`/`model`.
7. `status` — list cases, snapshots, and recent runs.

A `run` returns the code-owned decision (`src/score.ts`), not a model verdict:

```json
{
  "action": "run",
  "ok": true,
  "run_id": "run-...",
  "refinement_id": "refine-1",
  "status": "ACCEPTED",
  "reference_overall": 70,
  "candidate_overall": 90,
  "regression_cases": [],
  "failed_cells": 0,
  "feedback": ["reference ok", "candidate better"],
  "auto_rollback": false,
  "runs": 1,
  "cells": 2
}
```

- Scores are on a `0..100` scale (`score` in each cell). A failed cell carries `score: null` — failure is never counted as `0` — and is excluded from the overall means.
- `passThreshold` (default `60`) is **report-only** (§4.5): it never gates acceptance. A run is `ACCEPTED` only when neither side lacks usable cells, candidate failed cells stay within `maxFailedCells`, and no overall or per-case regression exceeds `regressionTolerance` (default `0`).
- Every run appends its full record (cells with executor evidence + the decision) to `benchmark/runs.jsonl`. Evaluation reads only the captured snapshots and writes only that record — it never touches `reviews.jsonl`, the harness state, injection telemetry, or skill files.
- `REJECTED` is reported and recorded only; `auto_rollback` is always `false` in MVP and no rollback is ever invoked.

## Development

The plugin is self-contained: `devDependencies` pin the published
`@deepseek-ai/*` packages (rc versions), so `pnpm install`, `pnpm run
typecheck`, `pnpm test` (287 cases), and `pnpm run build` (tsc emits
`lib/types/*.js + *.d.ts`; the `"."` and `"./invariant"` exports point at the
artifacts) all work in a clean checkout — CI and the OIDC release workflow
run the same steps. `peerDependencies` declare the semver ranges consumers
(host dsh installations) must satisfy.

## Known Limitations and Deferred Work

- No end-to-end tests with a real LLM: `completeViaAgent` depends on the loaded `llm` capability and provider/model configuration; tests cover the planning/review paths with a stub `Complete`. Real e2e requires `DEEPSEEK_API_KEY`.
- `compaction/end` is not part of the plugin's type union; the driver triggers it via string comparison after type narrowing, and the gate is silently skipped when the compaction capability is not loaded.
- Projection dedup is an in-process `WeakMap<Agent, digest>`: the first step after a session restart re-injects (stateless and idempotent, but one extra injection).
- Concurrent writes are last-writer-wins: multiple processes refining the same directory concurrently may overwrite each other; baseline conflict detection during planning can only catch read-after-write races, not serialize them.
- A failed automatic refinement degrades silently (only logged) and never interrupts the session.
- A content-shrink guard (rejecting updates that shrink an entry too far in one commit) is a planned follow-up and is not yet implemented; today only `maxEntryGrowth` caps how much an update may grow an entry.
