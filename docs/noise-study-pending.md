# Noise study — pending CI artifact

Story #1397 (Epic #1386, Stabilize Quality Baselines Against Drift) lands the
empirical noise-capture infrastructure but defers the recommended-threshold
re-tune to a follow-up baseline-refresh commit once the CI artifact is in
hand.

## What landed in this Story

- `.agents/scripts/noise-study.js` — one-shot empirical noise-capture script
  that spawns `npm run test:coverage` N times against a fixed reference
  commit, in-process scores MI (`calculateAll`) and CRAP (`scanAndScore`)
  per run, and emits a markdown report + CSV with per-row mean / stddev /
  p95 abs-deviation and a recommended-threshold block.
- `tests/noise-study.test.js` — unit coverage of the pure aggregation math
  (no spawn): mean, population stddev, p95 abs-deviation with linear
  interpolation, accumulator merge, recommendation rounding (round-up to
  2dp so the recommendation always covers raw), and markdown / CSV
  rendering.
- `.github/workflows/noise-study.yml` — `workflow_dispatch` job that runs
  the script in parallel on `windows-latest` + `ubuntu-latest` under
  Node 22, uploads per-runner reports as artifacts, and prints the
  recommended-threshold block to the job summary.

## What is pending

- Real CI runs of `noise-study.yml` on both runners (≥30 reps each)
  against a fixed reference commit. The dispatched run produces two
  per-runner markdown reports + CSVs as artifacts.
- Combined `docs/noise-study-<date>.md` that merges both runners'
  recommended-threshold tables. The combined report replaces this
  placeholder once the artifact is downloaded.
- Threshold re-tune commit (subject prefix `baseline-refresh:`) updating
  `agentSettings.quality.maintainability.tolerance`,
  `agentSettings.quality.crap.tolerance`,
  `agentSettings.quality.maintainability.halsteadTolerance` (when
  data supports a separate Halstead-axis term), and CRAP `c1Exemption`
  handling per the noise-study recommendation. Task #1418 carries this
  follow-up and is currently `agent::blocked` awaiting the artifact.

## How to dispatch the workflow

Operator runs:

```bash
gh workflow run noise-study.yml -f runs=30 -f ref=<commit-sha>
```

Then download the artifacts, run the merge step, replace this file with
the combined `docs/noise-study-YYYY-MM-DD.md`, and commit the threshold
update with a `baseline-refresh:` subject citing the new docs file.
