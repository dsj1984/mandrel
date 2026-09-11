# CI Contract — Local `verify` vs. the Remote Gate

`npm run verify` is the local pre-PR gate. As of Story #4357 it is a **true
CI mirror** for every gate it *can* prove on a developer's machine: it runs
`npm audit --audit-level=high` (matching CI's SCA step), then `npm run lint`,
the full `npm test` suite, the unified baselines (`check-baselines.js`), and —
as of Story #4549 — the standalone ratchets CI's `baselines` job runs in its
"Architecture Cycle Check" step (`check-dead-exports.js` and
`check-context-budget.js`; `check-arch-cycles.js` is already run by the `lint`
step) — the same shape CI runs.

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

Nor are the architecture ratchets, for the same reason:

> **Not** CI-only gates: the standalone ratchets in CI's "Architecture Cycle
> Check" step. Every ratchet that step runs is pure-Node, baseline-aware and
> full-tree-safe, so `npm run verify` covers each one (Story #4549). The step
> itself is the SSOT for the command list —
> [`ci.yml`](../.github/workflows/ci.yml), `baselines` job:
>
> | Ratchet | How `npm run verify` covers it |
> | --- | --- |
> | `check-arch-cycles.js` | Via the `lint` step — `run-lint.js` has run it since Story #3991. Deliberately **not** repeated in `run-verify.js`; doing so would double-pay the gate. |
> | `check-dead-exports.js` | Its own `dead-exports` step (Story #4549). |
> | `check-dead-exports.js --production` | Its own `dead-exports-production` step — added when the production-mode pass (#4582) joined CI's baselines job. |
> | `check-context-budget.js` | Its own `context-budget` step (Story #4549). |
> | `check-workflow-citations.js` | Via the `test` step — `tests/check-workflow-citations.test.js` runs the same ratchet against the committed baseline, so a regression fails the suite. Deliberately **not** a separate `run-verify.js` step; doing so would double-pay the gate. |
>
> Before #4549 the latter two sat in a contract hole — omitted from the mirror
> *and* absent from the CI-only table below — reachable locally only by a direct
> invocation or via `npm run quality:preview`, whose `HEAD`-scoped diff (the
> alias passes no `--changed-since`; the script defaults to `HEAD`) makes it a
> pre-commit tool rather than a full-tree gate. That hole
> cost Story #4531 / PR #4548 a full push → CI-red → fix → push round-trip on a
> stray `export default` a local check would have caught in seconds.
> `quality:preview` keeps its existing scope and gate set — the two commands
> serve different moments.

## CI-only gates `npm run verify` cannot prove locally

| CI gate                                  | CI step / command                                                                     | Why it is CI-only                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action pinning                           | `node .agents/scripts/check-action-pinning.js` (`.github/workflows/ci.yml`)           | Guards that every third-party `uses:` ref stays pinned to a full 40-char commit SHA. It gates the workflow-file supply chain — a concern that only exists in the CI/CD surface itself, and there is no `verify` step for it.  |
| TruffleHog secret scan                   | `trufflesecurity/trufflehog@…` action with `--only-verified` (`.github/workflows/ci.yml`) | A pinned third-party GitHub Action that scans the *full fetched git history* for verified secrets. It needs the Actions runner and the action's own container — there is no local `verify` equivalent.                        |
| Test-temp hygiene (`--snapshot` / `--assert`) | `node .agents/scripts/check-test-temp-hygiene.js --snapshot` before the test run, `--assert` after (`.github/workflows/ci.yml`) | Brackets the CI test run (Story #4696): fingerprints the friction / lifecycle / trace NDJSON streams under `temp/` pre-test and fails the build if any stream file was added or grew — catching a test writer that bypasses the scratch seam and pollutes real telemetry. `npm run verify` does not bracket its test run with this snapshot/assert pair. |
| `Windows Smoke` (required) | the `windows-smoke` job of `.github/workflows/ci.yml` — `bootstrap.js --dry-run --assume-yes --skip-github`, `npm run sync:commands`, the config-resolution slice (`tests/shipped-configs-validate.test.js` + `tests/lib/config-resolver.test.js`), then `npm run test:quick` | The only `windows-latest` surface in the repo (Story #3389). It catches Windows-only regressions in worktree path handling, PowerShell/npm wiring, and platform-conditional code — the largest gap a local green on macOS/Linux structurally cannot cover, since no local run executes on Windows. It is **required**: the job is in the branch-protection required-status-check set, so a red `Windows Smoke` blocks the merge. It was advisory until 2026-09-10, deliberately kept out to avoid reintroducing the c8/timing baseline flap that retired the full Windows matrix leg (#1270) — but advisory meant auto-merge landed Windows-only reds on `main` unnoticed: on 2026-09-10 alone `main` went red seven times, and **every** red CI run in that window was this job — two of them from Epic #5286's own Stories, and one of those was only discovered because it failed the 2.55.0 release PR. The flap risk is real and now shows up as a blocked merge rather than a red `main`; if a timing-sensitive assertion starts flapping, fix or quarantine that assertion rather than demoting the leg again. |
| OS-temp-root hygiene (same bracket) | the same `--assert` step, plus `--lint-globs` (`.github/workflows/ci.yml`) | Two further dimensions added in Story #4808, riding the bracket above. **Runtime:** the snapshot also records the `mandrel-suite-*` roots already present in `os.tmpdir()`, and `--assert` fails on any that appeared during the run and survived — i.e. a process minted a suite root and exited without reaping it. Diffing against the snapshot (rather than asserting an empty set) is what keeps a concurrent suite in another checkout from failing this one. **Static:** `--lint-globs` fails when a test file calls `mkdtemp` against `os.tmpdir()` directly instead of `makeTempDir()` from `.agents/scripts/lib/test-temp.js`, catching the next leaking file at authoring time. Both are CI-only for the same reason as the row above; the static one is additionally **off unless `--lint-globs` is passed**, because this script ships in the materialized `.agents/` payload and the rule must not fire on a consumer's tests. |

### Retired: push-scoped maintainability (`BASELINE_SCOPE=full`)

Until Story #5004 this table carried a **Push-scoped maintainability** row: the
`validate` job's `Maintainability Check` step exported
`BASELINE_SCOPE: ${{ github.event_name == 'pull_request' && '' || 'full' }}`,
so on PR runs it was diff-scoped — a byte-for-byte duplicate of the required
`baselines` job's `check-baselines.js` run — and on push-to-`main` it took the
`full` branch.

#### Correction: the `full` leg was not a sweep

Story #5004 recorded the deleted `full` leg as a full-scope sweep that
"re-scored untouched files", and called losing it the price of removing the
duplicate. **That was wrong on the mechanism, and so wrong on the loss.**

`check-baselines.js` is a **reader**. It loads the committed baseline envelope
via `lib/baselines/reader.js` and never invokes a scorer. On the read path
`BASELINE_SCOPE=full` does one thing: it makes `evaluateCompare`
([`phases/compare.js`](../.agents/scripts/lib/orchestration/check-baselines/phases/compare.js))
return an empty result, because that function short-circuits whenever
`scope.mode !== 'diff'`. Full scope **disables the head-vs-base ratchet arm**;
it does not widen a re-score, because there is no re-score to widen.

Measured on this repository:

| Invocation | Rows compared | `baseRead` | Wall clock |
| --- | --- | --- | --- |
| `check-baselines.js --gate maintainability` | 556 | `true` | 0.18s |
| `BASELINE_SCOPE=full` + the same command | 0 | `false` | 0.14s |

Both finish in under a fifth of a second, which is the tell on its own: a real
full-scope maintainability re-score of this tree takes ~1.7s of escomplex work.

So the push-to-`main` leg ran **floors only** over the committed rollup —
strictly weaker than the diff-scoped PR leg, and a strict subset of the
required `baselines` job on push runs as well as on PR runs. Deleting the step
lost nothing. There is no gap here to attribute to Story #5004.

#### The real gap, and what now covers it

Full-scope **re-scoring** has only ever existed in two places: the write path
(`*:update -- --full-scope`) and
[`check-baseline-drift.js`](../.agents/docs/quality-gates.md#check-baseline-driftjs--the-scheduled-full-scope-re-score).
Nothing automated ran the latter — before Story #5004 or after it — so drift in
untouched files has always accumulated invisibly. That is a real hole; it was
simply never the deleted step's to fill.

[`.github/workflows/baseline-drift.yml`](../.github/workflows/baseline-drift.yml)
now fills it: a nightly (05:43 UTC) + `workflow_dispatch` job that re-scores
maintainability full-scope with `--require-scored`, opens or updates one
`meta::baseline-drift` tracking issue with the report, closes that issue when
the tree comes back clean, and fails the run. It is deliberately off the
per-PR path, so the duplication #5004 removed is not reintroduced. Its first
run on this tree found **20 of 556 rows** drifted beyond the 0.5 tolerance
(all improvements — a slack ratchet, up to 8.5 MI points on one file).

The same check remains available ad hoc, and a consumer materializing
`.agents/` still owns its own schedule:

```bash
node .agents/scripts/check-baseline-drift.js --gate maintainability
```

`crap` is the other `DRIFT_KIND` and is **not** in the nightly job yet: its
drift identity is `path::method@startLine`, so any edit above a method re-keys
its row. Measured against a real coverage artifact: 82 drifted but 1438 added
and 898 removed, of which 853 removals are the same `path::method` reappearing
at a new line. Coverage and duplication are not `DRIFT_KIND`s at all — coverage
rows carry three metric axes (`lines`/`branches`/`functions`) rather than the
single scalar `KIND_SPECS` assumes, and duplication rows exist only where
clones do, so an appearing or vanishing row is ordinary churn rather than
drift. None of the three were ever in the deleted step, which ran
`--gate maintainability` alone.

`check-baseline-scope.js` (in CI's `baselines` job) covers the adjacent
question — whether the baseline's row set still describes the tree — but not
whether the recorded numbers are still true.

## Scheduled sweeps that run off the per-PR path

Two gates in this repository are **time-triggered rather than diff-triggered**,
because the thing they check can go wrong without anybody's diff causing it.
Both follow the same shape: one reusable tracking issue keyed by **label**
(never a title search — GitHub's issue search index lags, and a lookup that
misses opens a duplicate every night), the issue closed automatically once the
condition clears, and the run failing **last** so a failed scheduled run is the
notification while the issue is the durable surface.

| Workflow | Cadence | What it catches |
| --- | --- | --- |
| [`baseline-drift.yml`](../.github/workflows/baseline-drift.yml) | 05:43 UTC nightly | Baseline rows that no longer describe the tree, in files no recent branch touched — invisible to every diff-scoped enforcement site. |
| [`dependency-audit-cron.yml`](../.github/workflows/dependency-audit-cron.yml) | 04:11 UTC nightly | A high-severity npm advisory published against an already-installed package, which reds `main` between PRs. |

### Why the dependency sweep is not just the required check

`ci.yml`'s required `Dependency Vulnerability Audit (SCA)` step runs
`npm audit --audit-level=high`, and it is the only `npm audit` invocation in
`.github/workflows/`. It runs on push and on pull_request — never in between.
Advisories, though, are published against packages that are *already*
installed, so `main` turns red with no commit to blame. The first PR opened
afterwards becomes the discovery mechanism: its required check fails, and its
author debugs a supply-chain advisory from inside a log that has nothing to do
with their change. That has recurred at least six times.

Renovate does not close this class on its own. It remediates declared
**ranges**, and a transitive-only package — no `dependencies` entry, no
`overrides` entry — has no range for it to raise, so only a lockfile refresh
can move one. `fast-uri` was exactly that shape: the patched release had been
published for ten days, `vulnerabilityAlerts` was enabled at any time, GitHub
Dependabot alerts were on, a weekly `lockFileMaintenance` window had elapsed,
and `main` was still red with zero open dependency PRs.

The sweep uses the **same** invocation as the required step, so the two can
never disagree about what counts as red. It adds detection, not remediation:
the fix is still a standalone `fix(deps)` PR against `main`, and the advisory's
own version range should be read before accepting whatever `npm audit fix
--force` proposes — the parent package's declared range often already admits a
patched version, making the real fix lockfile-only.

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

Operators running `trust-ci` unattended MUST therefore keep a non-empty
required-status-check set configured on the base branch. In **this**
repository that set is the contexts recorded in
[`.github/ruleset.json`](../.github/ruleset.json):

| Required check context     | Produced by                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `Validate and Test`        | the `validate` job of `.github/workflows/ci.yml`               |
| `baselines`                | the `baselines` job of `.github/workflows/ci.yml`              |
| `install (npm / ubuntu-latest)`   | the Gate profile of `.github/workflows/install-matrix.yml` |
| `install (yarn / windows-latest)` | the Gate profile of `.github/workflows/install-matrix.yml` |

> **`.github/ruleset.json` is a non-enforcing snapshot, not the declaration.**
> It is a committed *record* of the live `Protect Main` ruleset (id
> `14286998`) so the intended contract is reviewable in version control —
> **committing an edit to it changes nothing**. The live ruleset is the only
> enforcement source, and an operator MUST re-apply the file out of band
> (`gh api --method PUT repos/dsj1984/mandrel/rulesets/14286998 --input
> .github/ruleset.json`, or the GitHub UI) for a change to take effect. See
> [`.github/README.md`](../.github/README.md) for the full procedure. Read the
> authoritative set off the live ruleset
> (`gh api repos/{owner}/{repo}/rulesets`) whenever it matters.

A second confusion is worth stating just as plainly:

> **`.agentrc.json` `requiredChecks` names are NOT check contexts.** The
> `github.branchProtection.requiredChecks` entries are `{ name, cmd }` pairs —
> `name` is a **local label** for a command the bootstrap/verification path
> runs on your machine (`lint` → `npm run lint`, `test` → `npm test`,
> `baselines` → `node .agents/scripts/check-baselines.js`). GitHub reports a
> status under the *job's display name*, which is a different string:
> `npm run lint` and `npm test` both run **inside** the job GitHub reports as
> `Validate and Test`, so there is no `lint` context and no `test` context to
> require. Configuring branch protection from the `.agentrc.json` names would
> register up to two contexts that no workflow ever reports — GitHub would
> hold every PR forever, or, if the ruleset were removed to unstick it, leave
> the `trust-ci` arm with nothing to gate. Read the contexts off the live
> ruleset (`gh api repos/{owner}/{repo}/rulesets`) or the job `name:` fields
> in `.github/workflows/`, never off `.agentrc.json`.

Consumers who cannot guarantee a live required-check set should set
`delivery.ci.autoMerge: "strict"`, which restores the prior clean-sprint
predicate (zero interventions, zero 🔴/🟠 findings, clean-sprint retro) as the
arming gate regardless of the required-check configuration.

## Practical implication

Run `npm run verify` before opening a PR for fast, local confidence across
audit + lint + test + baselines + ratchets. Treat every gate in the CI-only
table above as the residual risk that only the CI run on the pull request can
close — do not read a local green as a guaranteed remote green.
