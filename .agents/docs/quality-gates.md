# Quality Gates

This is the consumer-facing reference for the quality gates the framework
runs against your repo: the lint baseline ratchet, the maintainability
ratchet, the CRAP per-method gate, the **absolute quality floors**
(90/85/90 coverage, MI ≥ 70, CRAP ≤ 20), the anti-thrashing protocol,
and the concurrent close-safety retry that protects Story-branch pushes
when multiple Stories close in quick succession.

The floor + ratchet duo is intentional: the ratchet protects against
regressions on touched files; the floor enforces an absolute threshold
on every in-scope file regardless of diff scope. See
[§ Absolute quality floors (Epic #1184)](#absolute-quality-floors-epic-1184)
below for the policy and [`docs/decisions.md`](../../docs/decisions.md) (ADR
20260512-coupling-stance) for the framework-wide stance that motivates
the lift the floor gate represents.

The configuration knobs that drive these gates live in
[`.agents/docs/configuration.md`](../docs/configuration.md) under
`delivery.quality.*`. This file is the runbook side — what the gate does,
when it fires, and how to bootstrap or refresh it.

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

`/mandrel-deliver` may close multiple Stories from separate branches in quick
succession; each rebases onto the latest `main` in its own base-sync phase
(`phases/base-sync.js`) before the push, so concurrent closes serialize
through their own worktrees rather than racing one shared branch. The push
does not retry — a rejected push or a real content conflict fails the close
non-zero and leaves the tree clean for manual resolution. See
[`SDLC.md` § Concurrent close](SDLC.md#concurrent-close).

---

## Test runner concurrency

`npm test` (via [`.agents/scripts/run-tests.js`](../scripts/run-tests.js))
derives `--test-concurrency` from `os.availableParallelism()` at startup,
clamped into `[1, 16]` (`resolveTestConcurrency`). The clamp keeps the value
sane at both extremes: on the GitHub Actions 2-vCPU runner the derived value
matches the host, and on very-wide dev hosts the cap of 16 bounds the
filesystem-race surface from shared FS fixtures (`memfs` mounts, `temp/`
snapshot dirs, the `coverage/` artifact directory shared with the CRAP gate).

The coverage run is the exception: `npm run test:coverage`
([`.agents/scripts/run-coverage.js`](../scripts/run-coverage.js)) pins
`--test-concurrency=8` so coverage timings stay comparable across hosts. Any
change to the clamp bounds or the coverage pin should be validated on both a
Windows dev host and a GitHub Actions runner to confirm it doesn't reintroduce
concurrency flakes.

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

The files-out-of-scope list is declared in [`.c8rc.cjs`](../../.c8rc.cjs) —
thin CLI shells plus the larger Story #1702 carve-out of
top-level/orchestration/git CLIs and `lib/*` glue. The `exclude[]` array is
the **single** declaration: each entry carries its rationale as an inline
comment on the line above it. Story #4922 removed the prose inventory the
header used to duplicate — two copies of one list in one file, 27 files
apart by the time it was measured. Do not reintroduce one. Every excluded
file also carries `/* node:coverage ignore file */` at the top of its source
as a second line of defence.

`.c8rc.cjs`'s `include` globs and `delivery.quality.gates.coverage.targetDirs`
in [`.agentrc.json`](../../.agentrc.json) MUST name the same roots — the gate
scores what c8 measures. `tests/c8rc-scope.test.js` asserts both invariants.

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
| Coverage — lines | ≥ 94 % | repo rollup |
| Coverage — branches | ≥ 85 % | repo rollup |
| Coverage — functions | ≥ 87 % | repo rollup |
| Maintainability Index | ≥ 70 | repo rollup |
| CRAP — methods above 20 | ≤ 13 | repo rollup |

Floors are enforced against the baseline's `rollup` components — the
`applyFloors` phase compares `rollup["*"]` (and any named component), never
individual rows. Story #4922 corrected this table, which previously read
"per file" and quoted 90/85/90 for coverage; those numbers came from the
example in `.agents/docs/agentrc-reference.json`, which is validated only
against itself, and the coverage gate was not configured at all.

The live coverage floors are derived from the measurement in
[`baselines/coverage.json`](../../baselines/coverage.json) — a full-tier run
scored 95.65 / 86.16 / 88.52, and each floor sits ~1–1.7 points under its
axis. Re-derive them, do not invent them, whenever the baseline is
regenerated wholesale.

The coverage gate deliberately declares **no `tolerance`**, so its
head-vs-base ratchet arm reports regressions without failing the build (the
same shape the `crap` gate uses). Story #4922's scope was making the
instrument honest; arming the ratchet belongs with the debt burn-down that
the widened measurement newly exposes.

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
  **Lint and Format** (`npm run lint`) and **Run Tests with Coverage**
  (`npm run test:coverage`), uploading the `test-results` and
  `coverage-final` artifacts. A separate required **baselines** job runs
  the unified `node .agents/scripts/check-baselines.js --format text`,
  which enforces floors across every configured gate and is the only
  baseline gate on the per-change path. (Story #5004 removed a
  `Maintainability Check` step from `validate` that re-ran
  `check-baselines.js --gate maintainability` at the same scope; a later
  correction pass revisited its record of what the step's
  `BASELINE_SCOPE=full` branch did — see `docs/ci-contract.md`.)
- **Nightly** (`.github/workflows/baseline-drift.yml`): the only
  automated **full-scope re-score**. See
  [`check-baseline-drift.js`](#check-baseline-driftjs--the-scheduled-full-scope-re-score)
  below.

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

1. **One-line rationale per entry.** Every file in `exclude[]` MUST carry
   an inline comment on the line(s) directly above it naming *why* it is
   excluded — typically "thin CLI shell, meaningful logic lives in
   `lib/<X>` and is unit-tested there." A bare path with no rationale is a
   review-block, and `tests/c8rc-scope.test.js` fails on one.
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

---

## Anti-thrashing protocol

The qualitative anti-thrashing cues are owned by
[`.agents/instructions.md`](../instructions.md) § 1.I. When they trip, the
friction logger flips the Story to `agent::blocked` and posts a structured
`friction` comment on the Story so the operator has the trace.

---

## Per-Story acceptance self-eval gate

After a Story's implementation commits land and **before** it proceeds to
close, delivery runs a bounded acceptance self-eval loop: a fresh-context
critic scores the caller-injected change set against every inline
`acceptance[]` item (using `verify[]` output as evidence) and yields
**proceed** / **redraft** / **block**. This gate is complementary to the
close-validation chain above — that chain proves the code is *healthy*, this
loop proves it satisfies *this Story's* acceptance criteria. The per-round
mechanic is owned by
[`helpers/acceptance-self-eval`](../workflows/helpers/acceptance-self-eval.md)
(Step 1a of [`helpers/deliver-story`](../workflows/helpers/deliver-story.md));
the `delivery.acceptanceEval` field reference is in
[`configuration.md`](../docs/configuration.md).

---

## Lint baseline ratchet

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

The `lint` baseline kind enforces zero-deterioration during Story
delivery: `check-baselines.js --gate lint` fails if new lint warnings are
introduced, and the baseline tightens when the codebase improves.

The canonical baseline file lives at `baselines/lint.json` (override via
`delivery.quality.gates.lint.baselinePath`).

**There is no framework capture CLI.** Story #5004 retired the
`lint-baseline.js` shell that used to write this file: it spawned a
configured lint command and parsed the linter's JSON, a shape only
ESLint-style output satisfies, and this repo's own `npm run lint`
(Biome + markdownlint fan-out) never produced it, so the gate was
configured-but-unfed. A consumer that wants the kind writes
`baselines/lint.json` from its own linter in the envelope shape documented
under [Baseline reference](#baseline-reference); a consumer that does not is
unaffected, because an absent baseline leaves the gate unconfigured.

> **Upgrading?** The `project.commands.lintBaseline` key that fed the retired
> shell is gone from the config schema, which is `additionalProperties: false`
> — a `.agentrc.json` still carrying it now **fails validation** rather than
> being silently ignored. Delete the key.

Refresh commits should use a `baseline-refresh:` subject + non-empty body so
the operator can spot baseline edits in review — same convention as the CRAP
and maintainability ratchets. There is no CI guardrail enforcing the
convention; the operator is the gate.

---

## Maintainability ratchet

> Baseline envelope, axes, and component model: see the
> [Baseline reference](#baseline-reference) section below.

A per-file maintainability scoring engine computes composite scores based
on cyclomatic complexity, file length, and dependency counts. The
`baselines/maintainability.json` baseline prevents score degradation
between Stories.

Refresh with `npm run maintainability:update`.

`delivery.quality.gates.maintainability.targetDirs` controls the scanned
directories (see [`configuration.md`](../docs/configuration.md) for the
default and the deep-merge extender form).

---

## Cyclomatic ceiling ratchet

`delivery.quality.codingGuardrails.cyclomaticMustFix` (default `12`) is the
per-function complexity ceiling, enforced by `check-cyclomatic.js`. It is a
**standalone ratchet** — the same slot as `check-arch-cycles.js`,
`check-dead-exports.js`, and `check-context-budget.js` — not a
`delivery.quality.gates` kind, so it needs no gate block and no floor.

```bash
node .agents/scripts/check-cyclomatic.js            # the gate
node .agents/scripts/check-cyclomatic.js --update   # re-record the breaches
```

`baselines/cyclomatic.json` records, per file, how many functions currently
sit above the ceiling and how bad the worst one is. The gate fails when a
file's over-ceiling count rises (including `0 → 1`, a brand-new breach) or
when its worst function gets worse than recorded. Shrinking and disappearing
are the success signals and never fail.

Recording existing breaches is what makes the ceiling adoptable: a repository
with dozens of over-ceiling functions can turn the gate on today and burn them
down on its own schedule, instead of disabling a gate that fails on the first
commit. Re-run `--update` after a deliberate refactor; that is the only motion
allowed to raise a recorded count, and it shows up in review as a baseline
diff.

The scan reuses `delivery.quality.gates.maintainability.targetDirs` /
`ignoreGlobs` — both instruments read the same coverage-free escomplex
surface, so a separate scope declaration could only ever restate it.

`cyclomaticFlag` (default `8`) is the softer half of the pair: it is not
gated, and names the ceiling `quality:preview` counts new methods against in
its `new-method count over c=<flag>` column.

---

## Gherkin corpus gate (opt-in)

`check-gherkin-corpus.js` is a static gate over a project's `.feature` corpus.
It runs inside `npm run lint` — the same required check as the arch-cycle
ratchet — and it enforces two things:

- **must-compile.** Every in-scope `.feature` is parsed with the real
  `@cucumber/gherkin` parser and a failure is reported at `file:line:column`.
  Re-implementing acceptance is the defect the gate exists to prevent: a
  hand-rolled reader skips what it does not recognise, so a corpus that cannot
  generate reads clean.
- **must-bind.** Every active scenario's steps are resolved against the step
  definitions of **its own scope only**. A file that fails must-compile is
  excluded from must-bind — a broken file parses as an arbitrary subset of
  itself, and linting the remainder buries the one actionable finding.

The gate is **opt-in**: with no `qa.gherkinLint` block in `.agentrc.json` it
reports that it is not configured and exits 0, even when `.feature` files
exist on disk. An upgrade must never redden the lint of a corpus the consumer
never asked the framework to police. This repository does not configure it.

```jsonc
"qa": {
  "gherkinLint": {
    "scopes": {
      "web": {
        "featureRoots": ["apps/web/tests/features"],
        "stepRoots": ["apps/web/tests/steps"]
      }
    },
    "exemptionTags": ["@skip"],
    "stepWaivers": []
  }
}
```

Inside the opt-in the gate fails **closed**. An unresolvable
`@cucumber/gherkin`, or a scope resolving zero step definitions, exits 1
naming the cause and the remedy — reporting every step as unbound would be the
same blackout in a different costume. The parser is an optional peer
dependency resolved from the consumer project's own module chain, so a
consumer with no BDD tier gains nothing; install it with
`npm install --save-dev @cucumber/gherkin` when enabling the gate.

Two escapes exist because the step index is a source scan (heuristic) while
the parser is exact: `exemptionTags` (default `["@skip"]`) drops a scenario
from must-bind, and `stepWaivers` drops one exact step text. Neither is an
escape from must-compile — a parse error in an exempt scenario's file still
fails the run.

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

If your test runner doesn't produce per-method coverage, see "Disabling the
gate" below.

### Coverage freshness — what triggers a capture

The CRAP scorer treats "no coverage" as "skip the method", so a missing or
stale `coverage/coverage-final.json` silently weakens the gate.
`coverage-capture.js` closes that hole by capturing coverage in-band, and
decides whether it needs to by two rules (Story #5076):

- **The source set is derived, not configured.** Freshness is measured over
  exactly the extensions the CRAP scanner walks — `.js`, `.mjs`, `.cjs`,
  `.ts`, `.tsx`, `.mts`, `.cts` — defined once in
  `.agents/scripts/lib/source-extensions.js`. There is deliberately no
  `.agentrc.json` key for this: a consumer-settable list would be a second
  way to mis-scope the same gate. Formats the engines cannot parse
  (`.astro`, `.vue`, `.svelte`) are not part of it — a project written in
  those still has its `.ts`/`.tsx` measured.
- **Both freshness paths fail closed on an empty source set.** Finding no
  scorable source under `crap.targetDirs` means the check learned nothing,
  so it captures rather than assuming coverage is current, and warns naming
  the configured dirs. If you see that warning, `targetDirs` almost
  certainly does not point at your sources — fix it rather than living with
  a full capture on every run.

**Upgrading from a version before this fix:** a TypeScript project's sources
matched neither path, so the capture was skipped on every run and
`crap:check` compared the committed baseline against itself. The first run
after upgrading captures for real and measures your committed floors for the
first time, which may surface breaches that were always there. That is a
one-off re-baseline (`npm run crap:update`, committed with a
`baseline-refresh:` subject), not a regression.

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

`targetDirs` (like the other list-valued gate keys) accepts the deep-merge
extender form — `{ "append": [...] }` / `{ "prepend": [...] }` add to the
framework default (`["src"]`), while a plain array replaces it entirely. The
worked example and the general rule live once in
[`configuration.md` § How to extend](../docs/configuration.md#how-to-extend).

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

There is no CI guardrail rejecting unlabeled baseline edits; the convention is
preserved so the operator can grep refresh commits in a PR diff, but
self-policing is the operator's job during `/mandrel-deliver`'s watch loop.

### The per-method coverage join (Story #4775)

CRAP is the only gate that joins two independently-produced artifacts: the
per-method complexity escomplex derives from the source, and the per-function
coverage istanbul derives from the test run. Everything below exists because
that join is silent when it fails — an unresolved method is simply absent from
the baseline, so a broken join looks exactly like a small repo.

**One coordinate system.** For a TS/TSX source, escomplex parses the
*transpiled* output and reports each method's `lineStart` in transpiled
coordinates, while `coverage-final.json` is keyed against the *original*
source. The scorer therefore asks `transpileIfNeeded` for a source map
(`{ withLineMap: true }`, backed by Node's built-in `SourceMap` — no extra
runtime dependency) and remaps each method start into original coordinates
before the lookup. JavaScript is a passthrough: its coordinates already are
original coordinates, so no map is computed and nothing changes. The
maintainability path never requests a map, and the emitted code is
byte-identical either way, so MI scores are unaffected.

**Tolerant matching.** Remapping alone is insufficient: escomplex's method
start and istanbul's `decl.start.line` disagree by a line when a decorator, a
leading `export`, or a wrapped parameter list sits between them. The lookup is
exact-line first (so every already-resolving row keeps its exact prior value),
then innermost containment, then nearest declaration within ±1.

**`requireCoverage: false` means score it.** A method with no coverage entry
scores as 0% covered — `crap = c² + c`, the formula's own treatment of
untested code — and lands in the baseline. It used to be dropped individually
regardless of the flag, which made the flag a no-op for baseline population.
`requireCoverage: true` still skips and counts it.

**The updater fails closed on a thin result.** `update-crap-baseline.js`
reports `resolved/joinable` over files that *have* coverage and refuses to
persist below `delivery.quality.gates.crap.minMethodResolutionRate` (default
`0.75`), naming the worst unresolved files. The floor is not enforced below 25
joinable methods, where a diff-scoped run's rate is noise. A healthy repo
resolves ~98%; the 4–6% signature of a coordinate-system mismatch is far below
the floor.

**Re-derive your floors after adopting this — but do not re-pin `max`.** A
`crap.floors` `max` ceiling pinned before the fix was computed over the
minority of methods the join could see, so it is not a real ceiling — it is an
artefact. The honest scan sees far more (in this repository, 2215 → 4058
visible methods), and the newly-visible methods include the worst ones.

The tempting response — raise `*.max` until the gate is green again — produces a
floor fitted to the tree's current high-water mark, which **can never fire**:
nothing breaches it until something becomes worse than the worst method already
present. Prefer a *count* budget over a max ceiling:

```jsonc
"crap": {
  // Number of methods allowed to score above 20. Ratchet this down; it
  // breaches the moment the count grows, which a `max` ceiling cannot do.
  "floors": { "*": { "methodsAbove20": 40 } }
}
```

`max` remains available and is the right instrument when you genuinely have a
hard per-method ceiling to hold. It is the wrong instrument for absorbing
pre-existing debt.

Note that neither choice is what protects new code. `floors` is an absolute
tree-wide comparison against the rollup; the forward pressure lives in
`newMethodCeiling` (a *new* method scoring above it fails, default 30) and in
`compareCrap`'s ratchet (an *existing* method fails when it regresses against
its own baseline row). Both are unaffected by how much old debt the gate can
now see, and neither consults `floors`.

**Old baselines are invalidated explicitly.** Rows scored by the previous join
are not comparable to rows scored by this one, and neither `kernelVersion` nor
`escomplexVersion` moves (both track the same upstream package). The envelope
therefore carries a `scoringSemantics` stamp; `check-baselines` fails closed on
a mismatch with the exact re-baseline command rather than comparing across the
boundary. Bump the stamp whenever the coverage join, the line coordinate
system, the unresolved-method policy, or the method identity rule changes —
Story #4969 bumped it for the last of these, replacing escomplex's positional
`<anon method-N>` label with an enclosing-scope-path identity.

---

## Keeping a baseline fresh (Story #4776)

Populating a baseline correctly is only half the loop. The other half is
keeping it correct as the tree grows, and that half has two distinct holes —
one at close time, one over the long run. Both are **advisory**:
`check-baselines` already fails closed on a real regression, and duplicating
that would double-gate the same defect.

### Pre-merge projections — the refresh nudge at close time

Close-validation projects, after its gates pass, which committed baseline rows
the post-merge tree would breach, and names the exact remedy while the operator
still has the branch in hand:

- `lib/close-validation/projections/maintainability.js` — per-file MI.
- `lib/close-validation/projections/crap.js` — per-method CRAP, against each
  method's baseline row or, for methods with no row, `newMethodCeiling`.

Both are wired through `projections/advisories.js`, which
`close-validation/runner.js` calls once. Each self-skips — logging the reason,
never erroring — when its gate is disabled, when no baseline exists, when the
diff has no scorable files, or when the CRAP scorer finds no coverage
artifact. A projected breach never changes the close verdict.

> The maintainability projection shipped in v1 fully written and fully
> unit-tested, and the v2 Epic-tier collapse removed its only caller. It sat
> importable-but-unimported for the whole of v2, so its advisory never fired
> once. `tests/lib/close-validation/runner-projections.test.js` now walks the
> import graph and fails if **any** module under `projections/` is reachable
> from nothing in production — the orphaning itself is the regression.

### `check-baseline-drift.js` — the scheduled full-scope re-score

Every per-PR enforcement site (close-validation, pre-push, CI) is
**diff-scoped**: it compares the files a branch touched against their baseline
rows. A file nobody touches after its row is written is therefore never
re-scored, so drift introduced *indirectly* — a dependency getting more
complex, coverage moving underneath a method — stays invisible indefinitely.
Full-scope scoring on every push is far too expensive to be the answer.

```bash
node .agents/scripts/check-baseline-drift.js                     # both kinds
node .agents/scripts/check-baseline-drift.js --gate crap         # one kind
node .agents/scripts/check-baseline-drift.js --tolerance 1 --json
```

It re-scores full-scope through the *same* scorer that writes the baseline
(`refresh-service.resolveDefaultScorer`) — scoring by a second implementation
would report the two implementations' disagreement as drift — and prints a
per-row before/after table for everything that moved beyond the gate's
tolerance, **in either direction**. A row that silently improved is equally
strong evidence the baseline no longer describes the tree.

Exit codes: `0` no drift (or every kind skipped), `1` drift detected, `2` the
check could not run.

**`--require-scored`.** "Every kind skipped" mapping to `0` is a
fail-open trap for the scheduled use this CLI was built for. Measured: with no
`coverage/coverage-final.json` on disk, `check-baseline-drift.js --gate crap`
prints `✅ No baseline drift detected` and exits `0` — a nightly job wired that
way is green and inert. Pass `--require-scored` and any skipped kind exits `2`
instead, naming the kind and the skip reason. Use it in every scheduled
invocation.

This repository schedules the maintainability kind in
`.github/workflows/baseline-drift.yml` (framework repo only — that path is not
part of the materialized `.agents/` payload) — nightly at 05:43 UTC plus
`workflow_dispatch`; it files or updates one
`meta::baseline-drift` issue with the report, closes it when the tree comes
back clean, and fails the run. A consumer materializing `.agents/` still owns
its own schedule.

`crap` is deliberately **not** in that job. Its drift identity is
`path::method@startLine`, so anything that shifts a method's line re-keys its
row: measured on this tree with a real coverage artifact, 82 rows drifted but
1438 were reported added and 898 removed — and 853 of those removals are the
same `path::method` reappearing at a different line. The added/removed axis is
re-keying churn, not drift, and the remedy the report prints
(`npm run crap:update -- --full-scope`) additionally re-measures, pulling in
near-empty coverage entries minted by CLI-spawning tests. Fixing the identity
is a prerequisite to scheduling the kind.

### `check-baseline-scope.js` — is this baseline still measuring the tree?

Drift detection assumes the row set is right and asks whether its numbers
moved. The prior question went unasked: **does this baseline still describe
the tree at all?** A ratchet is perfectly capable of being green while
measuring almost nothing — a row can point at a file deleted months ago, and
an in-scope file can carry no row whatsoever, and every gate above stays
green.

The scope gate asserts the row set in **both directions**, recomputing each
kind's in-scope file set from the gate's own configuration —
`.c8rc.cjs` `include`/`exclude` for coverage,
`delivery.quality.gates.<kind>.{targetDirs,ignoreGlobs}` for the rest —
through the same helpers the refresh scorers use, so the gate and the
producers cannot disagree about scope:

```bash
npm run baselines:scope                                  # every kind
node .agents/scripts/check-baseline-scope.js --kind coverage --json
node .agents/scripts/check-baseline-scope.js --strict     # skip attribution
```

Two design constraints are worth knowing before reading a report:

- **Only dense kinds assert `missing`.** `coverage` and `maintainability`
  emit one row per in-scope file, so a file with no row is a real hole. `crap`
  (per-method, coverage-gated), `duplication` (rows only where clones exist),
  `lint` and `mutation` are sparse by construction — asserting `missing`
  against them yields hundreds of phantom findings on a healthy tree, so they
  assert `extra` only. `lighthouse` (`route`) and `bundle-size` (`bundle`) are
  not file-keyed and are excluded from both.
- **A PR is blocked only for divergence it created.** Whole-tree equality
  would red every open PR the moment anyone lands an in-scope file, so the
  gate blocks on divergence attributable to `merge-base(base, HEAD)..HEAD` and
  warns about the inherited remainder. It fails towards **strict** — every
  finding fatal — when no base resolves, when HEAD is not ahead of it, or when
  the change set edits a baseline or the config defining its scope.

Exit codes: `0` no fatal divergence, `1` fatal divergence, `2` the check could
not run. It runs in the required `baselines` CI job.

### `prune-baseline-orphans.js` — the cheap remedy that makes the gate fair

A hard gate is only defensible while clearing it costs a command. Re-deriving
a whole baseline to express a *deletion* spends a coverage run or a full-tree
MI pass, which is exactly why stale rows accumulate. The pruner is that
deletion, done as arithmetic:

```bash
npm run baselines:prune                                   # write the prune
node .agents/scripts/prune-baseline-orphans.js --check     # report only, exit 1
```

It removes exactly two provably-inert row classes across every file-keyed
baseline — a row whose file is **absent** from disk, and a row for a file now
**out-of-scope** under the gate's own `targetDirs`/`ignoreGlobs` — and it is
**measurement-free by contract**: it never adds a row, never restamps
`generatedAt` (a fresh stamp over rows nobody re-measured is the precise
failure an age check exists to catch), and recomputes `rollup` through the
kind's own arithmetic so the pruned envelope still validates against its
schema. An unreadable scope config degrades to orphan-only pruning rather than
reading unknown scope as empty scope, which would hand it the whole baseline.

A **missing** row is the one thing the pruner will not fix: a file added
without being measured needs its producer (`npm run coverage:update`,
`npm run maintainability:update`), because inventing a row would be claiming a
measurement nobody took.

**CI does not run the pruner in either mode.** `--check` exits 1 on any stale
row without asking which change set introduced it, so pairing it with
`check-baseline-scope.js` in the required job cancelled that gate's merge-base
attribution: a row inherited from `main` — say one PR deletes a file while a
second, branched earlier, re-adds its row through a baseline refresh — reds
every open PR on divergence its author did not create and cannot fix from
their branch. The scope gate reports that row as an inherited warning; the
pruner is the remedy an operator (or agent) runs with the branch in hand.

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

`risk::high` is planning/audit metadata only — it never pauses runtime. The
sole runtime HITL pause point is `agent::blocked`. The full model is owned by
[`.agents/instructions.md`](../instructions.md) § 1.J and
[`SDLC.md` § HITL model](SDLC.md#hitl-human-in-the-loop-model).

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

> `mutation` is a **registered baseline kind with no shipped runner**. The
> envelope, schema, and floor config below describe a `baselines/mutation.json`
> the framework can read and ratchet, but nothing in Mandrel invokes Stryker or
> writes that file: the `update-mutation-baseline.js` refresh CLI was retired
> in #4482 and the `lib/mutation/` snapshot machinery in #5008. Activating the
> gate means shipping a runner first — treat the kind as a reserved slot, not a
> dormant feature.

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

### Concurrent refreshes — the baseline merge driver

`generatedAt` sits on line 4 of every envelope, so two branches that each
refresh a baseline **always** differ there, even when they moved completely
disjoint rows. Git merges JSON as text, and whether it can separate that hunk
from the moved rows is an accident of proximity. Both outcomes are wrong:

- it cannot → a conflict on work that never overlapped (the `coverage.json` /
  `maintainability.json` "always conflicts" pattern);
- it can → it splices both sides' row lines into a row set **neither side
  scored** (the `crap.json` "silently auto-merges" pattern). The ratchet then
  guards a number no scorer ever produced.

A baseline is a set of rows keyed by identity plus a rollup derived from them,
so [`merge-baseline.js`](../scripts/merge-baseline.js) merges it as that. Per
row identity the standard 3-way rule applies; only a genuine double move
conflicts, and then markers wrap that row alone. The rollup is always
**recomputed** from the merged rows — merging two rollups is the same splice
hazard compressed into one number — and `generatedAt` resolves to the later of
the two stamps rather than conflicting.

Row identity comes from the kind module's `rowIdentity(row)`, which is
deliberately not `keyField`: CRAP groups by file (`keyField: 'path'`) but
ships one row per method, so keying on `keyField` would drop every method in a
file but one. Any `baselines/*.json` whose `$schema` is not a known per-kind
envelope — `arch-cycles`, `cyclomatic`, `dead-exports`, `audit-ledger`,
`context-budget`, `workflow-citations` — is handed straight back to
`git merge-file`, so registering the driver cannot change their behaviour.

Registration has two halves:

```bash
# 1. tracked, installed by `node .agents/scripts/apply-quality-bootstrap.js`
#    → .gitattributes:  baselines/*.json merge=mandrel-baseline
# 2. per clone — git will not run a command chosen by whoever wrote the repo
git config merge.mandrel-baseline.driver "node .agents/scripts/merge-baseline.js %O %A %B %P"
```

Only the first ships with the repository, and a clone missing the second
degrades **silently** back to the text merge. `mandrel doctor`'s
`merge-driver` check is the guard: it prints the exact `git config` line
above, and passes as skipped when `.gitattributes` does not declare the
driver at all.

`MANDREL_BASELINE_GENERATED_AT` pins the stamp for a reproducible build (see
the environment table in [configuration.md](configuration.md)). It is no
longer needed to dodge merge conflicts.

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
  `*` always present in the output. The shared baselines kernel
  (`lib/baselines/kernel.js`, via the per-kind rollups in
  `lib/baselines/kinds/`) groups rows by component and names the
  breached component in its output so a `*` rollup is not falsely
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
- `baselines/lint.json` has no framework refresh CLI — see
  [Lint baseline ratchet](#lint-baseline-ratchet).

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
