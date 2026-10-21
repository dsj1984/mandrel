---
description: Evidence-cited leverage review — draft five to twelve bets on how the project could be ~10x more useful, reliable or valuable, refute most of them with two maker-blind skeptics each, write the survivors, downgrades and refutations to temp/leverage/<run-id>/bets.md, and hand each survivor to /mandrel-plan behind a HITL gate.
---

# /mandrel-leverage

Ask "how could this be 10x more useful, reliable or valuable" and make the
answer **survive its own refutation** before any of it becomes a Story. The
run gathers evidence (Phase 0), drafts bets that cite it (Phase 1), puts every
bet in front of two independent skeptics (Phase 2), writes one bets document
(Phase 3), and offers each survivor to the operator as a plan seed (Phase 4).

It is a front-end to [`/mandrel-plan`](mandrel-plan.md) in the same sense
[`/qa-assist`](qa-assist.md) and [`/audit-to-stories`](audit-to-stories.md)
are: it produces a seed and chains into plan. It **never persists an issue,
never mutates a label, and never starts delivery** — filing is
`/mandrel-plan`'s, behind the hand-off gate. Audits find defects against a
standard; this workflow prices upside, so a bet that does not clear the bar is
recorded as refuted, not filed as a finding.

## Slash Command

```text
/mandrel-leverage [<focus>] [--bar <multiplier>] [--evidence <path> ...]
```

### Arguments

| Name         | Required | Shape / Example              | Notes                                                                                                   |
| ------------ | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<focus>`    | no       | `"per-Story token cost"`     | Narrows the question to one axis or subsystem. Omitted, the run is `general`.                           |
| `--bar`      | no       | `--bar 5`                    | The multiplier a bet must clear to survive. Default `10` — the name's promise.                          |
| `--evidence` | no       | `--evidence temp/cost.md`    | Repeatable. Operator-supplied files (a cost report, a usage export, user feedback) added to the evidence set. |

`<run-id>` is `<YYYYMMDD>-<focus-slug>`, or `<YYYYMMDD>-general` with no focus.
Every artifact the run writes lives under `temp/leverage/<run-id>/`.

## Phase gates (HITL)

Gating is **light within a phase and firm at the boundary**, mirroring
[`/qa-assist`](qa-assist.md) § Phase gates. Phases 0–3 read, draft, dispatch
and write the local bets document without ceremony. **Every write that leaves
the local bets document is operator-confirmed individually**: each seed write
and each `/mandrel-plan` invocation is asked about and waited on, one at a
time. The plan → deliver hard stop is preserved.

---

## Phase 0 — Evidence intake (read-only)

Goal: fix the evidence set before any bet is drafted. Read, and list in the
bets document's `## Evidence set` with paths:

1. **The docs digest set** (`project.docsContextFiles`): the roadmap's
   Someday items, the decisions log's Accepted and Rejected entries, and the
   architecture overview. Read digest-first and pull sections on demand.
2. **The committed quality baselines** (the `baselines/` tree, when present)
   as hotspot evidence — where complexity, churn and coverage debt sit.
