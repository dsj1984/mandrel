---
description: Audit the committed baseline surface — dead instruments, stale baselines, cross-gate hotspot clusters, trend drift, and floor-tightening headroom — and emit findings whose remediation burns the measured debt down and tightens the ratchet behind it.
---

# Baseline & Ratchet Audit

You are a Principal Engineer and Quality-Systems Owner auditing this
repository's **committed baseline surface**: the ratchet artifacts under
`baselines/` and the gate floors under `delivery.quality.gates` in
`.agentrc.json`. Those instruments only prevent **regression** — nothing owns
the loop that burns the measured debt **down** and tightens the floors behind
it, so a repo can hold a floor it cleared years ago and never notice. This lens
is that loop's read-only entry point. The shared lens machinery — read-only
constraint, scope interpretation, report envelope + finding-block skeleton,
severity scale, self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-baselines-results.md`. Dimension values:
`Dead Instrument | Staleness | Hotspot Cluster | Trend Drift | Tightening Headroom`.

> **Value-free titles (mandatory).** A finding title MUST NOT embed a measured
> number — write ``### `baselines/crap.json` — crap floor holds unused slack``,
> not ``… — crap floor 13 vs measured 8``. Every re-run re-measures, so a title
> carrying the reading changes each pass, its fingerprint changes with it, and
> `/audit-to-stories` files a duplicate instead of deduping against the open
> Story. Numbers belong in Current State, never in the title.

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

When the fence resolves to a file list, keep only Hotspot Cluster findings
whose cluster key is in that list. The other four dimensions are properties of
the instrument set as a whole rather than of any changed file, so report them
only in codebase-wide mode.

## Constraint (lens-specific carve-out)

This lens **refines** the core's read-only constraint; it never relaxes it.

- The only command it runs is the read-only engine in Step 0. It never runs a
  test, coverage, mutation, duplication, or lint suite.
- It never writes under `baselines/` and never edits `.agentrc.json`. It never
  invokes an `update-*-baseline` script. **Regeneration is a finding, never an
  in-run step** — the remediation Story owns every write to the surface.
- Reading committed baseline rows is explicitly permitted and required: citing
  an already-computed metric is analysis, not measurement.

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 0: Run the engine (mandatory — measure before you judge)

```bash
node .agents/scripts/audit-baselines.js --out temp/audit-baselines/envelope.json
```

Optional flags: `--cwd` (repository root), `--top-n` (outlier rows per gate,
default 20), `--hotspot-limit` (clusters emitted, default 50), `--trend-depth`
(baseline commits sampled per kind, default 5). Exit 0 means evidence was
assembled **including every degraded input**; exit 1 means the envelope could
not be built or written — report that and stop, because no evidence base
exists to author against.

The envelope is validated against
`.agents/schemas/baselines/audit-baselines-envelope.schema.json` and is this
lens's sole evidence base. Cite its fields by name:

| Section | Fields you cite |
| --- | --- |
| root | `generatedAt`, `cwd`, `topN`, `configError`, `degradations` |
| `gateSurface[]` | `kind`, `surface`, `baselinePath`, `configured`, `baselineExists`, `stub`, `rowCount`, `measured` (`unit` plus `value`), `generatedAt`, `staleDays`, `staleCommits`, `surfaceStale`, `deadIgnoreGlobs`, `parseError` |
| `hotspots[]` | `path`, `gates` (each `kind`, `metric`, `value`, `rowCount`, `severityWeight`), `gateKinds`, `gateCount`, `severityWeight`, `churnWeight`, `centralityWeight`, `frictionWeight`, `rank` |
| `trend[]` | `kind`, `baselinePath`, `sampleCount`, `from`, `to` (each a `sha` plus `committedAt`), `deltas` |
| `headroom[]` | `kind`, `axis`, `floor`, `measured`, `direction`, `headroom` |

`surface` is `gate` (a closed `delivery.quality.gates` kind) or `ratchet` (an
out-of-band baseline the CI baselines job owns). `direction` is `gte` or `lte`.
`rowCount` counts rows **after** per-file aggregation; `measured` is the
quantity the instrument reports, in its own unit. Cite `measured` when the two
disagree — 589 dead-export symbols sit in 187 files.

Two envelope-level reads come **before** any finding:

- **`configError` non-null.** Floors, target directories, and ignore globs
  were unavailable and the engine fell back to default baseline paths. Every
  Tightening Headroom finding would be unfounded this run: file the config
  failure itself as one `Dead Instrument` finding and skip that dimension.
- **`degradations`.** Each of `gitHistory`, `importGraph`, `frictionLedger`
  reading `true` collapsed its rank multiplier to exactly 1.0, so the hotspot
  ordering is weaker evidence. Name the degraded inputs in the Executive
  Summary; never present a degraded rank as a churn-informed one.

## Step 1: Evaluation Dimensions

1. **Dead Instruments.** An instrument that cannot fail is worse than none: it
   reads green forever and the surface it names looks governed. Four shapes,
   read straight off `gateSurface[]`:
   - `stub` is `true` — zero rows **and** an all-zero rollup, so the gate
     passes vacuously. The engine requires both halves, so a ratchet with
     genuinely nothing to report is never mistaken for a dead one.
   - `configured` is `false` on a `gate` row — a baseline is committed but no
     `delivery.quality.gates` block enforces it, so nothing reads it.
   - `baselineExists` is `false`, or `parseError` is non-null — the instrument
     cannot be read at all.
   - `deadIgnoreGlobs` is non-empty — a configured ignore pattern matches zero
     files. It protects nothing today and silently exempts the next file that
     happens to match it.

   Grade a stub or unenforced gate **Medium**, a `parseError` on an enforced
   gate **High** (delivery reads that file every run), a dead glob **Low**.

2. **Staleness.** Two clocks. `staleDays` is whole days since the baseline's
   own `generatedAt`; `staleCommits` is commits touching the measured surface
   since the baseline was last committed, with `surfaceStale` its boolean. A
   `null` on either is never a fabricated zero — the stamp is unreadable, git
   cannot answer, or the rows are not file paths — and is itself the finding.
   **`surfaceStale` with `staleDays: 0` is still stale:** refreshed recently in
   wall time, already behind the surface it scores. Grade an enforced gate
   stale beyond roughly a month or `surfaceStale` **Medium**, a `null` stamp
   **Medium**, an unenforced kind **Low** or **Info**.

   **Regeneration is the remediation, never an in-run step.** The Agent Prompt
   names the matching script and its one-shot acknowledgment:

   | Kind | Regeneration script | Acknowledgment |
   | --- | --- | --- |
   | `coverage` | `npm run coverage:reanchor` | `COVERAGE_REFRESH=1` |
   | `crap` | `npm run crap:reanchor` | `CRAP_REFRESH=1` |
   | `duplication` | `npm run duplication:reanchor` | `DUPLICATION_REFRESH=1` |
   | `maintainability` | `npm run maintainability:reanchor` | `MAINTAINABILITY_REFRESH=1` |

   **Prescribe the `:reanchor` script, never the bare `:update` one.** Every
   updater defaults to a **diff-scoped** refresh — only files changed in
   `origin/main..HEAD` are re-scored, and everything else is preserved
   verbatim. That is the right default for "I changed code, re-score what I
   touched", and it is exactly wrong here: a baseline is stale because the
   *world* moved (a scorer bump, a coverage-shape change, months of unrelated
   drift), so a diff-scoped run leaves almost every stale row untouched and
   the staleness finding re-fires on the next sweep. `:reanchor` is the same
   script with `--full-scope`, which re-scores every file in every target
   dir. Confirm the flag on any kind you are unsure of with that script's
   `--help`.

   Expect a re-anchor to touch far more rows than a code change would — that
   breadth is the point, but say so in the finding so a reviewer can tell a
   re-anchor from a mass regression.

   The acknowledgment is the kind upper-snaked. It demotes that kind's
   head-vs-base regressions to unchanged **for one run only** — floors stay
   enforced, so a genuine breach is still caught. The durable equivalent is a
   commit in the compared range whose subject carries the fixed refresh tag
   `baseline-refresh:` **and** whose diff touches that kind's
   baseline file. Confirm both against
   `node .agents/scripts/check-baselines.js --help` before writing the prompt,
   and never invent an acknowledgment for a kind that ships no regeneration
   script — there, the remediation is to add one, not to hand-edit rows.

3. **Hotspot Clusters.** `hotspots[]` is already the cross-gate join, one entry
   per cluster key, ranked highest first. **Emit one finding per cluster —
   never one per metric row.** A file that is a CRAP outlier and a
   maintainability outlier is one debt item with two symptoms; splitting it
   files two Stories that fight over the same refactor. The cluster key is a
   repository file path for every kind except `lighthouse` (a route) and
   `bundle-size` (a bundle name) — say which it is when it is not a file.

   Quote `rank` with the four factors behind it — `severityWeight`,
   `churnWeight`, `centralityWeight`, `frictionWeight` — and the per-gate rows
   under `gates`. Grade by breadth first: three or more entries in `gateKinds`
   is **High**, two is **Medium**, one is **Low** unless its `severityWeight`
   alone is extreme.

4. **Trend Drift.** `trend[]` carries newest-versus-previous rollup deltas per
   kind, bracketed by the commits in `from` and `to`. A delta moving **away**
   from the floor is the finding; one moving toward it is headroom the next
   dimension owns. Read the axis's `direction` in `headroom[]` before assigning
   a sign — lower is not universally better. An entry needs `sampleCount` of at
   least 2 to mean anything, and an empty `trend[]` means no readable history:
   record that as **Info** rather than inferring a flat trend from silence.
   Each `deltas` key **names its unit** — `symbols`, `bytes`, `filesTracked` —
   so quote the axis with the number, never a bare delta.

5. **Tightening Headroom.** `headroom[]` is what this lens exists for. Positive
   headroom is slack the floor could be tightened into; negative headroom means
   the floor is already breached — grade that **High** and route it as a
   regression, not an opportunity. File a tightening finding only when the
   slack is **durable**: the same kind's trend is flat or improving. A one-run
   dip tightened into a floor turns the next honest change red for no defect.
   Grade durable multi-point slack **Medium**, marginal slack **Low**.

## Step 2: Hotspot budget and the dropped log

Cap the Detailed Findings at the **top 8 hotspot clusters by `rank`**. The
engine emits up to `--hotspot-limit` clusters, and the point of the lens is a
ranked actionable batch, not an exhaustive dump nobody schedules.

A silent truncation reads as full coverage, so the report MUST carry a
**Dropped Hotspots** section naming every cluster the cap excluded with its
cluster key, `rank`, and `gateKinds`. Write `_None dropped._` when the cap did
not bite; the section's absence is itself a defect. This budget log is separate
from — and additional to — the core's self-cross-check `kept / dropped` line,
which counts evidence-bar drops rather than budget drops. State the cap in the
Executive Summary and change it only on an explicit operator instruction.

## Step 3: The floor-tightening contract (mandatory)

A remediation Story that only burns debt down leaves the floor where it was,
and the reclaimed slack is silently re-spent by the next change — the loop
runs and the ratchet never moves. So **every Hotspot Cluster and Tightening
Headroom finding's Agent Prompt MUST** end the remediation with the ratchet
tightened and gate-enforced:

1. Lower the floor under `delivery.quality.gates` in `.agentrc.json` to the
   newly measured level, **or** delete the burnt-down rows from that kind's
   file under `baselines/`.
2. Carry `node .agents/scripts/check-baselines.js --gate <kind>` in the
   remediation Story's `verify[]`, so the tightened floor is enforced by the
   gate that already exists at that Story's delivery time rather than by prose
   nobody runs.

Use these two Agent Prompt templates verbatim, substituting the envelope's own
values for the angle-bracketed slots:

- **Hotspot Cluster template:**
  `Burn down the measured debt in <hotspots.path>, an outlier across <gateKinds>. Refactor and add tests until its rows leave that kind's file under baselines/, then regenerate that baseline with the matching update-*-baseline script in a commit whose subject carries the baseline-refresh: tag. Finish by TIGHTENING the ratchet in the same Story — lower the kind's floor under delivery.quality.gates in .agentrc.json to the new measured level, or delete the burnt-down rows — and carry node .agents/scripts/check-baselines.js --gate <kind> in this Story's verify[] so the tightened floor is enforced at delivery.`
