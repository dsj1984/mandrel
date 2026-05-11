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

## Interim status (Task #1418 closed with placeholder thresholds)

`gh workflow run noise-study.yml --ref story-1397` 404s because GitHub
requires the workflow definition to exist on the **default branch** before
`workflow_dispatch` can find it — `--ref` only controls the checkout the
run executes against, not where the workflow file is loaded from. Rather
than block the rest of Epic #1386 on a one-off "register the workflow on
main first" PR, Task #1418 lands **interim placeholder thresholds**:

- `agentSettings.quality.maintainability.tolerance` — kept at **0.5**
  (current production value).
- `agentSettings.quality.maintainability.halsteadTolerance` — set to
  **`null`** (use the unified MI tolerance until the noise study confirms
  a separate Halstead-axis term is warranted).
- `agentSettings.quality.crap.tolerance` — kept at **0.05** (current
  production value).
- `agentSettings.quality.crap.c1Exemption` — set to **`"blanket"`**
  (preserves today's blanket c=1 exemption; the noise study can flip this
  to `"confidenceBand"` once data exists).

The schema (`.agents/schemas/agentrc.schema.json`) gains the two new
keys with the same range constraints the Tech Spec called for. Runtime
behavior is unchanged — `halsteadTolerance: null` and
`c1Exemption: "blanket"` are the no-op values for the gate scripts.

## Follow-up to refine these values

When the operator is ready to run the empirical study:

1. Cherry-pick `.github/workflows/noise-study.yml` to `main` as a one-off
   `chore(ci): register noise-study workflow` commit so the dispatch
   API can find it.
2. Run `gh workflow run noise-study.yml -f runs=30 -f ref=<commit-sha>`.
3. Download both runners' artifacts, merge them into a combined
   `docs/noise-study-YYYY-MM-DD.md`, replace this placeholder, and commit
   the threshold update with a `baseline-refresh:` subject citing the
   new docs file.

Until then, the placeholder thresholds match production behavior so no
gate flap is introduced by closing Task #1418.

## How to dispatch the workflow

Operator runs:

```bash
gh workflow run noise-study.yml -f runs=30 -f ref=<commit-sha>
```

Then download the artifacts, run the merge step, replace this file with
the combined `docs/noise-study-YYYY-MM-DD.md`, and commit the threshold
update with a `baseline-refresh:` subject citing the new docs file.
