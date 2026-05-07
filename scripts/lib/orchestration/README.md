# Orchestration SDK

This directory is the in-process orchestration SDK. Every CLI under
`.agents/scripts/` is a thin wrapper that delegates to a function exported
from here — the SDK is where the dispatch, ticketing, telemetry, and
post-merge logic actually lives.

The consumer-facing reference (configuration keys, slash-command
overview) lives at `../../../README.md` and
[`../../../../docs/configuration.md`](../../../../docs/configuration.md).
This README is the implementer's map of the SDK itself.

---

## Provider Architecture

All ticketing operations are mediated through the `ITicketingProvider`
abstract interface. The framework ships with a **GitHub provider** using
raw `fetch()` (Node 20+) — no external SDK dependencies.

Execution operations (branch creation, script dispatch) are mediated
through the `IExecutionAdapter` interface, decoupling business logic from
the shell.

| Layer                 | File                                | Purpose                                   |
| --------------------- | ----------------------------------- | ----------------------------------------- |
| Abstract Interface    | `../ITicketingProvider.js`          | Abstract ticketing contract               |
| Provider Factory      | `../provider-factory.js`            | Resolves `orchestration.provider` → class |
| GitHub Implementation | `../../providers/github.js`         | REST + GraphQL implementation for GitHub  |
| Config Resolver       | `../config-resolver.js`             | AJV schema validation + `.env` auto-loader |

The provider factory reads `orchestration.provider` from the merged
`.agentrc.json` and returns an instance whose surface matches
`ITicketingProvider`. CLI scripts never `import` the GitHub provider
directly — they receive a provider instance from the SDK barrel.

---

## SDK module list

The SDK centralizes orchestration logic. All CLI scripts are **thin
wrappers** that delegate to it.

| Module                      | Exports                                         |
| --------------------------- | ----------------------------------------------- |
| `index.js`                  | Barrel — re-exports the public SDK surface       |
| `dispatch-engine.js`        | DAG construction, wave computation, dispatch    |
| `dispatch-pipeline.js`      | End-to-end dispatch orchestration               |
| `context-hydration-engine.js` | `hydrateContext`, `assemblePrompt`            |
| `dependency-analyzer.js`    | Cross-ticket dependency resolution              |
| `manifest-builder.js`       | Dispatch-manifest synthesis                     |
| `planning-state-manager.js` | Planning phase state tracking                   |
| `planning-context-budget.js`| Token budget accounting during planning         |
| `phase-runner.js`           | Phase orchestration helper                      |
| `concurrency.js`            | Worker pools and per-phase concurrency caps     |
| `concurrent-task-resolver.js` | Task fan-out / fan-in helpers                 |
| `label-transitions.js`      | `transitionTicketState`, batch label flips      |
| `reconciler.js`              | Live-ticket reconciliation (label drift, etc.) |
| `epic-lifecycle-detector.js`| Epic-state inference from ticket graph          |
| `epic-runner.js` / `epic-runner/` | Long-running Epic orchestrator             |
| `plan-runner/`              | Plan-runner internals                           |
| `health-check-service.js`   | Push-based health monitoring                    |
| `error-journal.js`          | Structured error capture for telemetry          |
| `lint-baseline-service.js`  | Lint ratchet engine                             |
| `parked-follow-ons.js`      | Follow-on ticket parking                        |
| `post-merge-pipeline.js`    | Post-merge cascade (cascadeCompletion etc.)    |
| `recut.js`                  | Branch re-cut helper                            |
| `retro-heuristics.js`       | Retro heuristics for `/epic-close`              |
| `story-close/`              | Story-close internals                           |
| `story-close-recovery.js`   | Recovery path for partially-closed Stories      |
| `doc-reader.js`             | Doc/section lookup for context hydration        |
| `context.js`                | Context-object plumbing                         |

> The exact export surface is the source of truth in `index.js`. This
> table is descriptive — when adding a new module, update both.

---

## Scripts Reference

CLI scripts under `.agents/scripts/` are thin wrappers around the SDK.
Each parses argv, resolves config, and hands the work to a single SDK
entry point. They never own business logic.

| Script                               | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `agents-bootstrap-github.js`         | Idempotent setup of GitHub labels and project fields                    |
| `epic-planner.js`                    | Autonomous PRD and Tech Spec generation                                 |
| `ticket-decomposer.js`               | Recursive 4-tier hierarchy decomposition                                |
| `dispatcher.js`                      | CLI wrapper — DAG scheduler; outputs dispatch manifest                  |
| `context-hydrator.js`                | CLI wrapper — assembles self-contained agent prompts                    |
| `story-init.js`                      | Initializes Story execution: branches, deps, state transitions          |
| `story-close.js`                     | Finalizes Story: merges to Epic branch, cascades completions            |
| `epic-close.js`                      | Epic closure: doc freshness gate, version bump, tag release             |
| `epic-code-review.js`                | Automated code review execution                                         |
| `update-ticket-state.js`             | CLI wrapper — label-based state machine with cascade                    |
| `delete-epic.js`                     | Recursive issue deletion/clearing via GraphQL                           |
| `notify.js`                          | Operator notification (mentions + webhooks)                             |
| `lint-baseline.js`                   | Lint baseline ratchet — prevents new warnings                           |
| `check-maintainability.js`           | Maintainability score computation and baseline check                    |
| `update-maintainability-baseline.js` | Updates the maintainability baseline after improvements                 |
| `diagnose-friction.js`               | Analyzes friction logs for patterns                                     |
| `detect-merges.js`                   | Detects and reports merge conflicts                                     |
| `audit-orchestrator.js`              | Automated, gate-based static analysis and audit runner                  |
| `handle-approval.js`                 | CI webhook listener for `/approve` commands on audit findings           |

---

## Authentication

The `GitHubProvider` resolves credentials in this priority order:

| Priority | Method                       | Environment               |
| -------- | ---------------------------- | ------------------------- |
| 1        | `GITHUB_TOKEN` or `GH_TOKEN` | CI/CD, background scripts |
| 2        | `gh auth token` (CLI)        | Local developer workflow  |

### Required token permissions

**Fine-grained PATs (recommended):**

- `GitHub Projects (V2)`: Read & Write
- `Issues`: Read & Write
- `Metadata`: Read-only
- `Pull requests`: Read & Write

**Classic PATs:** `repo` + `project` (full control).

Set `GITHUB_TOKEN` in the process environment or in `.env` at the project
root — the resolver auto-loads `.env`. For local interactive sessions,
`gh auth login` is sufficient.
