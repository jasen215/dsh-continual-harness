# Task 9 Report: Final Contract Review and Regression Verification

Plan: `docs/superpowers/plans/2026-08-24-refine-command-coordinator.md` (Task 9 + Global Constraints)
Specs: `docs/superpowers/specs/2026-08-23-01-refine-command-coordinator-design.md` and `docs/superpowers/specs/2026-08-23-02-post-apply-diagnostics-design.md` (both read from the main repo; the worktree docs tree contains only `plans/`)
Branch reviewed: commits `b99eed85..HEAD` (i.e. `21bdb8f3..af94a522` plus the Task 9 fix commit)
Worktree: `/Users/jasen/repo/my/dsh-continual-harness/.worktrees/refine-command-coordinator`

## 1. Step 1 — Placeholder and duplicate-logic scan

Command:

```bash
rg -n "TBD|TODO|implement later|Similar to Task|add appropriate|planRefinement|applyRefinement|rollbackRefinement|filter\(.*applied|filter\(.*!.*applied" src/coordinator.ts src/tool.ts src/driver.ts src/command.ts src/diagnostics.ts
```

Result (only the `planRefinement`/`applyRefinement`/`filter` alternatives matched):

- `src/coordinator.ts:2` — `import { planRefinement, scopeInstruction } from './planner.ts'`
- `src/coordinator.ts:278` — `planRefinement({...})` call (coordinator-owned)
- `src/coordinator.ts:257,328` — `store.applyRefinement(...)` calls (coordinator-owned commit path)
- `src/coordinator.ts:202` — `.filter(edit => edit.applied && edit.kind === 'skill')` (coordinator computes touched-skill ids for the diagnostics input — coordinator-owned)
- `src/driver.ts:290` — `.filter(edit => !edit.applied)` in `auditForExecution` (extracts per-edit rejected details for the durable gate audit, explicitly commented "never recomputed from `appliedCount`/`rejectedCount`")

Findings:

1. **No plan placeholders**: zero hits for `TBD`, `TODO`, `implement later`, `Similar to Task`, or `add appropriate` in any of the five files (nor anywhere else under `src/`).
2. **`planRefinement`/`applyRefinement` are coordinator-only**: every direct planner/apply call is inside `src/coordinator.ts`. Rollback is delegated to the existing `rollbackProposal` (`src/refine.ts`), also invoked only by the coordinator (`src/coordinator.ts:4,255`). The adapters (`src/tool.ts`, `src/driver.ts`, `src/command.ts`) never call the planner, the apply path, or `rollbackRefinement` directly.
3. **Adapters do not independently recompute domain counts**: `src/tool.ts:318-319` maps `execution.appliedCount`/`execution.rejectedCount` into the snake_case output; `src/command.ts:109-110` renders them into text. The driver's rejected-edit filter is audit-detail extraction from the refinement record, not a count recomputation. No adapter calls `counts(...)` or re-derives `appliedCount`/`rejectedCount` from edit arrays.

Step 1 verdict: **PASS** — no placeholders, single ownership of planner/apply/rollback in the coordinator, adapters map results only.

## 2. Step 2 — Spec coverage walk

Both specs were walked requirement-by-requirement against the test suite. Coverage is complete except one stable error code, which this task fixed (see §4).

### Spec 01 (coordinator design) — Phase 1 (§9.1) and Phase 2 (§9.2)

