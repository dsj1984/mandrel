# CI Contract — Local `verify` vs. the Remote Gate

`npm run verify` is the local pre-PR gate. As of Story #4357 it is a **true
CI mirror** for every gate it *can* prove on a developer's machine: it runs
`npm audit --audit-level=high` (matching CI's SCA step), then `npm run lint`,
the full `npm test` suite, and the unified baselines
(`check-baselines.js`) — the same shape CI runs.

A green `npm run verify` therefore no longer hides a high-severity advisory
that CI's audit step would fail on. It is still **not** a total substitute for
CI: a small set of gates depend on the GitHub Actions environment (a pinned
third-party action, the full remote history, or push-vs-PR scope) and cannot
be reproduced faithfully from a local working tree. Those gates are catalogued
below so a local green is understood as *necessary but not sufficient* — the
authoritative verdict is the CI run on the pull request.

> **Not** a CI-only gate: the SCA audit. `npm run verify` runs
> `npm audit --audit-level=high` locally, mirroring CI. This is independent of
> the pre-push `PREPUSH_AUDIT=1` opt-in (`.husky/pre-push`), which is
> deliberately left off by default and is unchanged — the audit belongs in the
> full `verify` gate, not on every push.

## CI-only gates `npm run verify` cannot prove locally

| CI gate                                  | CI step / command                                                                     | Why it is CI-only                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action pinning                           | `node .agents/scripts/check-action-pinning.js` (`.github/workflows/ci.yml`)           | Guards that every third-party `uses:` ref stays pinned to a full 40-char commit SHA. It gates the workflow-file supply chain — a concern that only exists in the CI/CD surface itself, and there is no `verify` step for it.  |
| TruffleHog secret scan                   | `trufflesecurity/trufflehog@…` action with `--only-verified` (`.github/workflows/ci.yml`) | A pinned third-party GitHub Action that scans the *full fetched git history* for verified secrets. It needs the Actions runner and the action's own container — there is no local `verify` equivalent.                        |
| Push-scoped maintainability (`BASELINE_SCOPE=full`) | `npm run maintainability:check` with `BASELINE_SCOPE=full` on push-to-`main` (`.github/workflows/ci.yml`) | On PR runs maintainability is diff-scoped to `main`; **push-to-`main`** runs export `BASELINE_SCOPE=full` so *untouched* files still surface regressions. `npm run verify` runs the diff/local scope, not the full push-scoped sweep, so a whole-repo MI regression can only be caught by the remote push run. |

## `trust-ci` auto-merge prerequisite: configure required checks

Under the default `delivery.ci.autoMerge: "trust-ci"` policy (Story #4361),
**green required CI is the auto-merge arming signal** — the predicate arms a
merge once every *required* check is green, blocked only by an unresolved
🔴 critical code-review finding or an `agent::blocked` state. This makes the
branch-protection required-check set load-bearing: if a branch has **no
required checks configured** (no ruleset, or one was removed), the
`gh pr checks --required` probe returns an empty set, and there is then **no
CI gate** in front of the arm. Green-with-nothing-to-be-green is treated as
armable, mirroring GitHub's own "no required checks = nothing to gate"
semantics.

Operators running `trust-ci` unattended MUST therefore keep at least the
live required-check set (`lint`, `test`, `baselines`) configured on the base
branch. Consumers who cannot guarantee that should set
`delivery.ci.autoMerge: "strict"`, which restores the prior clean-sprint
predicate (zero interventions, zero 🔴/🟠 findings, clean-sprint retro) as the
arming gate regardless of the required-check configuration.

## Practical implication

Run `npm run verify` before opening a PR for fast, local confidence across
audit + lint + test + baselines. Treat the three gates above as the residual
risk that only the CI run on the pull request can close — do not read a local
green as a guaranteed remote green.
