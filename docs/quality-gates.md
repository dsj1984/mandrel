# Quality Gates

This is the consumer-facing reference for the quality gates the framework
runs against your repo: the lint baseline ratchet, the maintainability
ratchet, the CRAP per-method gate, the **absolute quality floors**
(90/85/90 coverage, MI ≥ 70, CRAP ≤ 20), the anti-thrashing protocol,
and the concurrent close-safety retry that protects the Epic branch when
multiple Stories close in quick succession.

The floor + ratchet duo is intentional: the ratchet protects against
regressions on touched files; the floor enforces an absolute threshold
on every in-scope file regardless of diff scope. See
[§ Absolute quality floors (Epic #1184)](#absolute-quality-floors-epic-1184)
below for the policy and [`decisions.md`](decisions.md) (ADR
20260512-coupling-stance) for the framework-wide stance that motivates
the lift the floor gate represents.

The configuration knobs that drive these gates live in
[`docs/configuration.md`](configuration.md) under
`agentSettings.quality.*` and `orchestration.runners.storyMergeRetry.*`. This
file is the runbook side — what the gate does, when it fires, and how to
bootstrap or refresh it.

The **baseline envelope, per-kind shapes, component model, writer/reader
contract, and floor-override path** are documented in a dedicated
reference — [`docs/baselines.md`](baselines.md). Each per-gate section
below cross-links back to that reference; consult it once and reuse the
context as you read through any individual gate.

---

## Concurrent close safety

`/epic-deliver`'s wave loop may close multiple Stories into the same
`epic/<epicId>` branch in quick succession. The push step inside `story-close.js` retries
on a non-fast-forward rejection — fetch, replay the story merge on top of
the new remote tip, push again — bounded by
`orchestration.runners.storyMergeRetry.maxAttempts` (default 3) and
`orchestration.runners.storyMergeRetry.backoffMs` (default `[250, 500, 1000]`).
A real
content conflict (both stories touched the same lines) aborts the loop
with a clear error and leaves the local tree clean for manual resolution.

---

## Test runner concurrency

`npm test` pins the Node test runner to `--test-concurrency=8`. Without
the flag, Node defaults to `os.availableParallelism()`, which on
modern dev hosts (12–16 logical cores) over-subscribes the suite and
reliably surfaces flakes from shared FS fixtures (`memfs` mounts,
`temp/` snapshot dirs, the `coverage/` artifact directory shared with
the CRAP gate). On the GitHub Actions 2-vCPU runner, oversubscription
goes the other way — the default of 2 leaves wall-clock on the table
because most test files spend their time awaiting `setImmediate` /
mocked HTTP, not on CPU.

Pinning at 8 lands a stable middle: high enough to keep the local
244-file suite under ~30 s on a 12-core host, low enough to avoid the
filesystem-race surface that the cap=4 / cap=8 orchestration helpers
(`SUBTICKET_HYDRATION_CONCURRENCY`, the wave-gate, the link-reconciler)
already settled on as the project house-style ceiling. Any change to
this number must be paired with a benchmark run on both a Windows dev
host and a GitHub Actions runner to confirm it doesn't reintroduce the
flakes the pin is preventing.

---

## Coverage baseline gate

> Baseline envelope, axes, and component model: see
> [`docs/baselines.md`](baselines.md).

`npm run test:coverage` drives
[`.agents/scripts/run-coverage.js`](../.agents/scripts/run-coverage.js),
which runs the unit-test suite with `NODE_V8_COVERAGE` set, post-processes
the V8 dumps with `c8 report`, then delegates to
[`.agents/scripts/check-baselines.js`](../.agents/scripts/check-baselines.js)
for the gate decision. There is no global `lines/branches/functions`
threshold — the gate compares **per-file** coverage in
`coverage/coverage-final.json` against the floors recorded in
[`baselines/coverage.json`](../baselines/coverage.json) and fails on:

- a regression on any axis (lines, branches, or functions) for any file
  whose coverage dropped more than `0.01` percentage points below its
  recorded floor;
- an in-scope file with no baseline entry (a brand-new untested CLI
  shell would otherwise sail through with 0 % coverage and no recorded
  floor to drop below).

Scope (include/exclude) and reporters are declared in
[`.c8rc.cjs`](../.c8rc.cjs); the gate reads the same file so `c8 report`
and the per-file checker agree on what's in scope. Bootstrap or
ratchet the baseline when an intentional scope change shifts coverage:

```bash
npm run test:coverage   # produces coverage/coverage-final.json (gate
                        # warns + passes when no baseline exists yet)
npm run coverage:update # writes baselines/coverage.json from the run
```

`npm run coverage:check` runs the gate standalone against an existing
`coverage-final.json` artifact (useful from CI hooks or close-validation
runners that orchestrate coverage capture separately).

The same files-out-of-scope list as before, declared in `.c8rc.cjs`:

- `.agents/scripts/agents-bootstrap-github.js` — one-shot bootstrap CLI
  whose meaningful logic (label taxonomy + project field defs) lives
  in `lib/label-taxonomy.js` and is unit-tested there. The CLI shell
  itself is integration-only against a live GitHub repo.
- `.agents/scripts/context-hydrator.js` — thin wrapper around the
  unit-tested hydration engine; end-to-end coverage requires a real
  provider tree and Story prompt context, which lives in integration
  tests.
- `.agents/scripts/ticket-decomposer.js` — `/epic-plan` decomposition
  driver. Validation logic is exercised by the planner tests; the
  CLI's two modes (`--emit-context` and the validate-then-create
  default) require real PRD/Tech-Spec bodies and a live Epic id.
- `epic-plan.js`, `epic-plan-decompose.js`, `epic-plan-spec.js`,
  `epic-plan-healthcheck.js`, `epic-runner.js`,
  `retrofit-task-bodies.js` — top-level CLI shells with no unit-test
  seam; the meaningful orchestration logic lives in `lib/orchestration/*`
  and `lib/retrofit/` respectively, and is unit-tested there.

Each excluded file also carries `/* node:coverage ignore file */` at
the top of its source as a second line of defence; the full
justification for each exclusion lives in the header comment of
[`.c8rc.cjs`](../.c8rc.cjs) and MUST be updated when the list changes.

The current shape of this pipeline (NODE_V8_COVERAGE +
`c8 report` instead of wrapping the run in `c8 <cmd>`) was chosen
after a one-off A/B benchmark showed it was ~19 % faster end-to-end
on a Windows dev host while producing the same `coverage-final.json`
artifact.

---

## Absolute quality floors (Epic #1184)

The per-file ratchet only protects against **regressions** — if a file
has been sitting at 60 % coverage or MI = 58 since the v5 baseline, the
ratchet is perfectly happy to keep it there forever. Epic #1184 layers
an absolute-threshold gate on top of the ratchet that fails the build
when any in-scope file is below floor, regardless of whether the diff
touched it:

| Metric | Floor | Scope |
| --- | --- | --- |
| Coverage — lines | ≥ 90 % | per file |
| Coverage — branches | ≥ 85 % | per file |
| Coverage — functions | ≥ 90 % | per file |
| Maintainability Index | ≥ 70 | per file |
| CRAP | ≤ 20 | per method |

The floors are declared in [`.agentrc.json`](../.agentrc.json) under
`agentSettings.quality.qualityFloors.*` (defaults baked into the helper
match the table above) and resolved at runtime by the shared
helper [`lib/orchestration/check-baselines/phases/floors.js`](../.agents/scripts/lib/orchestration/check-baselines/phases/floors.js).
All three gates run through `check-baselines.js` (coverage,
maintainability, crap), which invokes the floors phase **after** the
ratchet decision so a file that's below floor but matched the (stale)
baseline still trips the gate.

### When the floor gate fires

- **Pre-push** (`.husky/pre-push`): the per-file ratchet runs against
  `origin/main` first (diff-scoped, fast). The three full-scope floor
  calls (`npm run coverage:check -- --full-scope`,
  `maintainability:check -- --full-scope`,
  `crap:check -- --full-scope`) run after the ratchet so an in-scope
  file drifting below floor in an untouched part of the tree still
  blocks the push.
- **CI** (`.github/workflows/ci.yml`): the floor block is enabled by
  default inside each checker, so the existing **Maintainability Check**
  and **CRAP Check** steps already enforce floors. Epic #1184 added an
  explicit **Coverage Baseline + Floor Check** step (diff-scoped on
  PRs, `--full-scope` on push-to-main) to complete the three-axis
  coverage of the floor-gate contract.

### Opt-out

The floor block accepts a single opt-out: `--floor=off`. This is used
exclusively by the `*:update` baseline-snap scripts, which deliberately
snapshot whatever the current numbers are without regard to the floor.
**Do not pass `--floor=off` in normal close-validation or push flows.**
The audit suite scans for accidental uses of the flag.

### No silent excludes (`.c8rc.cjs` policy)

The floor gate is only as strict as its scope, so the `exclude` list in
[`.c8rc.cjs`](../.c8rc.cjs) carries three hard requirements that are
enforced by review (and partially by the audit suite):

1. **One-line rationale per entry.** Every file in `exclude[]` MUST have
   a bulleted justification in the `.c8rc.cjs` header comment naming
   *why* it is excluded — typically "thin CLI shell, meaningful logic
   lives in `lib/<X>` and is unit-tested there." A bare path with no
   rationale is a review-block.
2. **`/* node:coverage ignore file */` pragma at source.** Every
   excluded file MUST carry the Node coverage pragma at the top of its
   own source. This is the second line of defence: when `c8 report` and
   the baseline checker disagree about scope (different cwd, different
   glob expansion, partial install), the pragma keeps the file out of
   the gate's numerator from the inside.
3. **Excluded file's callees clear the floor.** A CLI shell is only a
   legitimate exclude if the `lib/` module it wraps actually clears the
   floor (coverage 90/85/90, MI ≥ 70, CRAP ≤ 20). Excluding a shell
   that delegates to under-tested helpers re-introduces the very
   risk the floor gate exists to surface; the audit suite spot-checks
   the callee map at exclude-list churn time.

Story #1602 audit pass (2026-05-13) removed two stale exclude entries
(`epic-runner.js`, `ticket-decomposer.js`) whose source files had already
been deleted in earlier refactors. Every remaining entry was re-verified
against requirements 1 and 2 above.

### Discontinuity with v5 baselines

The floor gate landed alongside a fresh baseline reset
(Tasks #1623, #1625, #1626, #1629). Any direct numeric comparison
against pre-floor-gate baseline snapshots is meaningless because the
pre-rebrand scope included files the current tree excludes (CLI shells,
generated artifacts) and because the absolute-floor gate is new —
historical files that were "green" on the ratchet may now show as below
floor and require either real test additions or an intentional
`.c8rc.cjs` exclude. The Story #1602 close-out lists every file that
flipped category in the reset.

---

## Anti-thrashing protocol

Agents MUST halt, summarize blockers, and re-plan if they hit consecutive
tool errors or perform consecutive analysis steps without modifying a
file. When any threshold under
[`agentSettings.limits.friction`](configuration.md#agentsettingslimits) is
tripped, the friction logger flips the Story to `agent::blocked` and
posts a structured `friction` comment on the Task so the operator has
the trace.

---

## Lint baseline ratchet

> Baseline envelope, axes, and component model: see
> [`docs/baselines.md`](baselines.md).

The lint baseline engine enforces zero-deterioration during Epic
workflows. Integrations fail if new lint warnings are introduced, and the
baseline automatically tightens when the codebase improves.

The canonical baseline file lives at `baselines/lint.json` (override via
`agentSettings.quality.baselines.lint.path`). Refresh with:

```bash
node .agents/scripts/lint-baseline.js --refresh
```

Refresh commits should use a `baseline-refresh:` subject + non-empty body so
the operator can spot baseline edits in review — same convention as the CRAP
and maintainability ratchets. The CI guardrail that mechanically enforced
this was removed in 5.42; the operator is now the gate.

---

## Maintainability ratchet

> Baseline envelope, axes, and component model: see
> [`docs/baselines.md`](baselines.md).

A per-file maintainability scoring engine computes composite scores based
on cyclomatic complexity, file length, and dependency counts. The
`baselines/maintainability.json` baseline prevents score degradation
between Epics.

Refresh with `npm run maintainability:update` (or the `refreshCommand`
configured in `agentSettings.quality.baselines.maintainability.refreshCommand`).

`agentSettings.quality.maintainability.targetDirs` controls the scanned
directories — defaults to `["src"]`, accepts `{ "append": [...] }` /
`{ "prepend": [...] }` for additive overrides.

---

## CRAP gate (v5.22.0+) — Consumer onboarding

> Baseline envelope, axes, and component model: see
> [`docs/baselines.md`](baselines.md).

A sibling per-method gate alongside the maintainability ratchet. CRAP
scores each JavaScript method via `c² · (1 − cov)³ + c`, combining
`typhonjs-escomplex` cyclomatic complexity with per-method coverage from
the `coverage/coverage-final.json` artifact your test runner already
produces. No new runtime dependencies. Runs at three sites:
`close-validation` (story close), `ci.yml` (push + PR), and
`.husky/pre-push`.

If you're a consumer repo pulling the framework via the `dist` submodule,
this is what you need to know.

### First-run behavior — bootstrap before the first push

As of Story #791 the gate is hard-enforcing across all three firing sites
(close-validation, pre-push, CI). With `crap.enabled: true` and no
`baselines/crap.json` on disk, `check-crap` prints:

```text
[CRAP] no baseline found — run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to bootstrap
```

…and exits `1`. Bootstrap explicitly: run `npm run test:coverage` to
produce `coverage/coverage-final.json`, then `npm run crap:update` to
generate `baselines/crap.json`, and commit the file with a
`baseline-refresh:` tagged subject + non-empty body so the
refresh-guardrail accepts it on the next PR.

The transitional informational mode (exit 0 on first sync) was retired in
Story #791 because it allowed broken pipelines to ride green for an
indeterminate window. If your test runner doesn't produce per-method
coverage, see "Disabling the gate" below.

### Disabling the gate (single-flag opt-out)

If your repo doesn't run coverage, set `enabled: false` in your
`.agentrc.json`:

```jsonc
{
  "agentSettings": {
    "quality": {
      "crap": { "enabled": false }
    }
  }
}
```

All three gate sites self-skip with `[CRAP] gate skipped (disabled)` — no
source edits required. The maintainability ratchet keeps running.

### Extending `targetDirs` without re-listing framework defaults

The config resolver supports deep-merge for list-valued keys. To add your
own source dirs to the framework default (`["src"]`):

```jsonc
{
  "agentSettings": {
    "quality": {
      "crap": {
        "targetDirs": { "append": ["packages/foo/src", "packages/bar/src"] }
      }
    }
  }
}
```

`{ "append": [...] }` and `{ "prepend": [...] }` are the deep-merge forms.
Passing a plain array replaces the default entirely — useful when you
want exactly your dirs and not the framework's. Unknown keys under
`quality.crap` warn but don't fail resolution, so you can extend
forward-compatibly.

### Interpreting the `--json` artifact

`npm run crap:check -- --json temp/crap-report.json` (or the `crap-report`
artifact uploaded by the framework's `ci.yml`) writes:

```jsonc
{
  "kernelVersion": "1.0.0",       // Bumps when the CRAP formula changes.
  "escomplexVersion": "7.3.2",    // Bumps with the typhonjs-escomplex dep.
  "summary": {
    "total": 412,
    "regressions": 2,             // Tracked methods over baseline + tolerance.
    "newViolations": 1,           // New methods over `newMethodCeiling`.
    "drifted": 5,                 // Same method, shifted line — informational.
    "removed": 3,                 // Baseline rows absent from current scan.
    "skippedNoCoverage": 8        // Methods skipped under `requireCoverage`.
  },
  "violations": [
    {
      "file": ".agents/scripts/foo.js",
      "method": "doWork",
      "startLine": 42,
      "cyclomatic": 8,
      "coverage": 0.2,
      "crap": 45.3,
      "baseline": 18.0,
      "kind": "regression",
      "fixGuidance": {
        "crapCeiling": 18.0,
        "minComplexityAt100Cov": 4,             // floor(sqrt(target))
        "minCoverageAtCurrentComplexity": 0.74  // 1 − ((target − c) / c²)^(1/3)
      }
    }
  ]
}
```

Pick the cheaper axis from `fixGuidance` per offender:

- **`minComplexityAt100Cov`** — refactor the method down to ≤ this many
  branches and your existing coverage takes you under target.
- **`minCoverageAtCurrentComplexity`** — leave the structure alone and
  add tests until coverage reaches this fraction (`null` means
  unachievable at the current cyclomatic — refactor first).

The round-trip property: applying either single-axis fix re-scores the
method under target. Verified by unit test, so an agent can commit either
strategy without re-running the gate to check.

### Refreshing the baseline (when the drift is justified)

`npm run crap:update` regenerates `baselines/crap.json`. The refresh
should land in a commit whose:

1. Subject starts with the configured `refreshTag` (default
   `baseline-refresh:`).
2. Body is non-empty and explains why the refresh is justified.

The CI guardrail that mechanically rejected unlabeled baseline edits was
removed in 5.42 alongside the bot-approver pipeline. The convention is
preserved so the operator can grep refresh commits in PR diff, but
self-policing is the operator's job during `/epic-deliver`'s Phase 7
watch loop — an unjustified baseline ratchet is no longer caught by CI.

---

## HITL blocker escalation

`risk::high` is informational/planning metadata only. Runtime execution
does not pause automatically on `risk::high`.

The sole runtime HITL pause point is `agent::blocked`: when an agent
encounters an unresolvable blocker (including unsafe destructive actions
lacking explicit authorization), it flips the ticket/Epic to
`agent::blocked`, posts friction context, and waits for operator resume
(`agent::executing`).

`agentSettings.planning.riskHeuristics` remains the rubric for identifying
high-impact operations that should trigger blocker escalation.

---

## Post-floor-gate baseline reset (Story #1701)

**Date:** 2026-05-14
**Commit:** `0657272` (Story #1701, Epic #1653)
**Files refreshed:** `baselines/coverage.json`,
`baselines/maintainability.json`, `baselines/crap.json`.

A one-time baseline reset captured fresh coverage, maintainability, and
CRAP snapshots on the post-remediation `main` HEAD. The ratchet
continues from this new floor, not from any pre-floor-gate history.

**Policy:** these baselines are **non-comparable** to any prior
baseline. Do not diff per-file numbers against pre-reset entries to
reason about regressions — the post-remediation tree contains refactors,
extractions, and coverage gains that shift the absolute numbers in ways
the per-file ratchet cannot reconcile across the discontinuity. Use the
post-reset capture as the new floor; ratchet from there.

**Why:** Epic #1184 closed the floor-gate rollout. The absolute-floor
gate (coverage 90/85/90, MI ≥ 70, CRAP ≤ 20) is wired into
`.husky/pre-push` and the CI coverage workflow (see
[`§ Absolute quality floors`](#absolute-quality-floors-epic-1184)).
With the floor enforced on every in-scope file, every per-file baseline
entry must clear the absolute floor — this snapshot is the first
capture that holds that invariant repository-wide.

**Operator action:** none. The baseline is committed and
`maintainability:check` / `coverage:check` / `crap:check` pass against
it out of the box. The next regression you see will be diffed against
this baseline, not against pre-reset history.
