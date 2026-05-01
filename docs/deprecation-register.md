# Deprecation Register

Tracks back-compat surfaces inside the agent-protocols framework that have a
documented removal plan. New rows land when a Story introduces a back-compat
shim; rows are deleted when a Story executes the removal.

This register is the **single source of truth** for deprecation status. If a
shim exists in the code without a row here, the row is missing. If a row here
no longer matches code, the row is stale. Either case is a bug — open a
ticket against the owning persona.

## Schema

| Column                  | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Surface                 | File path + symbol or config key that is deprecated.                                                     |
| Owner                   | Persona responsible for shepherding the removal.                                                         |
| Compatibility reason    | Why the shim exists today (what would break for callers if removed immediately).                         |
| Replacement API         | The supported new entry point or config key callers should use.                                          |
| Removal version         | The `.agents/VERSION` value at which the shim is scheduled to be deleted. `TBD` if not yet committed.    |
| Test migration needed   | Whether downstream tests or fixtures must be updated as part of the removal.                             |

## Active deprecations

| Surface                                                               | Owner       | Compatibility reason                                                                                                    | Replacement API                                                  | Removal version | Test migration needed |
| --------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------- | --------------------- |
| `.agents/scripts/update-ticket-state.js` (CLI re-export shim)         | architect   | Existing CLI invocations and downstream tests still call the script directly; core logic moved to `lib/orchestration/ticketing.js`. | `lib/orchestration/ticketing.js` (`transitionTicketState`, `cascadeCompletion`) | TBD             | Yes — orchestration tests import the script path directly. |
| `.agents/scripts/lib/orchestration/dispatch-engine.js` → `captureLintBaseline(epicBranch, settings)` | engineer    | Older call sites pre-date the `LintBaselineService` extraction and still pass the legacy two-arg signature.             | `new LintBaselineService({ exec, logger, settings }).capture(epicBranch)` | TBD             | Yes — dispatch-engine fixtures use the function form. |
| `.agents/scripts/lib/orchestration/epic-runner.js` → `runEpic(args)` flat opts-bag (`{ epicId, provider, config, spawn, ... }`) | engineer    | Marked in the source as a one-patch-release compat shim while callers migrate to the `EpicRunnerContext` argument shape. | `runEpic({ ctx: new EpicRunnerContext({ ... }) })`               | TBD             | Yes — epic-runner test doubles construct the flat bag. |
| `.agents/scripts/dispatcher.js` `--epic <epicId>` flag                | architect   | Legacy invocation path. Current usage is `node dispatcher.js <ticketId>` with auto-detection of Epic vs. Story.         | `node dispatcher.js <ticketId> [--dry-run]`                      | TBD             | Yes — any CI script or workflow doc still passing `--epic` must be updated. |
| `.agentrc.json` → `orchestration.worktreeIsolation.bootstrapFiles`    | architect   | Older `.agentrc.json` files use the nested key; resolver still falls back to it via `resolveWorkspaceFiles`.            | `.agentrc.json` → `orchestration.workspaceFiles`                 | TBD             | Yes — fixtures under `tests/fixtures/agentrc/` still exercise the legacy key. |
| `.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js` legacy single-arg `report(state)` callers | engineer    | Callers that haven't migrated to `setPlan({ tasks })` rely on the implicit-plan behaviour for back-compat.              | `progressReporter.setPlan({ tasks })` before `report(state)`     | TBD             | Yes — progress-reporter unit tests cover both code paths. |
| `.agents/scripts/lib/orchestration/doc-reader.js` single-string concatenation return form | engineer    | Stated in source: "no longer the public" form, retained for direct readers that haven't migrated to the structured return shape. | Structured return: `{ id, content }` (and array thereof)          | TBD             | Yes — doc-reader consumer tests assert on the structured shape. |
| `.agents/scripts/lib/git-utils.js` → `task/epic-[EPIC_ID]/[TASK_ID]` branch-naming fallback (`@deprecated`) | architect   | Retained as a fallback for orphan Tasks discovered in older epics. v5 standard is `story-[STORY_ID]` execution.         | `story-[STORY_ID]` execution branches; `epic/[EPIC_ID]` integration branches | TBD             | Yes — branch-naming fixtures.                              |
| `.agentrc.json` → `agentSettings.sprintClose.runRetro`                | engineer    | Renamed to `epicClose.runRetro` as part of the sprint→epic nomenclature rework. Resolver falls back to the legacy key with a one-shot `Logger.warn(...)` so downstream `.agentrc.json` files keep working for one release. | `.agentrc.json` → `agentSettings.epicClose.runRetro`             | 5.32.0          | Yes — consumer-side `.agentrc.json` and any test fixture using the legacy key. |

## Removal protocol

When a Story executes a removal:

1. Delete the deprecated symbol / config-key handling from the code.
2. Delete the corresponding row from this register in the **same commit** as the
   code change.
3. Update the `docs/CHANGELOG.md` entry for the release that ships the removal.
4. Run the project test suite. Any failures here are the **test migration**
   indicated in the row — fix or delete the affected fixtures and tests in the
   same commit.
5. If callers exist outside this repo (consumer projects pulling the bundle),
   the CHANGELOG entry must call the removal out as a breaking change for the
   release.

## When to add a row

Add a row whenever a Story:

- Introduces a back-compat shim (function alias, re-export, default-fallback
  config key, legacy-shape parameter handling) instead of a hard rename.
- Marks an existing symbol `@deprecated`.
- Decides during implementation that a planned hard break needs to land as a
  soft transition first.

Each new row must specify the Replacement API even if the Removal version is
`TBD`. A deprecation without a documented replacement is not actionable.
