# Mandrel Self-Benchmark — Report, Persistence & Comparison

> **Internal tooling.** Everything under `bench/` is development tooling, like
> `tests/` and `docs/`. It is **never** shipped in the distributed `.agents/`
> bundle and **never** runs against the live `mandrel` repo — all churn lands
> in a dedicated sandbox repo on ephemeral clones (Epic
> [#4211](https://github.com/dsj1984/mandrel/issues/4211), Story
> [#4218](https://github.com/dsj1984/mandrel/issues/4218)).

This slice is the **operator-facing deliverable** of the harness. It turns the
per-run scorecards the scoring layer produces into a readable value-add report,
persists them to a durable store, and compares two stored runs so the value-add
can be tracked over time. It adds **no new statistics**: every number it prints
is sourced from [`../score/differential.js`](../score/differential.js) and
[`../metrics/variance.js`](../metrics/variance.js), so the report is a faithful
rendering of the measurement contract
([`../metrics/README.md`](../metrics/README.md)), not a second interpretation of
it.

## Modules

| Module          | Responsibility                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `render.js`     | Render the value-add report (Markdown) from a corpus of per-run scorecards.                          |
| `persist.js`    | Append-only, stamped scorecard store (NDJSON) — the durable substrate for over-time tracking.        |
| `compare.js`    | Surface the per-dimension deltas between two stored runs, with the real-delta rule and cohort safety. |

## `render.js` — the value-add report

`renderReport({ scorecards, method })` takes a flat list of scorecards (all
`scenario × arm × run` for **one cohort**) and returns the full Markdown report:

1. **Cohort header** — the pinned model, framework version, and environment the
   corpus was measured at, so a reader only ever compares like-to-like. A corpus
   that mixes cohorts is flagged, never silently averaged.
2. **Dimension distributions** — for every scenario, each of the five dimensions
   (Quality, Planning fidelity, Autonomy, plus the Efficiency vector components
   and Overhead ratio) is rendered as a **noise-band per arm** (`center [low,
   high]`), never a bare point estimate, alongside the **Mandrel-vs-bare delta**
   and its **verdict** against the noise floor (`real` / `within noise` /
   `n/a`). Planning fidelity is `n/a` for the control arm (it authors no plan).
3. **Per-difficulty scaling view** — Efficiency (absolute tokens) and Overhead
   ratio across the difficulty ladder for **both arms**, with the
   **monotonicity** verdict. A violation (efficiency that does not rise, or an
   overhead ratio that does not fall, as difficulty increases) is surfaced as an
   explicit **calibration warning**.
4. **Recommended improvements** — a clearly-delineated section of actionable,
   evidence-linked findings:
   - the **overhead-floor estimate** (always surfaced), with a **ceremony-lite**
     recommendation when a positive floor on `hello-world` buys no quality gain;
   - **monotonicity violations** routed to a recalibration action;
   - any **real value-dimension regression** where the bare control arm beats
     Mandrel (a regression the scaffolding should not cause).

`buildReportModel(...)` returns the same data in structured form for callers
that want the findings programmatically rather than by parsing Markdown.

The renderer is **pure and deterministic**: the same corpus renders
byte-for-byte identically, so a persisted report is diffable across runs.

## `persist.js` — the append-only store

A benchmark store is a historical ledger. `appendScorecards({ storePath,
scorecards })` validates every scorecard's **stamp** (`runId`, `model.id`,
`frameworkVersion`, `env.node`, `env.os`, `scenario`, `arm`) and **schema
version**, then appends them as NDJSON — one JSON object per line, never
rewriting existing records. A batch with any un-stamped record is rejected
**atomically** (nothing is written), because the store's whole point is that a
later comparison only compares like-to-like, which is impossible without a
complete stamp.

NDJSON + append-only matches the harness's other ledgers
(`lifecycle.ndjson`, `signals.ndjson`): crash-safe (a torn final line never
corrupts earlier records), greppable, and diffable.

- `readStore({ storePath })` reads every persisted scorecard back (a
  never-written store reads as empty, not an error).
- `groupByCohort(scorecards)` buckets the store by `cohortKey` so a caller can
  pull "all runs for this (model, framework version, env)" out of a mixed store.

The validation + serialization core is pure; only `appendScorecards` /
`readStore` touch the filesystem, and both accept injectable I/O shims so the
core is unit-testable with no real disk.

## `compare.js` — over-time comparison

`compareRuns({ baseline, candidate, method })` surfaces the **per-dimension
deltas** between two stored runs (each a scorecard array, typically read from
the store and filtered to one cohort). For every shared scenario and every
comparable metric it reports the per-arm centers and the **Mandrel-arm cross-run
shift**, applying the **same real-delta rule** the single-run differential uses
(`|shift| > max(spread_baseline, spread_candidate)`) so a center that wobbled
inside the band is `within-noise`, not a spurious `improved` / `regressed`.

It refuses to silently compare across cohorts: a baseline and candidate stamped
with a different `(model, framework version, env)` set `cohortMatch: false` and
carry a `cohortMismatchWarning` — the deltas are still computed (a deliberate
cross-version diff is a legitimate operator action) but the mismatch is always
labelled. `renderComparison(comparison, { baselineLabel, candidateLabel })`
renders it as Markdown.

## Determinism

Every module is pure (modulo the thin FS shell in `persist.js`): no clock, no
randomness, no hidden state. The report and comparison are functions of their
inputs alone, so they are reproducible and safe to snapshot.
