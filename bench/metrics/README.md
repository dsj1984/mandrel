# Mandrel Self-Benchmark — Metrics Model

> **Internal tooling.** Everything under `bench/` is development tooling, like
> `tests/` and `docs/`. It is **never** shipped in the distributed `.agents/`
> bundle and **never** runs against the live `mandrel` repo — all churn lands
> in a dedicated sandbox repo on ephemeral clones (Epic
> [#4211](https://github.com/dsj1984/mandrel/issues/4211), Story
> [#4215](https://github.com/dsj1984/mandrel/issues/4215)).

This document is the **measurement contract** the whole harness conforms to.
It defines, with explicit reproducible formulas:

1. The **five dimensions** — three on the value side (what scaffolding
   _buys_) and two on the cost side (what it _charges_).
2. The **variance / noise-band method** — how every dimension is reported as a
   distribution across N runs, and the rule for when a Mandrel-vs-control delta
   is called _real_.
3. Two **cross-scenario derived metrics** — the difficulty-monotonicity check
   and the overhead-floor estimate — that are computed by comparing scenarios,
   not scored per run.

The scorecard JSON contract is
[`../schemas/scorecard.schema.json`](../schemas/scorecard.schema.json); a
worked example is [`../fixtures/sample-scorecard.json`](../fixtures/sample-scorecard.json).
The noise-band is implemented in [`variance.js`](./variance.js).

---

## Design principles (binding)

- **No single composite score.** We report the value/cost frontier; we never
  collapse the five dimensions into one scalar that would get gamed
  (Goodhart's law — see Epic #4211 Non-Goals). Each dimension stands alone.
- **Every score is a distribution, never a point.** Each `(scenario × arm)`
  cell runs at **N≈8–10**. A dimension's headline number is always reported
  with its noise-band; a bare point estimate is a reporting bug.
- **Apples-to-apples by construction.** Both arms — the **Mandrel arm**
  (clone carries `.agents/`, runs `/plan`→`/deliver`) and the **control arm**
  (no scaffolding, bare task prompt) — are driven by the same `claude -p
  --output-format json` launcher and costed by the same usage envelope. The
  overhead ratio is therefore a like-for-like comparison, not an estimate.
- **Like model to like.** Every scorecard is stamped with the exact pinned
  model id, framework version, and environment. A cross-version comparison
  only ever compares cells with the same `(model, frameworkVersion, env)`.
- **Reproducible formulas only.** Every dimension below reduces to a
  deterministic function of recorded inputs (lifecycle NDJSON fields, the
  `claude -p` envelope, frozen-suite results, the acceptance-eval verdict). No
  formula depends on a wall-clock read at scoring time, a random draw, or an
  un-recorded judgment.

### Inputs (recorded per run)

| Input                  | Source                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| Timings, dispatches    | `temp/epic-<id>/lifecycle.ndjson` (append-only NDJSON)                 |
| Autonomy events        | `lifecycle.ndjson` (`agent::blocked`, HITL stops) + per-Story `signals.ndjson` |
| Cost (tokens, USD)     | `claude -p --output-format json` usage/cost envelope                   |
| Quality (objective)    | Scenario's **frozen acceptance suite** (deterministic HTTP/Playwright) |
| Quality (cross-check)  | `acceptance-eval.js` LLM-judge verdict                                 |
| Plan vs. actual        | Decomposer output (planned Stories / `changes[]`) vs. delivered Stories / touched files |

All inputs are persisted onto the scorecard's `rawRefs` for traceability, even
though the ephemeral workspace is torn down after each run.

---

## The five dimensions

Each formula yields a value in a stated range. Per-run values land on the
scorecard under `dimensions.<name>`; the distribution and band are computed
across the N per-run values by the scoring slice (see
[§ Variance](#variance--noise-band-method)).

### 1. Quality — _is the output correct & on-intent?_ (value side)

The objective spine is the scenario's **frozen acceptance suite** — a fixed
set of deterministic assertions (HTTP status/body, Playwright steps) run
against the delivered app. The LLM-judge (`acceptance-eval.js`) is a
**cross-check**, never the spine, so Quality cannot be gamed by persuading the
judge.

```text
frozenSuitePassRate = frozenSuitePassed / frozenSuiteTotal           ∈ [0, 1]

quality.score =
    w_suite · frozenSuitePassRate  +  w_judge · acceptanceEvalScore
  with w_suite = 0.7, w_judge = 0.3, and w_judge folded into w_suite
  (renormalized to w_suite = 1.0) when acceptanceEvalScore is null
                                                                     ∈ [0, 1]
```

- The frozen suite is **frozen**: its assertions are authored once per
  scenario and never edited to match a particular run's output.
- `acceptanceEvalScore` is the fraction of acceptance criteria the judge marks
  satisfied. It is `null` for the control arm when no acceptance criteria were
  authored; the weight then collapses entirely onto the frozen suite.
- A run that fails to deliver a runnable app scores `frozenSuitePassRate = 0`
  (every assertion fails), i.e. `quality.score = 0` — not "no data".

### 2. Planning fidelity — _did the plan match reality?_ (value side)

Measures how well the authored plan predicted the delivered work. Three
recorded sub-signals combine into a `[0, 1]` score; **`null` for the control
arm** (it authors no plan).

```text
storyAccuracy   = 1 − |plannedStoryCount − deliveredStoryCount|
                       / max(plannedStoryCount, deliveredStoryCount, 1)   ∈ [0, 1]

rePlanPenalty   = 1 / (1 + rePlanCount)                                   ∈ (0, 1]

footprintAccuracy = 1 − fileFootprintDrift                                ∈ [0, 1]
  where fileFootprintDrift = Jaccard distance between the planned changes[]
  path set P and the actually-touched path set A:
    fileFootprintDrift = 1 − |P ∩ A| / |P ∪ A|         (0 when both empty)

planningFidelity.score =
    (storyAccuracy + rePlanPenalty + footprintAccuracy) / 3               ∈ [0, 1]
```

- `rePlanCount` counts decomposition-revision / re-plan events observed during
  the run (a high count means the plan needed reshaping mid-flight).
- `fileFootprintDrift` is the symmetric set distance; recall that under the
  Engineer persona's _logged-deviation_ latitude, `changes[]` is an advisory
  sketch — so modest drift is expected and only a large drift dents fidelity.

### 3. Autonomy — _how little human intervention?_ (value side)

How close the run came to fully unattended. Counts every point a human had to
step in. The harness's whole make-or-break risk is that the pipeline runs
**unattended**, so this is the dimension that proves it.

```text
interventions = hitlStops + blockedEvents + manualRescues

autonomy.score = 1 / (1 + interventions)                                  ∈ (0, 1]
```

- `autonomy.score = 1.0` ⇒ zero interventions: the run completed end-to-end
  with no human in the loop.
- `hitlStops` — STOP gates the run actually halted at (one-pager confirm, spec
  review, decomposition diff gate, the auto-merge-else-operator-merge step).
  In a correctly-configured unattended run these auto-proceed and the count is
  0; any non-zero value is a finding.
- `blockedEvents` — `agent::blocked` transitions in `lifecycle.ndjson`.
- `manualRescues` — operator interventions that unblocked or restarted the run.

### 4. Efficiency — _what did it cost absolutely?_ (cost side)

Absolute cost as a **vector**, never collapsed to one number. The three
components are reported independently (each gets its own distribution + band):

```text
efficiency.wallClockMs  = run end − run start, from lifecycle.ndjson    (ms, ≥ 0)
efficiency.totalTokens  = Σ (inputTokens + outputTokens) over the
                          claude -p usage envelope                      (≥ 0)
efficiency.dispatches   = count of Story sub-agent launches in
                          lifecycle.ndjson                              (≥ 0)
efficiency.costUsd      = total USD from the envelope when reported,
                          else null
```

- Tokens and USD come **only** from the `claude -p` envelope — Mandrel records
  no token actuals of its own (`epic-deliver-preflight.js` merely _estimates_).
  Measuring both arms from the same envelope is what makes the comparison
  honest.
- GitHub round-trip latency is intentionally **inside** `wallClockMs` — it is
  part of Mandrel's real overhead.

### 5. Overhead ratio — _ceremony tax vs. shippable output?_ (cost side)

The framework's _tax_: how much ceremony (planning, decomposition,
orchestration, gate machinery) it spends per unit of shippable codegen.

```text
overheadRatio.tokenRatio = ceremonyTokens / codegenTokens               (≥ 0)
overheadRatio.timeRatio  = ceremonyMs    / codegenMs   (null if unavailable)
```

- **Token attribution.** `codegenTokens` are the tokens spent inside the
  Story-implementation phases that produce shippable artifacts (the
  delivery sub-agents' edit/commit work). `ceremonyTokens` are everything
  else in the session: `/plan` authoring (PRD, Tech Spec, decomposition),
  orchestration overhead, and the gate/close machinery. The split is derived
  from the lifecycle phase boundaries; `ceremonyTokens + codegenTokens` equals
  `efficiency.totalTokens`.
- A `tokenRatio` of `4.0` means four tokens of ceremony per token of shippable
  output. For the **control arm** there is effectively no ceremony, so its
  ratio sits near the floor (~0) — the gap between the arms _is_ the tax.
- This dimension is the most direct lever for the "ceremony-lite path for
  trivial scopes" recommendation when `hello-world` shows a high ratio with no
  quality gain.

---

## Variance / noise-band method

Every dimension above is reported as a **distribution** across the N≈8–10
per-run values, summarized by a **noise-band**. The band is the spread a
Mandrel-vs-control delta must clear before we call it real. The canonical
implementation is [`variance.js`](./variance.js); this section is its
specification.

`noiseBand(values, { method })` accepts an array of per-run values for one
dimension (non-finite entries — a run that produced no value — are filtered
out first) and returns:

```text
{ method, n, center, low, high, spread, detail }
```

Two methods, both robust for tiny samples:

### `iqr` — median + inter-quartile range (default)

```text
center = median(values)
Q1     = 25th percentile          (linear-interpolation / type-7 estimator)
Q3     = 75th percentile
IQR    = Q3 − Q1
low    = max(min(values), Q1 − 1.5·IQR)      (Tukey inner fence, clamped)
high   = min(max(values), Q3 + 1.5·IQR)      (Tukey inner fence, clamped)
spread = high − low
```

The default. Resistant to the heavy-tailed outliers an agent run produces (one
stalled 40-minute wall-clock run must not blow out the band). Fences are
clamped to the observed range so the band never claims an unobserved value.

### `ci` — mean + 95% confidence interval of the mean

```text
center = mean(values)
sd     = sample standard deviation (Bessel-corrected, n − 1 denominator)
sem    = sd / √n
margin = t₀.₉₇₅(n − 1) · sem        (Student's t critical value, df = n − 1)
low    = mean − margin
high   = mean + margin
spread = 2 · margin
```

A parametric band on the **mean**, for roughly-symmetric dimensions. The
Student's _t_ critical value (not the normal 1.96) is used because the samples
are tiny — at df ≈ 7–9 the difference is material.

### Real-delta rule (consumed by the scoring slice)

A Mandrel-vs-control difference on a dimension is only reported as **real** when
the absolute difference of the two arms' band centers exceeds the larger of the
two arms' `spread`:

```text
deltaIsReal = |centerMandrel − centerControl| > max(spreadMandrel, spreadControl)
```

Otherwise the delta is **within noise** and reported as "no significant
difference." This module produces the bands; the comparison itself lives in the
scoring slice.

---

## Cross-scenario derived metrics

These two relationships are computed by **comparing scenarios** and reported as
calibration guardrails plus framework findings — they are **not** scored
per-run dimensions and never appear on a single scorecard. With v1's two
scenarios (`hello-world`, `crud-db`) they yield a monotonicity check and a
floor estimate; the full scaling curve needs ≥ 3 ladder rungs and rides the
deferred ladder.

### A. Difficulty monotonicity (calibration guardrail)

As scenario difficulty rises along the ladder, two things **must** hold for the
Mandrel arm:

- **Efficiency rises** — absolute cost / time / dispatches increase
  (`hello-world` < `crud-db`). Harder work costs more in absolute terms.
- **Overhead ratio falls** — ceremony amortizes over more shippable output as
  the task grows, so `overheadRatio.tokenRatio` _decreases_ down the ladder
  (`hello-world` > `crud-db`).

Formally, over the difficulty-ordered scenario list `s₁ … s_k` (easy → hard),
comparing the band centers:

```text
monotonicityHolds =
      center(efficiency.totalTokens, sᵢ)   < center(efficiency.totalTokens, sᵢ₊₁)
  AND center(overheadRatio.tokenRatio, sᵢ) > center(overheadRatio.tokenRatio, sᵢ₊₁)
  for every adjacent pair (sᵢ, sᵢ₊₁)
```

A **violation is a calibration warning**, not a silent pass: it means either
the instrument is insensitive or a scenario is mis-graded for difficulty. The
report surfaces the violation explicitly rather than trusting the numbers.

### B. Overhead floor (framework finding)

The fixed ceremony tax Mandrel pays on **near-zero work** — the most direct
"is the scaffolding worth it for trivial scopes?" signal. Estimated from the
`hello-world` rung as the cost the Mandrel arm pays _above_ the control arm:

```text
overheadFloorTokens = center(efficiency.totalTokens, hello-world, mandrel)
                     − center(efficiency.totalTokens, hello-world, control)

overheadFloorUsd    = center(efficiency.costUsd,     hello-world, mandrel)
                     − center(efficiency.costUsd,     hello-world, control)
```

- Computed on the **band centers** so it inherits the distribution method, and
  reported with its own band derived from the per-run differences.
- A large floor with **no** corresponding `quality.score` gain on `hello-world`
  is the canonical evidence feeding the report's **Recommended improvements**
  section (e.g. _"hello-world overhead ratio is 4.2× with no quality gain →
  consider a ceremony-lite path for trivial scopes"_).
- It is a **floor**, not the full curve: characterizing whether ceremony is a
  flat fixed cost or scales with task size needs at least three ladder rungs
  (deferred beyond v1).

---

## Why these and not a composite

The split — three value dimensions, two cost dimensions, reported as
distributions with an explicit real-delta rule — is deliberate. Collapsing them
into one number would let a regression on one axis hide behind a gain on
another, and would invite gaming the scalar. The harness's job is to show the
**value/cost frontier at a fixed model**, so a human can decide whether
Mandrel still earns its tax at the current frontier — not to declare a single
winner.