- **Tightening Headroom template:**
  `The <kind> gate's <axis> floor sits at <floor> while the measured rollup is <measured> (headroom <headroom>, direction <direction>), and that kind's trend is flat or improving. Tighten it: set that axis under delivery.quality.gates in .agentrc.json to the measured level so no slack remains for the next change to re-spend, and carry node .agents/scripts/check-baselines.js --gate <kind> in this Story's verify[] so the new floor is enforced. Regenerate no baseline in this Story — the floor edit is the whole change.`

Staleness, Dead Instrument, and Trend Drift findings do **not** carry the
tightening clause: there is no measured slack to claim until the instrument is
alive and current again.

## Step 4: Cadence (host-owned — documented, never scheduled)

This lens ships **no scheduler**, and building one is out of scope; cadence
belongs to the host that invokes it. Document the intent and let the operator
or the host's own timer drive it: **monthly** for a codebase-wide pass (long
enough for `trend[]` to hold signal, short enough to catch a stale instrument
before a release leans on it); **after a large refactor lands**, when headroom
appears and is most likely to be silently re-spent; and **before any floor is
raised**, so the raise is argued against measured headroom rather than
convenience. Nothing here self-triggers.

## Step 5: Hand off to `/audit-to-stories`

The report is the deliverable. Hand it to the converter, which parses the
shared finding skeleton, fingerprints each finding for dedupe, and groups the
batch:

```bash
node .agents/scripts/audit-to-stories.js --scan --glob temp/audits/audit-baselines-results.md --out temp/audits/audit-to-stories-plan.json
```

Report the plan path and the group count; the converter owns everything
downstream, including whether a finding becomes a Story at all.

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this report carries its own title, a Gate Surface Health table, a
Tightening Ledger, and the Dropped Hotspots budget log:

```markdown
# Baseline & Ratchet Audit Report

## Gate Surface Health

| Kind | Surface | Configured | Rows | Measured | Stale (days) | Stale (commits) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [kind] | [gate / ratchet] | [yes / no] | [rowCount] | [measured.value measured.unit] | [staleDays or `null`] | [staleCommits or `null`] | [Live / Stub / Unenforced / Unreadable] |

## Tightening Ledger

| Kind | Axis | Floor | Measured | Headroom | Trend | Proposed floor |
| --- | --- | --- | --- | --- | --- | --- |
| [kind] | [axis] | [floor] | [measured] | [headroom] | [improving / flat / worsening] | [value] |

## Dropped Hotspots

| Cluster key | Rank | Gates |
| --- | --- | --- |
| [key] | [rank] | [gateKinds] |
```
