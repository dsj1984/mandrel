# Spike: Activating the Dormant Mutation-Testing Gate

> **Status:** Complete. **Verdict: DEFER** (keep dormant, document as
> intentionally opt-in). Follow-up implementation Story is **not** filed
> (see [§ Recommendation](#recommendation) for the re-evaluation trigger).
>
> **Story:** [#3665](https://github.com/dsj1984/mandrel/issues/3665) —
> `spike(baselines): evaluate activating the dormant mutation-testing gate`.

This document records the evaluation of whether and how to activate
Mandrel's existing-but-dormant Stryker mutation-testing gate. It is an
**evaluation/decision artifact**, not an activation. No `stryker.conf.js`,
no `delivery.quality.gates.mutation` config, and no scored mutation
baseline are introduced by this spike — turning the gate on is explicitly
out of scope and deferred.

---

## 1. What already exists (the dormant infrastructure)

The mutation gate is fully built but unwired. The pieces:

| Piece                                                                 | Role                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.agents/scripts/lib/baselines/kinds/mutation.js`                     | Per-kind kernel module: `keyField: 'path'`, `projectRow`, `rollup`, pure `compare`, epsilon/merge. |
| `.agents/scripts/lib/mutation/stryker-runner.js`                      | Spawns `npx stryker run`, parses the JSON report, returns a normalised `byWorkspace` summary.      |
| `.agents/scripts/lib/mutation/config-detector.js`                     | Detects a `stryker.conf.*` / `package.json#stryker` config; absence → skip.                       |
| `.agents/scripts/lib/mutation/baseline-snapshot.js`                   | Reads/writes the **workspace-keyed** baseline envelope (`workspaces['*']`).                        |
| `.agents/scripts/lib/mutation/survivor-report.js`                     | Renders a survivor report from a Stryker run.                                                      |
| `.agents/scripts/update-mutation-baseline.js`                         | Refresh entry point; non-fatal when Stryker is absent (`:96-107`).                                 |
| `lib/baselines/kernel.js` `KIND_MODULES`                              | Registers `mutation` alongside the other kinds.                                                    |
| `lib/orchestration/check-baselines/phases/pipeline.js`                | `selectEnabledGates()` — only runs a kind when `quality.gates[kind]` is a config object.           |
| `lib/orchestration/check-baselines/phases/floors.js`                  | `axisDirection('mutation', …)` — `score` is `gte`, `survived`/`noCoverage` are `lte`.              |
| `baselines/mutation.json`                                             | A **placeholder**: `rollup['*'].score = 0`, `rows: []`. Not a real run.                            |

### Why it is dormant

Two independent conditions keep it off, and **either alone** suffices:

1. **No gate config.** `.agentrc.json` declares only the `crap`,
   `maintainability`, and `duplication` gates under
   `delivery.quality.gates`. `selectEnabledGates()`
   (`pipeline.js:27-37`) iterates `KNOWN_KINDS` and skips any kind whose
   `quality.gates[kind]` is absent or not an object. With no
   `gates.mutation` block, the mutation gate never enters the
   check-baselines pipeline — the committed placeholder baseline is never
   read.
2. **No Stryker config / dependency.** Even the refresh path is inert:
   `runStryker()` calls `detectStrykerConfig()`, finds no `stryker.conf.*`
   and no `package.json#stryker` key, and returns `{ skipped: true }`.
   `update-mutation-baseline.js:96-107` folds that into a non-fatal exit-0
   skip. Stryker is not in `package.json` `devDependencies` and is not
   installed in `node_modules`.

The placeholder `baselines/mutation.json` (committed in Epic #1786, PR
#1948) is therefore decorative: it satisfies the schema registry but is
never consulted while the gate is unconfigured.

---

## 2. Cost measurement

### 2.1 Method (measured vs. extrapolated)

A full Stryker run reruns the affected test set **once per mutant**. The
two cost drivers are therefore (a) the **mutant count** generated over the
target source and (b) the **per-mutant suite time**. Running a true full
Stryker baseline over `.agents/scripts` would be a multi-hour job (see the
extrapolation below) and Stryker is not even installed here, so per the
spike's bounded-sample allowance the numbers below are split into:

- **Measured** (this host, `node v24.15.0`, npm 11.12.1, Apple Silicon):
  test-suite wall-clock and source-size inputs.
- **Extrapolated**: mutant count and total run time, derived from the
  measured inputs using Stryker's published empirical mutant-density and
  `perTest` coverage-analysis behaviour. Every extrapolated figure names
  its assumption.

### 2.2 Measured inputs

| Input                                              | Measured value | How                                                                 |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Production source files under `.agents/scripts`    | **600 files**  | `find … -name '*.js'` excluding `node_modules`, `*.test.js`.        |
| Effective source LOC (non-blank, non-comment-only) | **~19,093**    | `find … | grep -vE '^\s*$' | grep -vE '^\s*(//|\*|/\*)'`.            |
| Test files (under `tests/`, separate tree)         | **747 files**  | `find tests -name '*.test.js'`.                                     |
| Full suite wall-clock (`npm test`)                 | **~36 s**      | runner `duration_ms` 35,957 ms; one clean cold run.                 |
| Quick-tier wall-clock (`npm run test:quick`)       | **~12 s**      | runner `duration_ms` 11,819 ms (451 tests / 45 suites).            |

> **Note on the suite-shape mismatch (important for cost).** Mandrel's
> tests live in a sibling `tests/` tree (747 files), **not** colocated
> with the 600 source files under `.agents/scripts`. The Node test runner
> runs the *whole* suite as one process tree in ~36 s; there is no
> per-source-file test partition that Stryker's `perTest` analysis can
> exploit cheaply, because the project does not declare a Stryker `testRunner`
> mapping. This materially raises the per-mutant cost vs. a colocated
> unit-test layout (see §2.4).

### 2.3 Extrapolated mutant count

Stryker's JS mutators (arithmetic, conditional, boundary, string-literal,
block-removal, etc.) empirically generate **~1 mutant per 3–4 effective
LOC** on typical JavaScript. Applying that band to ~19,093 effective LOC:

| Density assumption        | Estimated mutants |
| ------------------------- | ----------------- |
| 1 mutant / 4 eff. LOC     | **~4,800**        |
| 1 mutant / 3 eff. LOC     | **~6,400**        |

Call it a **~5,000–6,500 mutant** working range for the full
`.agents/scripts` target. (Extrapolated; not measured.)

### 2.4 Extrapolated wall-clock

Two regimes, depending on whether `perTest` coverage analysis can isolate
the covering tests for each mutant:

- **`coverageAnalysis: 'off'` (worst case — reruns the full suite per
  mutant).** ~36 s × ~5,500 mutants ≈ **~55 hours** of pure test execution
  (single-worker). Even with `concurrency: 8`, that is **~7 hours**
  wall-clock, before compile/instrument overhead. Untenable.
- **`coverageAnalysis: 'perTest'` (best realistic case).** Stryker reruns
  only the tests that cover each mutant. With a colocated unit suite this
  typically cuts per-mutant time by 10–100×. **But** Mandrel's suite is not
  partitioned per source file (§2.2 note), and the Node built-in test
  runner is not a first-class Stryker `testRunner`. Realistically the
  per-mutant cost lands at a **few seconds** (covering-test subset +
  per-mutant overhead), i.e. **~5,500 mutants × ~3 s ≈ ~4.5 hours**
  single-worker, or **~30–60 minutes** wall-clock at `concurrency: 8` on a
  warm machine — **with a custom Stryker `@stryker-mutator/…` test-runner
  plugin that does not exist for the Node built-in runner today.**

**Bottom line on cost:** a full `.agents/scripts` mutation baseline is a
**tens-of-minutes-to-multi-hour** job under the most favourable realistic
configuration, and that favourable configuration is not currently
reachable without first writing/adopting a Stryker test-runner integration
for `node --test`. This is the central affordability finding.

---

## 3. Fit assessment: workspace-keyed baseline vs. Mandrel's layout

The acceptance criteria call out a specific tension between the two
key-models in the mutation code, and the spike confirms it is **real**:

### 3.1 The kernel keys mutation rows by `path`

`kinds/mutation.js` declares `keyField = 'path'` and `projectRow` emits
`{ path, score, killed, survived }`. `compare()` diffs rows by `path`,
`rollup()` groups by component **path** match, and `floors.js`
`axisDirection('mutation', …)` enforces per-component floors. `docs/baselines.md`
documents `mutation` as a **`path`-keyed** kind (row axes
`score/killed/survived/noCoverage/timeout/total`). So the *check* side is
**file/path-keyed**, exactly like `coverage`, `crap`, and `maintainability`.

### 3.2 The refresh writer keys by `workspace`

`baseline-snapshot.js` writes a different envelope shape —
`{ generatedAt, tolerancePct, workspaces: { '*': <score> } }` — keyed by
**workspace name**, not path. `stryker-runner.js` `summariseReport()`
returns `byWorkspace: { '*': mutationScore }` (a single repo-wide score),
and `update-mutation-baseline.js:141-149` explicitly documents `--diff-scope`
as a **no-op** "because mutation baseline is workspace-keyed (not
file-keyed)."

### 3.3 The mismatch, and what it means for a single-package repo

There are **two baseline shapes** for one kind:

- The **kernel/check shape** (`kernel.js`-validated `baselines/mutation.json`
  with `rollup` + per-`path` `rows[]`) — what `check-baselines` reads.
- The **refresh/snapshot shape** (`{ workspaces }`) — what
  `update-mutation-baseline.js` writes.

These do not currently agree. The committed `baselines/mutation.json` is in
the **kernel shape** (`rollup`/`rows`), but `update-mutation-baseline.js`
would overwrite it with the **snapshot shape** (`workspaces`). For Mandrel
specifically:

- Mandrel is a **single-package** repo. A workspace-keyed score collapses
  to exactly one number under `workspaces['*']` — it carries **zero**
  per-file resolution. A regression in one script is invisible if the
  repo-wide average holds.
- The kernel path-keyed shape is the right fit for a single package: it
  gives per-file rows and per-component rollups (e.g. floor
  `.agents/scripts/lib/orchestration/**` separately), which is what an
  operator actually wants to ratchet.

**Fit verdict:** Mandrel should use **file/path keying** (the kernel shape),
**not** the workspace-keyed snapshot writer. Activation would first require
reconciling `update-mutation-baseline.js` + `baseline-snapshot.js` to emit
the `path`-keyed `rows[]`/`rollup` envelope the kernel already expects (or
deleting the snapshot-shape writer in favour of a kernel-shape writer like
the other kinds use). This reconciliation is **non-trivial implementation
work** and is part of why activation is not a small change.

---

## 4. Affordability strategy (the design, if/when activated)

Even though the recommendation is to defer, the spike must specify the
strategy that activation *would* take, so a future implementer inherits a
decision rather than a blank slate:

1. **Placement: nightly `schedule` only — never per-PR.** At
   tens-of-minutes-to-hours, the gate cannot sit on the PR or pre-push
   path without destroying iteration latency. Model it on the existing
   **Install Matrix** split (`.github/workflows/install-matrix.yml`): a
   non-blocking nightly `schedule` + `workflow_dispatch` leg that runs the
   full baseline and surfaces survivors, with **no** `pull_request`
   trigger. The PR-time `check-baselines` gate would consume the
   nightly-produced `baselines/mutation.json` as a **ratchet** (compare
   only; do not regenerate), so PRs pay a cheap JSON-read, not a Stryker
   run.
2. **Scoping: `targetDirs: ['.agents/scripts']`.** Mirror the `crap` /
   `maintainability` / `duplication` gates — mutate only production source,
   never `tests/`.
3. **Coverage analysis: `perTest`** — mandatory to make even the nightly
   run finish, and contingent on a `node --test` Stryker runner
   integration existing (it does not today; this is a prerequisite work
   item).
4. **Per-mutant timeout: `timeoutMS: 10000` + `timeoutFactor: 1.5`.**
   `stryker-runner.js` already defaults the *whole-run* gate timeout to
   15 min (`DEFAULT_TIMEOUT_MS`); that is a process-level guard, not the
   per-mutant Stryker timeout, which must be set in `stryker.conf.js`.
5. **Differential/incremental: `--incremental`.** Use Stryker's incremental
   mode (`incremental: true`, `.stryker-tmp/incremental.json`) so nightly
   reruns only re-mutate changed files — turning the steady-state nightly
   cost from "full ~hours" into "delta minutes" after the first seed run.
6. **Floor + tolerance (proposed `delivery.quality.gates.mutation`):**

   ```jsonc
   "mutation": {
     "floors": { "*": { "score": 60, "survived": 0, "noCoverage": 0 } },
     "targetDirs": [".agents/scripts"],
     "tolerance": { "kind": "absolute", "value": 3 }
   }
   ```

   - `score` floor `60` is a deliberately **soft seed** — set it to ~5 pts
     below the *first measured* repo-wide score, not a guess, on activation.
     (60 is a placeholder pending a real first run; do **not** commit it
     blind.)
   - `survived`/`noCoverage` floors are `lte` axes (`floors.js`), so `0`
     here means "do not *increase* survivors/no-coverage versus baseline";
     the kernel `compare` enforces the ratchet, the floor enforces the
     absolute ceiling.
   - `tolerance.value: 3` (pct points) matches the `maintainability` /
     `duplication` tolerance idiom and absorbs Stryker's run-to-run
     non-determinism (timeouts flapping to killed) so a 1–2 pt jitter does
     not red a nightly.

---

## 5. Recommendation

**DEFER.** Keep the mutation gate dormant and documented as intentionally
opt-in. Do **not** file a follow-up activation Story at this time.

### Why defer (not "activate now", not "activate nightly-only")

1. **Activation is not a config flip — it is a build.** Three non-trivial
   prerequisites stand between "dormant" and "nightly-only":
   - a Stryker **test-runner integration for `node --test`** (no
     first-party `@stryker-mutator` plugin exists for the Node built-in
     runner; the project does not use Jest/Mocha/Vitest);
   - **reconciling the two baseline shapes** (§3) so the refresh writer
     emits the kernel's `path`-keyed `rows[]`/`rollup` rather than the
     workspace-keyed `{ workspaces }` snapshot;
   - **CI plumbing** for a nightly schedule + incremental cache.

   None of these is a small change, and together they are an Epic-sized
   effort, not a single Story.

2. **Cost is high and the marginal signal is uncertain.** The repo already
   runs a strong quality stack — line/branch **coverage**, **CRAP**,
   **maintainability**, and now **duplication** gates, all path-keyed and
   PR-blocking. Mutation testing's distinctive value (catching
   assertion-free or tautological tests) is real but **incremental** on top
   of an already-high coverage bar, while its cost (hours of compute,
   nightly infra, plugin authoring) is large and front-loaded.

3. **No present forcing function.** The idea surfaced from a comparison to
   `unclebob/swarm-forge`'s "kill all survivors" constitution — an
   aspiration, not a defect report. Nothing in Mandrel's current quality
   posture is failing for want of mutation testing.

### Re-evaluation trigger (when to revisit)

Promote this from "defer" to an activation Epic when **any** of:

- a coverage-gamed regression ships (a bug lands behind a test that
  asserts nothing / was never killing the mutant), demonstrating the gap
  coverage cannot see; **or**
- the project migrates to a test runner with first-party Stryker support
  (Vitest/Jest), erasing prerequisite #1; **or**
- an operator explicitly opts in for a specific high-risk subtree (e.g.
  `lib/orchestration/**`), in which case scope the nightly gate to that
  subtree only and use the §4 config as the starting point.

At that point, file the activation Epic referencing this doc and §4's
proposed config; do **not** commit §4's placeholder `score: 60` floor
without a real first measured run.

### Deferral bookkeeping

Per the spike's "if defer" branch, the dormant code is documented as
intentionally opt-in in two places:

- a code comment near the top of
  [`.agents/scripts/update-mutation-baseline.js`](../.agents/scripts/update-mutation-baseline.js)
  pointing here; and
- this document, linked from
  [`docs/baselines.md`](baselines.md) so the dormant kind is discoverable
  from the baseline reference.

---

## 6. Appendix — reproduction commands

```bash
# Source size (mutant-count basis)
find .agents/scripts -name '*.js' -not -path '*/node_modules/*' \
  -not -path '*/__tests__/*' -not -name '*.test.js' | wc -l            # 600 files
find .agents/scripts -name '*.js' -not -path '*/node_modules/*' \
  -not -path '*/__tests__/*' -not -name '*.test.js' -exec cat {} + \
  | grep -vE '^\s*$' | grep -vE '^\s*(//|\*|/\*)' | wc -l              # ~19093 eff. LOC

# Test-suite wall-clock (per-mutant cost basis)
/usr/bin/time -p npm test            # duration_ms ~35957 (~36 s), 747 test files
/usr/bin/time -p npm run test:quick  # duration_ms ~11819 (~12 s)

# Dormancy confirmation
grep -n "mutation" .agentrc.json || echo "no gates.mutation → gate dormant"
ls node_modules/@stryker-mutator 2>/dev/null || echo "Stryker NOT installed"
```

> A pre-existing, environment-sensitive failure in
> `tests/story-close-cd-out-guard.test.js` (a `github`-block resolution
> assertion) was observed on a clean `main` checkout during this spike. It
> is unrelated to mutation testing and is **not** introduced by this Story
> (which adds documentation only).