| Requirement | Evidence |
|---|---|
| Request union validation (`invalid-request`, no planner/Store calls) | `tests/coordinator.spec.ts`: `rejects automatic requests without automaticContext`, `rejects rollback requests with a non-string rollbackId` |
| Empty proposal → `not-committed` no-op, no Store call, no record | `tests/coordinator.spec.ts`: `returns an empty no-op without calling Store` |
| Invalid proposals (malformed shape, malformed edits) → `invalid-proposal` | `tests/coordinator.spec.ts`: `rejects malformed edits before calling Store`, `maps planner failures and malformed proposals` |
| All stable error codes | `invalid-request`, `planning-failed`, `invalid-proposal`, `approval-unavailable`, `approval-rejected`, `rollback-target-not-found`, `rollback-scope-mismatch`, `rollback-already-rolled-back`, `aborted`, `materialization-failed`, `diagnostics-failed` all asserted. **`commit-failed` had no assertion — fixed in this task.** |
| Approval unavailable / rejected | `tests/coordinator.spec.ts`: `requires and maps global approval without Store commits` (both `approval-unavailable` and `approval-rejected`); `tests/plugin.spec.ts`: `blocks a global write the user rejects`, `allows a global write the user approves` |
| Rollback target / scope / already-rolled-back, no planner/approval/Store | `tests/coordinator.spec.ts`: `rejects a missing rollback target without planner, approval, or Store calls`, `rejects scope mismatch and a second rollback` |
| Baseline conflict (real Store) | `tests/coordinator.spec.ts`: `uses the planner snapshot for real Store baseline conflict detection` |
| Store re-read at commit | Same baseline-conflict test proves the Store re-reads target state at commit time (mutation during planning is rejected with `entry changed during refinement planning`); the coordinator's planner baseline is captured once (`captures planner context once and passes baseline to Store`) |
| Mutex serialization (same-scope commit, planner outside lock) | `tests/coordinator.spec.ts`: `serializes same-scope commits while allowing concurrent planner work outside the lock`, `delayed-store fixture records commits without overlap` |
| Partial edit counts → `committed-with-rejected-edits`, applied/rejected counts | `tests/coordinator.spec.ts`: `maps partial Store application to committed-with-rejected-edits` |
| Materialization failure preserves the commit | `tests/coordinator.spec.ts`: `retains committed status when materialization fails` |
| Abort before/after commit | `tests/coordinator.spec.ts`: `aborts before planning and before commit`, `aborts after approval before Store commit`, `aborts before diagnostics starts with the commit retained` |
| Shared tool/automatic coordinator usage | `tests/tool.spec.ts`: `maps tool arguments to one coordinator request …`, `maps a rollback_id to one rollback request …`; `tests/driver.spec.ts`: `reviews once, then delegates an approved automatic request`; `tests/plugin.spec.ts`: end-to-end `records a gate verdict …` |
| Adapter does not duplicate domain logic / recount | `tests/tool.spec.ts`: `uses coordinator-provided counts without recounting adapter-local edit arrays`; `tests/driver.spec.ts`: `audits rejected edits from the coordinator refinement record, not the counts` |
| Command capability optional: missing → one warning, plugin still loads; present → register + dispose | `tests/plugin.spec.ts`: `mounts without a commands capability, keeps the normal tools, and warns once`, `registers the refine command through a commands capability and unregisters it on unload` |
| Command parsing (scope/focus/rollback/unknown options, parse errors never call coordinator) | `tests/command.spec.ts`: `parses a bare remainder as a plan with the default scope`, `parses rollback with the scope flag in either position`, `returns a usage error without calling the coordinator on a parse failure` (and the missing-agent case) |
| Command output (two-state status mapping, refinement id/summary, applied/rejected) | `tests/command.spec.ts`: `maps domain three-state status into command text two-state status`, `keeps the refinement id and summary for a committed result`, `maps only not-committed to status not-committed with refinement none` |
| Diagnostics post-apply hook: once per committed execution, touched-skill ids, failure keeps commit | `tests/coordinator.spec.ts`: `runs the injected runner once after a committed plan with touched skills`, `does not run diagnostics for an empty proposal, rejected approval, failed commit, or rollback validation failure`, `retains the committed result when the runner throws`, `runs diagnostics after a committed rollback` |

### Spec 02 (post-apply diagnostics)

