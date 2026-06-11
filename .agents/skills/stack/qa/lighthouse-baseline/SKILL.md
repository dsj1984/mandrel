---
name: lighthouse-baseline
description:
  Codifies the capture-and-check baseline pattern for long-running quality
  signals (Lighthouse scores, bundle size, p95 latency, runtime memory). Use
  when wiring a new metric that needs a baseline file, paired :capture /
  :check npm scripts, a tolerance-bounded gate, and a weekly refresh
  cadence — the goal is a hard CI signal that ratchets only with intent.
---

# Skill: Lighthouse-Style Quality Baseline

## Policy Capsule

- Use this pattern only for numeric, run-to-run-comparable signals with directional intent (higher-is-better or lower-is-better) and meaningful noise variance.
- Commit one canonical `baselines/<name>.json` per signal — never combine multiple metrics into a single baseline file.
- Provide paired `<name>:capture` and `<name>:check` npm scripts; `:capture` writes the baseline, `:check` compares with tolerance and exits non-zero on regression.
- Implement a `--self-test` mode that runs the comparator against known-good and known-regression fixtures so CI verifies the gate itself.
- Pick tolerance from observed run-to-run spread (~2σ); tolerance of 0 flaps and trains reviewers to rubber-stamp refreshes.
- Refresh baselines through deliberate, human-reviewed commits with the `baseline-refresh:` subject prefix; never auto-refresh on every CI run.
- Run a weekly scheduled `:capture` workflow that opens a PR only when drift exceeds tolerance.
- Keep baselines under source control — never store them in `temp/` or `coverage/` or anything covered by `.gitignore`.

Pattern for promoting an episodic measurement into a long-running quality
signal. The audit-lighthouse / audit-performance / audit-bundle-size
workflows produce a snapshot. This skill is for the next step: turning that
snapshot into a baseline a CI gate can ratchet against.

## When to reach for this

Reach for this pattern when **all** of these hold:

- The signal is **numeric and comparable** across runs (a score, a duration,
  a byte count). Boolean pass/fail signals belong in a normal lint, not a
  baseline.
- The signal has **noise floor variance** between runs, so equality checks
  would flap. You need a tolerance band.
- The signal has **directional intent** — bigger is worse (bundle KB, p95
  ms) or bigger is better (Lighthouse score). The gate enforces direction;
  a refresh moves the line on purpose.
- Refreshing the baseline should be a **deliberate commit**, reviewed like
  any other change. Auto-refreshing on every CI run defeats the gate.

