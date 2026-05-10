# Quality Gates

This is the consumer-facing reference for the quality gates the framework
runs against your repo: the lint baseline ratchet, the maintainability
ratchet, the CRAP per-method gate, the anti-thrashing protocol, and the
concurrent close-safety retry that protects the Epic branch when multiple
Stories close in quick succession.

The configuration knobs that drive these gates live in
[`docs/configuration.md`](configuration.md) under
`agentSettings.quality.*` and `orchestration.runners.storyMergeRetry.*`. This
file is the runbook side — what the gate does, when it fires, and how to
bootstrap or refresh it.

---

## Concurrent close safety

`/epic-execute`'s wave loop may close multiple Stories into the same
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

## Coverage threshold gate

`npm run test:coverage` drives [`bench/run-coverage.js`](../bench/run-coverage.js),
which runs the unit-test suite with `NODE_V8_COVERAGE` set, then post-processes
the V8 dumps with `c8 report` and `c8 check-coverage`. The gate fails when
coverage drops below **85 % lines / 70 % branches / 75 % functions** across
`.agents/scripts/**`. Scope (include/exclude) and the threshold values are
declared in [`.c8rc.cjs`](../.c8rc.cjs); the same threshold numbers are passed
to `c8 check-coverage` explicitly because the sub-command does not auto-load
`.c8rc.cjs` and otherwise falls back to the c8 default of 90 %.

The `c8 <cmd>` wrap form (the previous shape of this script) was retired
after [`bench/coverage-bench.js`](../bench/coverage-bench.js) showed the
NODE_V8_COVERAGE path is ~19 % faster end-to-end on a Windows dev host
(median 49 s vs 61 s across 3 runs each) while producing identical
line / branch / function percentages and the same `coverage-final.json`
artifact for the CRAP gate. See [`bench/results.log`](../bench/results.log)
for the run-by-run numbers.

Three files are deliberately outside the gate:

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

Each excluded file also carries `/* node:coverage ignore file */` at
the top of its source as a second line of defence; new exclusions
must be justified in the comment block at the top of `.c8rc.cjs`
before the threshold gate is altered. `dispatcher.js`, `notify.js`,
and `providers/github.js` were previously excluded but now have
dedicated test files (`tests/dispatcher.test.js`,
`tests/notify.test.js`, `tests/providers-github*.test.js`) and sit
inside the gate.

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

The lint baseline engine enforces zero-deterioration during Epic
workflows. Integrations fail if new lint warnings are introduced, and the
baseline automatically tightens when the codebase improves.

The canonical baseline file lives at `baselines/lint.json` (override via
`agentSettings.quality.baselines.lint.path`). Refresh with:

```bash
node .agents/scripts/lint-baseline.js --refresh
```

Refresh commits must use a `baseline-refresh:` subject + non-empty body so
the `baseline-refresh-guardrail` CI job accepts them — same rule as the
CRAP and maintainability ratchets.

---

## Maintainability ratchet

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

`npm run crap:update` regenerates `baselines/crap.json`. The
`baseline-refresh-guardrail` CI job will reject your PR unless at least
one commit on the branch has:

1. A subject starting with the configured `refreshTag` (default
   `baseline-refresh:`).
2. A non-empty body explaining why the refresh is justified.

Both conditions are required. The tag alone without justification is not
enough. Baseline-only PRs additionally receive the
`review::baseline-refresh` label automatically — that's intentional, so a
human reviewer sees every refresh on top of green CI.

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