3. **Friction signals.** Every `signals.ndjson` stream under the temp root —
   per-run `temp/run-<id>/signals.ndjson` and standalone
   `temp/standalone/stories/story-<sid>/signals.ndjson` — rolled up by `kind`
   and `category` (record shape:
   [`signal-event.schema.json`](../schemas/signal-event.schema.json); where
   the records come from:
   [`execution-reference.md` § Friction telemetry](../docs/execution-reference.md#friction-telemetry)).
4. **Every `--evidence` file** the operator passed.
5. **Prior runs.** The `## Refuted` and `## Downgraded` sections of every
   prior `temp/leverage/*/bets.md`. A prior refuted bet is **carried forward
   as refuted unless new evidence names what changed**; never re-litigate a
   refutation silently. A re-proposed bet cites the prior run and the new
   evidence that reopens it.

Phase 0 writes nothing but the run directory.

---

## Phase 1 — Diverge

Goal: draft **between five and twelve bets**, each one block:

- **slug** — kebab-case, unique within the run.
- **axis** — `useful` (to users), `reliable`, or `valuable`.
- **claim** — a multiplier on a named, measurable quantity
  (e.g. "10x fewer operator interventions per delivered Story").
- **mechanism** — one paragraph: why the change moves that quantity.
- **evidence** — citations as `path:line` or a signal roll-up figure;
  **every bet carries at least one `path:line` or signal citation**. A bet
  with no citation is not drafted.
- **must be true** — what would have to hold for the multiplier to
  materialize.
- **cost** — a rough size in Stories.

A `<focus>` narrows the drafting; it does not lower the citation bar.

---

## Phase 2 — Skeptics (maker-blind)

Goal: refute what does not hold. This is the load-bearing invariant.

**Dispatch.** For every bet, dispatch **two independent
`subagent_type: general-purpose` skeptics in one turn**, all bets' skeptics
together. Each skeptic is handed **only the bet block and the evidence
paths** — never the drafting reasoning, never the other skeptic's verdict,
never a prior verdict. A skeptic that reads the maker's case grades the case,
not the bet; the same reasoning as
[`plan-critic.md` § Maker-blind](../agents/plan-critic.md). The `plan-critic`
role is a pre-mortem over an authored plan draft, a different charter — do not
dispatch it here.

**Skeptic charter** (paste it into each dispatch):

> Assume this bet shipped and the multiplier did not materialize. Name the
> most likely reason, with the evidence that supports it — read the cited
> paths yourself. Then credit the multiplier the evidence actually supports.
> Return one verdict block:
>
> - `verdict` — `holds` | `downgraded` | `refuted`
> - `credited` — a number (the multiplier you credit)
> - `reason` — one paragraph with `path:line` citations
> - `missing-evidence` — what evidence would change your verdict

**Scoring.** With `bar` the `--bar` value (default `10`):

- **survivor** — both skeptics credit at least the bar.
- **downgraded** — both credit at least 3, but one is below the bar.
- **refuted** — anything else.

**The caller never overrides a verdict.** It may re-draft a bet once with new
evidence and re-dispatch two fresh skeptics; the second pair's verdicts are
final.

---

## Phase 3 — Converge

Goal: write the one artifact, `temp/leverage/<run-id>/bets.md`, with these
sections in order:

- `## Evidence set` — every path read in Phase 0, plus the signal roll-up.
- `## Survivors` — ranked by the **lower** credited multiplier; each bet
  block with both verdicts.
- `## Downgraded` — each bet block with both verdicts.
- `## Refuted` — every refuted bet with its refuting reason, kept so the next
  run inherits it.
- `## Missing evidence` — the union of what the skeptics asked for: the
  run's instrumentation backlog.

`bets.md` and the per-survivor seeds are the only files a run writes; nothing
lands under `docs/`.

---

## Phase 4 — Hand-off (HITL-gated)

Goal: turn survivors into plan seeds only where the operator says so.

1. **Offer each survivor, one at a time**, with the host's question idiom:
   **file as a plan seed**, **defer**, or **drop**. Show the bet block and both
   verdicts.
2. **On file**, confirm the seed write, then write
   `temp/leverage/<run-id>/seed-<slug>.md` carrying the bet, both verdicts and
   the evidence paths.
3. **Confirm the plan invocation**, then chain into the planning entrypoint:

   ```text
   /mandrel-plan --seed-file temp/leverage/<run-id>/seed-<slug>.md
   ```

   `/mandrel-plan` owns interrogation, authoring and persistence from there.
4. **No survivor** → the run ends at the bets document, and its
   `## Missing evidence` section is the recommendation.

Every seed write and every `/mandrel-plan` invocation is confirmed
individually; one approval never covers the next survivor.

---

## Constraints

- **Read-only outside `temp/leverage/`.** The workflow never persists an
  issue, never mutates a label, and never starts delivery.
- **Citations or nothing.** No bet is drafted, and no skeptic verdict is
  scored, without a `path:line` or signal citation.
- **Maker-blind skeptics.** Bet block and evidence paths only; the caller
  never overrides a verdict.
- **Refutations persist.** A prior refuted bet stays refuted unless new
  evidence names what changed.
- **No project-specific refutations ship.** An operator may seed a first
  run's `## Refuted` by hand from an earlier review.

## See also

- [`/mandrel-plan`](mandrel-plan.md) — the planning pipeline Phase 4 chains
  into; the plan → deliver hard stop is preserved across the handoff.
- [`/qa-assist`](qa-assist.md) — the precedent for light-within, firm-at-boundary
  gating and the confirmed `/mandrel-plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for chaining
  `/mandrel-plan --seed-file`.