| Requirement | Evidence |
|---|---|
| Touched-skill filtering only | `tests/diagnostics.spec.ts`: `diagnoses only touched skills and embeds materialization`, `reports issues only for touched skills using the existing bundle validation helpers`, `returns no issues for a valid touched skill`; coordinator supplies `touchedSkillIds` from applied skill edits |
| Provider isolation (one provider fails, other completes) | `tests/diagnostics.spec.ts`: `keeps one provider result when the other provider fails` |
| Disabled diagnostics / explicit `disabled` status | `tests/diagnostics.spec.ts`: `returns disabled rather than empty-success when no provider is enabled`, `runs only structural when security is disabled`; `tests/plugin.spec.ts`: `omits diagnostics entirely when diagnosticsEnabled is false` |
| Materialization report embedded | `tests/diagnostics.spec.ts`: `diagnoses only touched skills and embeds materialization`, `carries a failed materialization through unchanged without failing the report` |
| Diagnostics failure preserves the commit | `tests/coordinator.spec.ts`: `retains the committed result when the runner throws`; `tests/driver.spec.ts`: `keeps a committed refinement approved when diagnostics fail` |
| Abort → `partial`, budget-exceeded tagging, empty touched set never scans | `tests/diagnostics.spec.ts`: `marks the report partial when the signal is aborted`, `records a tagged budget error with its own code`, `completes with empty findings when no skill is touched and never scans` |
| Provider purity (no file writes, no store re-read) | `tests/diagnostics.spec.ts`: `never writes files or re-reads store state (pure provider)` |
| Tool/command/automatic output semantics consistent | `tests/tool.spec.ts`: `includes coordinator diagnostics in the tool output without changing committed counts`; `tests/command.spec.ts`: diagnostics lines (`appends a completed diagnostics line …`, `appends a disabled diagnostics line …`, `renders one diagnostics error line per provider error`, `omits the diagnostics line …`); `tests/plugin.spec.ts`: `attaches a completed diagnostics report to tool output by default` |

Step 2 verdict: **PASS with one fix** — the `commit-failed` stable error code lacked an explicit assertion; added in this task.

## 3. Step 3 — Final verification commands

| Command | Result |
|---|---|
| `pnpm test` | 433 passed (433) — exit 0 |
| `pnpm typecheck` | exit 0 (no diagnostics) |
| `pnpm build` | exit 0 |
| `git diff --check` | clean (no whitespace errors) |

Note: the pnpm "sandbox initialization failed: Operation not permitted" stderr lines are the known harmless fallback warning; all judgments are by exit code, which is 0 everywhere.

## 4. Step 4 — Verification fixes (narrowly scoped)

Two concrete findings from Steps 1-2 were fixed in `src/coordinator.ts` and `tests/coordinator.spec.ts`:

1. **Missing `commit-failed` stable-error-code assertion (spec 01 §6.1 failure matrix "commit 整体异常").** The coordinator already mapped a throwing Store commit to `{ commitStatus: 'not-committed', failedAt: 'commit', error.code: 'commit-failed' }` on both the plan and rollback paths, but no test asserted it. Added `tests/coordinator.spec.ts`: `maps a throwing Store commit to the stable commit-failed code without a success result`, covering both the plan commit and the rollback commit paths and asserting no refinement result is produced.
2. **Dead `commitState` read inside the commit mutex (`void commitState`, leftover from Task 3 fix dc96b445).** The coordinator captured its planner baseline once outside the lock; per spec §5.1/§6.3 the Store re-reads the target state inside `applyRefinement` for commit-time conflict detection. The discarded read misrepresented the ownership of the re-read, so it was removed and replaced with a comment documenting the Store's re-read.

Both changes are behavior-preserving except the intended new test assertions. Full suite re-run after the fix: 433/433 exit 0; typecheck exit 0; build exit 0; `git diff --check` clean.

## 5. Task 4/5 review MINORs — ledger record

The five MINORs from the Task 4 and Task 5 reviews were recorded in `progress.md` (see the "Task 4/5 Review MINORs" section): (a) empty-result summary UX decision is intentional (`'no refinement produced'` fallback in `summarizeExecution`); (b) `ToolOptions` trim is an accepted breaking change; (c) the approval-message wrapper keeps historical wording while the canonical `approval-rejected` code is preserved; (d) §6.1 validation/apply split: `validateEdit`-class failures reject the whole proposal as `not-committed` (no Store call), store-class rejections still yield `committed-with-rejected-edits`; (e) a release-note item for 0.2.0 (coordinator migration, optional `/refine` command, diagnostics flags) is pending — no changelog exists in the worktree.

## 6. Conclusion

- Placeholder/duplicate-logic scan: clean; coordinator owns planner/apply/rollback; adapters map results only.
- Both specs fully traceable to tests; the one uncovered stable error code (`commit-failed`) now has explicit assertions for both commit paths.
- All verification commands pass (test 433/433, typecheck, build, diff --check).
- Task 9 complete.
