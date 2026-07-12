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
below for the policy and [`docs/decisions.md`](../../docs/decisions.md) (ADR
20260512-coupling-stance) for the framework-wide stance that motivates
the lift the floor gate represents.

The configuration knobs that drive these gates live in
[`.agents/docs/configuration.md`](../docs/configuration.md) under
`delivery.quality.*` and the framework-internal `DEFAULT_STORY_MERGE_RETRY` constant. This
file is the runbook side — what the gate does, when it fires, and how to
bootstrap or refresh it.

The **baseline envelope, per-kind shapes, component model, writer/reader
contract, and floor-override path** are documented in the
[Baseline reference](#baseline-reference) section at the end of this
document. Each per-gate section below cross-links to that section; consult
it once and reuse the context as you read through any individual gate.

> **Story-level gates.** Quality gates run against the Story branch
> after the single Story-implementation phase completes. Friction
> comments flip the Story to `agent::blocked` and post on the Story
> ticket.

---

## Concurrent close safety

`/deliver`'s wave loop may close multiple Stories into the same
`epic/<epicId>` branch in quick succession. The push step inside `story-close.js` retries
on a non-fast-forward rejection — fetch, replay the story merge on top of
the new remote tip, push again — bounded by
`DEFAULT_STORY_MERGE_RETRY.maxAttempts` (3) and
`DEFAULT_STORY_MERGE_RETRY.backoffMs` (`[250, 500, 1000]`) from
`.agents/scripts/lib/config/runners.js`.
A real
content conflict (both stories touched the same lines) aborts the loop
with a clear error and leaves the local tree clean for manual resolution.

---

## Test runner concurrency

`npm test` (via [`.agents/scripts/run-tests.js`](../scripts/run-tests.js))
derives `--test-concurrency` from `os.availableParallelism()` at startup,
clamped into the `[TEST_CONCURRENCY_MIN, TEST_CONCURRENCY_MAX]` range of
`[1, 16]` (`resolveTestConcurrency`). The clamp keeps the value sane at
both extremes: on the GitHub Actions 2-vCPU runner the derived value
matches the host instead of leaving wall-clock on the table, and on
very-wide dev hosts the cap of 16 bounds the filesystem-race surface
from shared FS fixtures (`memfs` mounts, `temp/` snapshot dirs, the
`coverage/` artifact directory shared with the CRAP gate).

The coverage run is the exception: `npm run test:coverage`
([`.agents/scripts/run-coverage.js`](../scripts/run-coverage.js))
still pins `--test-concurrency=8` so coverage timings stay comparable
across hosts. That fixed 8 sits in the same neighborhood as the cap=8
orchestration helpers (`SUBTICKET_HYDRATION_CONCURRENCY`, and
historically the since-deleted wave-gate helper, removed in PR #3936)
that settled on 8 as the project house-style ceiling. Any change to the
clamp bounds or the coverage pin must be paired with a benchmark run on
both a Windows dev host and a GitHub Actions runner to confirm it
doesn't reintroduce concurrency flakes.

---

## Coverage baseline gate

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

`npm run test:coverage` drives
[`.agents/scripts/run-coverage.js`](../scripts/run-coverage.js),
which runs the unit-test suite with `NODE_V8_COVERAGE` set, post-processes
the V8 dumps with `c8 report`, then delegates to
[`.agents/scripts/check-baselines.js`](../scripts/check-baselines.js)
for the gate decision. There is no global `lines/branches/functions`
threshold — the gate compares **per-file** coverage in
`coverage/coverage-final.json` against the floors recorded in
[`baselines/coverage.json`](../../baselines/coverage.json) and fails on:

- a regression on any axis (lines, branches, or functions) for any file
  whose coverage dropped more than `0.01` percentage points below its
  recorded floor;
- an in-scope file with no baseline entry (a brand-new untested CLI
  shell would otherwise sail through with 0 % coverage and no recorded
  floor to drop below).

Scope (include/exclude) and reporters are declared in
[`.c8rc.cjs`](../../.c8rc.cjs); the gate reads the same file so `c8 report`
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
- `.agents/scripts/hydrate-context.js` — thin wrapper around the
  unit-tested hydration engine; end-to-end coverage requires a real
  provider tree and Story prompt context, which lives in integration
  tests.
- `plan-context.js`, `plan-persist.js`, `epic-plan-healthcheck.js` —
  `/plan` CLI shells with no unit-test seam; the meaningful
  orchestration logic lives in `lib/orchestration/plan-context.js`,
  `lib/orchestration/plan-persist/*`, and the plan phase modules, and is
  unit-tested there.
- A larger Story #1702 carve-out of top-level CLI gates, orchestration
  CLIs, git-manipulation CLIs, and `lib/*` glue (e.g. `lint-baseline.js`,
  `story-close.js`, `dispatcher.js`, `run-tests.js`,
  `lib/config-schema.js`) — see the `.c8rc.cjs` header comment for the
  per-category rationale and the authoritative entry list.

Each excluded file also carries `/* node:coverage ignore file */` at
the top of its source as a second line of defence; the full
justification for each exclusion lives in the header comment of
[`.c8rc.cjs`](../../.c8rc.cjs) and MUST be updated when the list changes.

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

The floors are declared in [`.agentrc.json`](../../.agentrc.json) under
`delivery.quality.gates.<gate>.floors.*` (defaults baked into the helper
match the table above) and resolved at runtime by the shared
helper [`lib/orchestration/check-baselines/phases/floors.js`](../scripts/lib/orchestration/check-baselines/phases/floors.js).
All three gates run through `check-baselines.js` (coverage,
maintainability, crap), which invokes the floors phase **after** the
ratchet decision so a file that's below floor but matched the (stale)
baseline still trips the gate.

### When the floor gate fires

- **Pre-push** (`.husky/pre-push`): diff-scoped, fast path only —
  `quality-preview.js --changed-since origin/main` (MI + CRAP preview),
  then `coverage-capture.js` and `npm run crap:check` (unified
  dispatcher, diff-scoped via `delivery.quality.gateScoping`). Full-repo
  lint, docs generation checks, and the complete test suite are **not**
  run on push; use `npm run verify` locally before a PR. CI enforces the
  authoritative full gate set on every PR.
- **CI** (`.github/workflows/ci.yml`): the `validate` job runs
  **Lint and Format** (`npm run lint`), a **Maintainability Check**
  (`npm run maintainability:check` → `check-baselines.js --gate
  maintainability`, diff-scoped on PRs via
  `delivery.quality.gateScoping`, full scope on push-to-main via
  `BASELINE_SCOPE=full`), and **Run Tests with Coverage**
  (`npm run test:coverage`), uploading the `test-results` and
  `coverage-final` artifacts. A separate required **baselines** job runs
  the unified `node .agents/scripts/check-baselines.js --format text`,
  which enforces floors across every configured gate.

### Opt-out

There is no floor opt-out flag on the check path. The `*:update`
baseline-snap scripts snapshot whatever the current numbers are without
floor enforcement **by construction** — they are writers, not gates —
so no disable switch exists or is needed (the floors phase at
[`lib/orchestration/check-baselines/phases/floors.js`](../scripts/lib/orchestration/check-baselines/phases/floors.js)
has no off switch).

### No silent excludes (`.c8rc.cjs` policy)

The floor gate is only as strict as its scope, so the `exclude` list in
[`.c8rc.cjs`](../../.c8rc.cjs) carries three hard requirements that are
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
the qualitative anti-thrashing cues in
[`.agents/instructions.md`](../instructions.md) are tripped, the
friction logger flips the Story to `agent::blocked` and
posts a structured `friction` comment on the Task so the operator has
the trace.

---

## Per-Story acceptance self-eval gate

After a Story's implementation commits land and **before** the Story
proceeds to close, delivery runs a bounded acceptance self-eval loop
(Step 1a of
[`helpers/epic-deliver-story`](../workflows/helpers/epic-deliver-story.md)
and `helpers/single-story-deliver`; the shared per-round mechanic lives
in
[`helpers/acceptance-self-eval`](../workflows/helpers/acceptance-self-eval.md),
with the gate CLI at
[`.agents/scripts/acceptance-eval.js`](../scripts/acceptance-eval.js)).
Each round, a fresh-context **critic pass** — independent of the
implementing agent — scores the working diff against every inline
`acceptance[]` item, using `verify[]` output as evidence, and yields one
of three decisions:

- **proceed** — all criteria met; the Story continues to close.
- **redraft** — unmet criteria are redrafted and re-implemented, then
  re-evaluated in the next round.
- **block** — criteria remain unmet after the round cap; the Story
  escalates to the blocked path (`agent::blocked`) for operator review.

The loop is always on (hard cutover, no enable flag) and bounded by
`delivery.acceptanceEval.maxRounds` (default 2, clamped to a minimum of
1 so the cap cannot be disabled). This gate is complementary to the
close-validation chain above: that chain proves the code is *healthy*;
this loop proves it satisfies *this Story's* acceptance criteria. See
[`.agents/docs/configuration.md`](../docs/configuration.md) for
the `delivery.acceptanceEval` field reference.

---

## Lint baseline ratchet

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

The lint baseline engine enforces zero-deterioration during Epic
workflows. Integrations fail if new lint warnings are introduced, and the
baseline automatically tightens when the codebase improves.

The canonical baseline file lives at `baselines/lint.json` (override via
`delivery.quality.gates.lint.baselinePath`). Refresh with:

```bash
node .agents/scripts/lint-baseline.js capture
```

Refresh commits should use a `baseline-refresh:` subject + non-empty body so
the operator can spot baseline edits in review — same convention as the CRAP
and maintainability ratchets. The CI guardrail that mechanically enforced
this was removed in a pre-npm-era release; the operator is now the gate.

---

## Maintainability ratchet

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

A per-file maintainability scoring engine computes composite scores based
on cyclomatic complexity, file length, and dependency counts. The
`baselines/maintainability.json` baseline prevents score degradation
between Epics.

Refresh with `npm run maintainability:update`.

`delivery.quality.gates.maintainability.targetDirs` controls the scanned
directories — defaults to `["src"]`, accepts `{ "append": [...] }` /
`{ "prepend": [...] }` for additive overrides.

---

## CRAP gate — Consumer onboarding

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

A sibling per-method gate alongside the maintainability ratchet. CRAP
scores each JavaScript method via `c² · (1 − cov)³ + c`, combining
`typhonjs-escomplex` cyclomatic complexity with per-method coverage from
the `coverage/coverage-final.json` artifact your test runner already
produces. No new runtime dependencies. Runs at three sites:
`close-validation` (story close), `ci.yml` (push + PR), and
`.husky/pre-push`.

If you're a consumer repo that installed the framework via the
`mandrel` npm package (`mandrel sync`), this is what you need to know.

### First-run behavior — bootstrap before the first push

As of Story #791 the gate is hard-enforcing across all three firing sites
(close-validation, pre-push, CI). With `crap.enabled: true` and no
`baselines/crap.json` on disk, the CRAP gate (`npm run crap:check`)
prints:

```text
[CRAP] ❌ no baseline found — run the matching baseline-update command and commit with a 'baseline-refresh:' subject to bootstrap
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
  "delivery": {
    "quality": {
      "gates": {
        "crap": { "enabled": false }
      }
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
  "delivery": {
    "quality": {
      "gates": {
        "crap": {
          "targetDirs": { "append": ["packages/foo/src", "packages/bar/src"] }
        }
      }
    }
  }
}
```

`{ "append": [...] }` and `{ "prepend": [...] }` are the deep-merge forms.
Passing a plain array replaces the default entirely — useful when you
want exactly your dirs and not the framework's. Unknown keys under
`delivery.quality.gates.crap` warn but don't fail resolution, so you can
extend forward-compatibly.

### Interpreting the JSON report

`npm run crap:check` runs the unified dispatcher
(`check-baselines.js --gate crap`), which emits its structured report on
**stdout** — `--format json` is the default (pass `--format text` for the
human-readable summary). There is no file-writing flag; to capture a file
artifact, redirect:

```bash
npm run crap:check > temp/crap-report.json
```

CI does **not** upload a `crap-report` artifact — `ci.yml` uploads only
`test-results` (the test/coverage run log) and `coverage-final`
(`coverage/coverage-final.json`).

The JSON envelope is the unified check-baselines report (see
[`lib/orchestration/check-baselines/phases/report.js`](../scripts/lib/orchestration/check-baselines/phases/report.js)):
top-level totals (`totalBreaches`, `totalRegressions`,
`kernelDriftCount`, `schemaErrors`) plus a `gates[]` array where each
gate entry carries its `kind`, breach/regression counts,
kernel-version match info, and per-`components[]` floor `violations[]`
(`axis`, `value`, `floor`, `direction`).

### Refreshing the baseline (when the drift is justified)

`npm run crap:update` regenerates `baselines/crap.json`. The refresh
should land in a commit whose:

1. Subject starts with the configured `refreshTag` (default
   `baseline-refresh:`).
2. Body is non-empty and explains why the refresh is justified.

The CI guardrail that mechanically rejected unlabeled baseline edits was
removed in a pre-npm-era release alongside the bot-approver pipeline. The convention is
preserved so the operator can grep refresh commits in PR diff, but
self-policing is the operator's job during `/deliver`'s Phase 7
watch loop — an unjustified baseline ratchet is no longer caught by CI.

---

## Bundle-size ratchet — one-shot refresh/acknowledge (Story #151)

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

`check-baselines --gate bundle-size` is a **strict** ratchet: it diffs the
branch's committed `baselines/bundle-size.json` (head) against the base
ref's copy (`origin/main` by default) using the gate's configured
`tolerance`, and separately checks the head aggregate against `floors`.
Unlike `coverage` / `crap` / `maintainability`, bundle-size has **no
scorer of its own** — the measured `rawKb` / `gzippedKb` numbers come from
whatever build step the consumer already runs, not a source-tree rescan —
so there is no `refreshBaseline({ kind: 'bundle-size', ... })` path to
regenerate a "corrected" baseline the way `npm run crap:update` does.

This makes an **intentional** bundle-size growth (a framework major bump,
a new dependency, an SSR runtime swap) impossible to land cleanly with the
usual levers: permanently raising `tolerance` in `.agentrc.json` disables
the ratchet for every *future* PR too, not just the one that legitimately
grew.

### `BUNDLE_SIZE_REFRESH=1`

Set the environment variable for the one CI/local run that needs to land
the growth:

```bash
BUNDLE_SIZE_REFRESH=1 npm run bundle-size:check
# or, calling the dispatcher directly:
BUNDLE_SIZE_REFRESH=1 node .agents/scripts/check-baselines.js --gate bundle-size
```

When set (`1` or `true`, case-insensitive), every `bundle-size`
head-vs-base regression is demoted to `unchanged` **for that invocation
only** — the gate compares head-vs-head in effect, so it passes even
though the committed baseline grew. **Floors still apply**: an
acknowledged PR can still fail if the head aggregate breaches the
configured `floors` budget, so a genuinely runaway regression isn't
silently waved through under the guise of "intentional".

Commit the regenerated `baselines/bundle-size.json` (reflecting the real,
larger sizes) in the same PR so the new numbers become the base for the
*next* PR's diff.

### The ratchet returns to full strength automatically

`BUNDLE_SIZE_REFRESH` is read fresh on every invocation and is **never
persisted** — no config write, no committed tag, no lingering state. The
very next `check-baselines --gate bundle-size` run (i.e. the next PR),
without the env var set, re-enforces the ratchet at full strength against
the now-larger committed baseline. There is nothing to remember to reset.

This mirrors the `CRAP_TOLERANCE` env-override precedent (see
[CRAP gate — Consumer onboarding](#crap-gate--consumer-onboarding) above),
but as a true one-shot acknowledgment rather than a run-scoped tolerance
override: `CRAP_TOLERANCE` changes the *threshold*, `BUNDLE_SIZE_REFRESH`
demotes the *outcome* of an already-flagged regression, which is the
correct shape for a gate with no rescoring path of its own.

---

## HITL blocker escalation

`risk::high` is informational/planning metadata only. Runtime execution
does not pause automatically on `risk::high`.

The sole runtime HITL pause point is `agent::blocked`: when an agent
encounters an unresolvable blocker (including unsafe destructive actions
lacking explicit authorization), it flips the ticket/Epic to
`agent::blocked`, posts friction context, and waits for operator resume
(`agent::executing`).

`planning.riskHeuristics` remains the rubric for identifying
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

---

## Baseline reference

This is the authoritative reference for the canonical baseline shape used
by every quality gate in the framework — `lint`, `coverage`, `crap`,
`maintainability`, `mutation`, `lighthouse`, and `bundle-size`. It covers
the envelope, the per-kind shapes, the component model, how paths are
canonicalised, the writer/reader contract, how consumers override floors,
and how kernel-version drift surfaces as friction. The runbook sections
above describe the runtime behaviour of each gate (when it fires, what it
asserts, how to refresh); this section is the data-shape contract those
gates read and write.

Cross-references:

- [`.agents/docs/configuration.md`](../docs/configuration.md) — the `.agentrc.json`
  configuration surface that backs the gates.
- [`.agents/README.md`](../README.md) — consumer onboarding.

> The `mutation` gate ships **dormant** (built-but-unwired, intentionally
> opt-in). The former `update-mutation-baseline.js` refresh CLI was retired
> with the rest of the zero-consumer script surface (#4482); the
> `lib/mutation/` snapshot machinery remains for a future activation.

### Envelope

Every baseline file under `baselines/<kind>.json` shares the same
top-level envelope:

```json
{
  "$schema": ".agents/schemas/baselines/<kind>.schema.json",
  "kernelVersion": "1.1.0",
  "generatedAt": "2026-05-15T19:30:00.000Z",
  "rollup": {
    "*": { "<axis>": <number>, "...": <number> }
  },
  "rows": [
    { "path": "<repo-relative-path>", "<axis>": <number>, "...": <number> }
  ]
}
```

| Field           | Purpose                                                           |
| --------------- | ----------------------------------------------------------------- |
| `$schema`       | Per-kind JSON Schema path. Drives validation in the shared AJV.   |
| `kernelVersion` | Version stamp of the writer that produced the file. See below.    |
| `generatedAt`   | ISO 8601 timestamp; advisory — not load-bearing for gate logic.   |
| `rollup`        | Per-component aggregate keyed by component name. `*` is required. |
| `rows`          | Sorted, canonicalised per-file (or per-route/per-bundle) entries. |

The schemas live under [`.agents/schemas/baselines/`](../schemas/baselines/).
The shared AJV instance is built by `buildBaselineSchemaAjv()` in
[`.agents/scripts/lib/baseline-schema-registry.js`](../scripts/lib/baseline-schema-registry.js).

### Per-kind shapes

Each kind contributes a `rows[]` schema and a `rollup` axis set. The
authoritative declarations live in the per-kind modules at
[`.agents/scripts/lib/baselines/kinds/`](../scripts/lib/baselines/kinds/):

| Kind              | Key field | Row axes                                                       | Rollup axes                              |
| ----------------- | --------- | -------------------------------------------------------------- | ---------------------------------------- |
| `lint`            | `path`    | `errorCount`, `warningCount`                                   | `errorCount`, `warningCount`             |
| `coverage`        | `path`    | `lines`, `branches`, `functions`, `statements`                 | `lines`, `branches`, `functions`         |
| `crap`            | `path`    | `method`, `startLine`, `crap`                                  | `max`, `p95`, `methodsAboveCeiling`      |
| `maintainability` | `path`    | `maintainability`                                              | `min`, `p50`, `p95`                      |
| `mutation`        | `path`    | `score`, `killed`, `survived`, `noCoverage`, `timeout`, `total`| `score`, `survived`, `noCoverage`        |
| `lighthouse`      | `route`   | `route`, `performance`, `accessibility`, `bestPractices`, `seo`| per-category scores                      |
| `bundle-size`     | `bundle`  | `bundle`, `bytes`, `gzippedBytes`                              | `bytes`, `gzippedBytes`                  |

The `keyField` is the per-row identifier the writer canonicalises and the
component grouper matches against (see below). Lighthouse keys rows on
`route`; bundle-size keys on `bundle`; every other kind keys on `path`.

### Component model

A component is a named bucket of rows that share a floor and a tolerance.
Components let an operator slice a baseline so per-component floors can
be evaluated independently (e.g. `api`, `worker`, `infra` each with its
own coverage floor).

Shape:

```json
"components": {
  "<name>": ["<glob>", "<glob>", "..."]
}
```

Rules:

- The component literally named `*` is the **whole-repo bucket** and
  captures every row regardless of declared globs. Every baseline emits
  `rollup['*']` for backwards compatibility with pre-component gates.
- Glob matching uses
  [`minimatch`](https://github.com/isaacs/minimatch) with `dot: true`.
- **Overlap is allowed by design** — a row matched by two components is
  reported under both.
- When a gate omits `components`, the default is `{ "*": ["**"] }`. The
  resolver lives in
  [`.agents/scripts/lib/baselines/components.js`](../scripts/lib/baselines/components.js)
  (`resolveComponents` + `groupRows`).

### Path canonicalisation

Every path-like field in a baseline (`rows[].path`, `rows[].route`,
`rows[].bundle`) is canonicalised to a forward-slashed, repo-relative
form before it is written:

- Windows backslashes are normalised to forward slashes.
- Leading `./` is stripped.
- A `.worktrees/<workspace>/` prefix — which would leak into a hand-edit
  made inside a story worktree — is stripped.
- Absolute paths are rejected (the writer throws rather than silently
  rewrite identity).

The canonicaliser lives at
[`.agents/scripts/lib/baselines/path-canon.js`](../scripts/lib/baselines/path-canon.js).
The reader applies a defensive second pass (`canonicaliseRowPath`) when
loading so downstream consumers never have to special-case the worktree
prefix.

### Writer/reader contract

The single funnel for **writing** a baseline is
[`.agents/scripts/lib/baselines/writer.js`](../scripts/lib/baselines/writer.js)
— `write({ kind, rows, components, kernelVersion?, generatedAt? })`:

1. Resolve the per-kind module from the kernel registry.
2. Project every row through `projectRow` (which canonicalises the key
   field and asserts the result with `assertCanonical`).
3. Sort the rows deterministically for stable on-disk diffs.
4. Compute the per-component rollup, always including `*`.
5. Stamp `$schema`, `kernelVersion`, and `generatedAt` via
   `buildEnvelope`.
6. Validate the envelope against the per-kind schema via the shared AJV.
7. Return the envelope. `writeFile(absPath, envelope)` is the separate
   serialise + atomic-rename seam.

The single funnel for **reading** a baseline is
[`.agents/scripts/lib/baselines/reader.js`](../scripts/lib/baselines/reader.js)
— `reader.load(kind, { cwd?, configPath? })`:

1. Resolve the on-disk path from `delivery.quality.gates.<kind>.baselinePath`,
   falling back to the canonical default (`baselines/<kind>.json`).
2. Read the file as UTF-8 JSON.
3. Validate against the per-kind schema.
4. Apply the defensive path canonicalisation pass to `rows[]`.
5. Return `{ rollup, rows, kernelVersion, generatedAt }`.

Every gate reads through this module — the unified
[`check-baselines.js`](../scripts/check-baselines.js) dispatcher
(whose per-kind gate logic lives in
[`.agents/scripts/lib/baselines/kinds/`](../scripts/lib/baselines/kinds/)
— `lint.js`, `coverage.js`, `crap.js`, `maintainability.js`,
`mutation.js`, etc.), the audit-suite delta emitter, and the
per-component drift signals. No gate opens
`JSON.parse(readFileSync(...))` of a baseline directly.

`loadFile(absolutePath, { kind? })` is the same contract for ad-hoc
fixture paths; the kind is inferred from `$schema` when not supplied.

### Floor overrides

Consumers override floors per gate in `.agentrc.json` under
`delivery.quality.gates.<kind>`:

```json
{
  "delivery": {
    "quality": {
      "gates": {
        "coverage": {
          "floors": {
            "*": { "lines": 90, "branches": 85, "functions": 90 },
            "api": { "lines": 95, "branches": 90, "functions": 95 }
          },
          "components": {
            "api": ["src/api/**", "src/server/**"]
          }
        }
      }
    }
  }
}
```

Behaviour:

- `floors['*']` is the whole-repo floor. Every gate falls back to `*`
  when a component-scoped floor is not declared.
- A per-component floor overrides `*` for that component only. Other
  components still inherit `*`.
- The `components` map is optional. When omitted, the default
  `{ "*": ["**"] }` applies and only `*` rows are ever evaluated.
- The unified `check-baselines.js` reports breaches per component, with
  `*` always present in the output. The per-component progress signals
  (`crap-drift.js#detectComponentRegressions`,
  `maintainability-drift.js#detectComponentRegressions`) name the
  breached component in their bullet so a `*` rollup is not falsely
  implicated when only a component-scoped floor was crossed.

#### Floor axes must match rollup axes

A configured floor axis is only enforced when the rollup actually exposes
that axis — `check-baselines.js#compareToFloor` skips axes whose value is
missing from the rollup. As of Story #2193, the unified dispatcher
**fails closed** when a configured floor axis is absent from the rollup:
the gate exits non-zero with an actionable error naming the missing axis
and listing the available rollup keys (so a typo like
`{ maintainability: 70 }` against the maintainability rollup — which
exposes `min` / `p50` / `p95` — surfaces immediately instead of silently
passing).

Match the floor axis names to the rollup axes documented in the [Per-kind
shapes](#per-kind-shapes) table above. For maintainability specifically:

```json
{
  "delivery": {
    "quality": {
      "gates": {
        "maintainability": {
          "floors": {
            "*": { "min": 70 }
          }
        }
      }
    }
  }
}
```

The maintainability rollup exposes `min` (lowest per-file `mi`), `p50`
(median), and `p95` (95th percentile); a floor on `min` is the framework
default and enforces a hard lower bound on individual files. Floors keyed
on the legacy `maintainability` axis (which never appears in the rollup)
are rejected with an explanatory error.

For the full configuration surface (every gate-level key with defaults
and types) see [`.agents/docs/configuration.md`](../docs/configuration.md) and the
`delivery.quality.*` section.

#### Shipped surface vs follow-up

The unified [`check-baselines.js`](../scripts/check-baselines.js)
ships **floor + tolerance + schema + kernel-mismatch** logic and is the
**only** baseline gate. Epic #1943 (Story #1981) absorbed the per-kind
regression / scope / git-base-ref logic and deleted the per-kind
`check-<kind>.js` CLIs (no `check-coverage.js`, `check-crap.js`, or
`check-maintainability.js` exists in `.agents/scripts/`; see the
`baselines` job comment in `.github/workflows/ci.yml` and the
Story #2210 note in
`.agents/scripts/lib/close-validation/gates.js`). Consumers wire only
the unified `baselines` status check into branch protection (see
`.agentrc.json` → `github.branchProtection.requiredChecks`).

### Kernel-version friction

Every per-kind module exports a `kernelVersion()` function that returns
the writer's version of the analysis it produces. The writer stamps the
version on the envelope; the reader returns it; the unified gate
compares it against the running kernel.

When `baseline.kernelVersion !== runningKernelVersion`, the gate emits a
`baseline-kernel-mismatch` friction signal (suppressed with
`--no-friction`) but does **not** change its exit code — kernel drift is
advisory. The friction record points the reviewer at the regenerate
workflow for the kind in question.

Refresh paths:

- `npm run test:coverage` then `npm run coverage:update` — rewrites
  `baselines/coverage.json`.
- `node .agents/scripts/update-crap-baseline.js` — rewrites
  `baselines/crap.json`.
- `node .agents/scripts/update-maintainability-baseline.js` — rewrites
  `baselines/maintainability.json`.
- `node .agents/scripts/lint-baseline.js capture` — rewrites
  `baselines/lint.json`.

After a kernel bump, regenerate every baseline whose `kernelVersion`
drifted, then commit the refreshed files. The writer guarantees
deterministic ordering and canonical paths, so the diff is the kernel
delta and nothing else.

### Baseline source of truth

- [`.agents/docs/configuration.md`](../docs/configuration.md) — full `.agentrc.json`
  surface.
- [`.agents/scripts/lib/baselines/`](../scripts/lib/baselines/) —
  source of truth for the writer, reader, kernel registry, components
  resolver, envelope schemas, and per-kind modules.
