# Task 3 Report: Manual archive/unarchive/pin and skill filtering

## What I implemented

- Updated `validateEdit` so non-delete edits without `content` are accepted when they carry `archive` or `pin`.
- Added archive/unarchive transitions in `applyRefinementProposal`:
  - active → archived and archived → active;
  - version and timestamp bump;
  - duplicate archive rejects with `already archived`;
  - duplicate unarchive rejects with `not archived`;
  - full before/after entry snapshots are recorded.
- Added pin state transitions with version/timestamp bump and full before/after snapshots.
- Updated `HarnessStore.materializeSkills` to reconcile only non-archived effective skills, removing archived skill bundles while preserving management/render overview behavior.
- Did not modify `src/render.ts`.

## What I tested and test results

- Focused: `pnpm vitest run tests/archive.spec.ts tests/skills.spec.ts tests/store.spec.ts`
  - PASS: 3 test files, 19 tests.
- Full verification: `pnpm typecheck && pnpm test`
  - PASS: TypeScript check and 13 test files, 137 tests.
- Post-commit status verification: clean working tree.

## TDD Evidence

### RED

Command:

```text
pnpm vitest run tests/archive.spec.ts
```

Result: FAIL, 3 tests failed.

- `validateEdit accepts archive/pin edits without content` received `non-delete edits require content` instead of `undefined`.
- Archive and unarchive transition assertions received `applied: false` instead of `true`.

This was expected because the pre-change implementation required content for every non-delete edit and had no archive/pin state-transition branches.

### GREEN

Command:

```text
pnpm vitest run tests/archive.spec.ts tests/skills.spec.ts tests/store.spec.ts
```

Result: PASS, 3 test files and 19 tests.

Then:

```text
pnpm typecheck && pnpm test
```

Result: PASS, typecheck succeeded and all 137 tests passed across 13 test files.

## Files changed

- `src/refine.ts`
- `src/store.ts`
- `tests/archive.spec.ts`

## Self-review findings

- Archive/pin handling is positioned after the delete branch and before the content guard, as required.
- Archive/unarchive preconditions, version bumps, metadata preservation, and snapshots are covered by tests/implementation.
- Archived skills are excluded only from skill-file materialization; no automatic stale/GC/archive logic was added.
- `src/render.ts` was intentionally left unchanged for Task 5.
- No issues or concerns found.

## Commit

`70f16698 feat(memory): manual archive/unarchive/pin with injection-view filtering`

## Follow-up Fix Report

### What changed

- Guarded `validateEdit` so `archive` and `pin` are valid only on `update` edits, returning `archive/pin only valid on update edits` for create/delete combinations and preventing the runtime `current!` crash.
- Expanded archive coverage for applied `reason`, complete before/after snapshots, and lifecycle metadata.
- Added pin/unpin coverage for metadata state, version bumps, reasons, and snapshots.
- Added store coverage proving archived skill bundles are removed and restored after unarchive.

### Covering tests

Command:

```text
pnpm vitest run tests/archive.spec.ts tests/skills.spec.ts tests/store.spec.ts
```

Output: PASS, 3 test files and 21 tests.

Command:

```text
pnpm typecheck && pnpm test
```

Output: PASS, typecheck succeeded and all 139 tests passed across 13 test files.

### Follow-up commit

Pending commit at report-writing time.