If the signal is binary or one-shot (e.g. "page returns 200", "alt-text
present"), stay in the audit-* workflow space — don't spin up a baseline
for it.

## Anatomy

The five pieces every baseline of this shape carries:

1. **`baselines/<name>.json`** — canonical snapshot committed to the repo.
   One file per signal. JSON, not YAML or TOML — diff tooling handles it
   uniformly.
2. **`<name>:capture` npm script** — runs the measurement, writes the new
   snapshot to a temp path. Never overwrites the canonical baseline
   directly. Operator-driven.
3. **`<name>:check` npm script** — runs the measurement, compares against
   `baselines/<name>.json` with a tolerance, exits non-zero on regression.
   Wired into the close-validation gate chain (see `buildDefaultGates` in
   `lib/close-validation/gates.js`) and into the PR gate.
4. **`--self-test` flag** — every check script accepts `--self-test`,
   which runs the comparator against synthetic inputs (a known-good and a
   known-regression fixture) and asserts the gate's verdict matches. CI
   runs this on every PR so a comparator bug can't silently mask a real
   regression.
5. **Weekly cadence workflow** — a scheduled CI job that runs `:capture`,
   diffs against the committed baseline, opens a PR if drift is real
   (above tolerance) or a comment if it is within band. Intent-driven
   refresh: the PR is the place to argue the regression is justified.

## Worked example: Lighthouse Performance score

`baselines/lighthouse-performance.json`:

```json
{
  "$schema": "../.agents/schemas/baseline-numeric.schema.json",
  "metric": "lighthouse.categories.performance",
  "value": 92,
  "direction": "higher-is-better",
  "tolerance": 2,
  "capturedAt": "2026-05-06T00:00:00Z",
  "capturedFrom": {
    "url": "https://preview.example.com/",
    "lighthouseVersion": "12.2.1",
    "formFactor": "desktop"
  }
}
```

Two npm scripts in `package.json`:

```jsonc
{
  "scripts": {
    "lighthouse:capture": "node scripts/lighthouse-baseline.js --capture",
    "lighthouse:check":   "node scripts/lighthouse-baseline.js --check"
  }
}
```

The script implements three modes:

- `--capture` — Run Lighthouse, write `baselines/lighthouse-performance.json`.
- `--check` — Run Lighthouse, compare to the committed baseline. Exit 0 if
  the value is within `(baseline ± tolerance)` or improving. Exit 1 if the
  value falls below `(baseline − tolerance)` for higher-is-better metrics,
  or above `(baseline + tolerance)` for lower-is-better metrics.
- `--self-test` — Skip the real measurement. Run the comparator against
  fixtures (e.g. known-good=92, known-regression=87). Assert that the gate
  verdicts match the expected pass/fail. Exit 0 on success.

## Gate hint shape

When the `:check` script fails, the error message must point at the exact
remediation path. A working hint:

```text
Lighthouse performance score 87 is below baseline 92 (tolerance ±2).
Either: (a) fix the regression, or (b) if the drop is justified, run
`npm run lighthouse:capture` and commit the refreshed baseline with a
`baseline-refresh:` tagged subject (non-empty body explaining why).
```

The `baseline-refresh:` subject prefix mirrors the existing CRAP / MI
convention so the same commit-tag tooling already validating those
baselines extends to this one.

## Weekly cadence

`.github/workflows/lighthouse-weekly.yml` (or the equivalent for your CI):

```yaml
on:
  schedule:
    - cron: "0 14 * * 1"   # Mondays 14:00 UTC
  workflow_dispatch: {}

jobs:
  refresh:
    steps:
      - run: npm run lighthouse:capture
      - run: |
          if git diff --quiet baselines/lighthouse-performance.json; then
            echo "No drift; baseline still valid."
            exit 0
          fi
          # Drift exists — open a PR with the refreshed baseline.
          gh pr create --title "baseline-refresh: lighthouse perf" \
            --body "Auto-captured weekly baseline. Review the diff and merge if intentional."
```

The cadence is weekly, not daily — a daily refresh creates so many PRs
that reviewers stop reading them. The point is for a reviewer to read the
diff and say "yes, this is the new floor" or "no, that regression
shouldn't be in main."

## Tolerance picking

Tolerance encodes "what's noise". Pick it from the **observed run-to-run
spread** on a known-good build, not a vibe:

1. Capture the metric ten times against the same artifact.
2. Take the standard deviation σ.
3. Set tolerance ≈ 2σ. That gates real regressions without flapping on
   warmup variance.

If σ is bigger than the regressions you care about, the metric is too
noisy for this pattern — invest in stabilising the measurement (warm-up
runs, pinned hardware, controlled network) before adding the gate.

## Anti-patterns

- **Auto-refresh on every CI run.** Defeats the gate; every regression
  becomes the new normal. Refreshes must be commits.
- **Tolerance = 0.** Flaps on warmup noise, training reviewers to
  rubber-stamp `baseline-refresh:` PRs without reading them. Then a real
  regression sneaks through.
- **No `--self-test`.** A bug in the comparator silently disables the
  gate. The self-test is the gate's gate.
- **Multiple metrics in one baseline file.** Couples unrelated drifts. A
  bundle-size regression shouldn't block a Lighthouse refresh. One signal
  per file.
- **Baseline lives in `temp/` or `coverage/`.** The baseline is source of
  truth — committed and reviewed. Anything under `temp/` or in `.gitignore`
  is a snapshot, not a baseline.

## Cross-references

- Existing baseline-shape conventions in this framework:
  `baselines/maintainability.json`, `baselines/crap.json`,
  `baselines/lint.json`. Their `:update` / `:check` script pairs and the
  `baseline-refresh:` commit-subject contract are the prior art this
  skill generalises.
- The audit-lighthouse workflow (`/audit-lighthouse`) produces the
  one-shot Lighthouse snapshot that feeds the first `:capture`. Run it
  once to confirm the script's measurement matches the workflow's, then
  promote to a baseline.
