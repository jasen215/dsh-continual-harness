# Final Whole-Branch Review Fixes

## Finding 1: title persistence

`applyRefinementProposal` now carries `edit.title` into both skill and non-skill create entries, and into update entries after spreading the current entry so explicit title changes override the prior title. Regression coverage in `tests/refine.spec.ts` verifies create and update persistence.

## Finding 2: complete entry fingerprint

`entryFingerprint` now canonicalizes all persisted fields: version, content, title, skill description/reference/arguments, metadata, and protection. Regression coverage mutates a skill legacy field during planning and verifies the edit is rejected as a baseline conflict.

## Finding 3: faithful promotion copy

`HarnessStore.promoteEntry` now copies content, title, skill description/reference/arguments, and local metadata. Passing metadata through the edit preserves the original `sourceSession` under Ruling-5 precedence and retains lifecycle/pin/injection fields. Regression coverage verifies the complete promoted skill, unchanged local entry, deterministic conflict behavior, and unknown-id error behavior.

## Finding 4: durable rollbackDegraded

`stampAppliedEdit` now persists `edit.rollbackDegraded` in the committed applied-edit record. Regression coverage applies a rollback generated from a legacy content-only record and verifies the committed result retains `rollbackDegraded: true`.

## TDD evidence

Regression tests were added before production fixes and the focused suite was run while defects were still present: 4 expected tests failed (title persistence, skill-field baseline conflict, rollbackDegraded durability, and full promotion copy). After implementation, `pnpm vitest run tests/refine.spec.ts tests/store.spec.ts` passed with 34/34 tests.

## Verification

- `pnpm typecheck` passed.
- `pnpm test` passed: 17 files, 168 tests.
- `git diff --check` passed.

## Files changed

- `src/refine.ts`
- `src/store.ts`
- `tests/refine.spec.ts`
- `tests/store.spec.ts`
- `.superpowers/sdd/2026-08-19-02-memory-layer-mvp/final-fixes-report.md`

## Self-review

The production diff is limited to the four requested fixes. No snapshot, compact, lock, auto-GC, cross-store transaction, archive/pin, ranking, projection, wrapup, or configuration behavior was changed. Promotion remains deterministic for conflicts and unknown ids, does not mutate local state, and keeps the existing Date.now proposal id. The final source-session precedence remains `edit.metadata?.sourceSession ?? options.sourceSession`.
