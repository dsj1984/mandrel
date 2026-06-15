---
description:
  Unified delivery entry point. Inspects the ticket type(s) and
  Epic-reference state of the supplied IDs, composes a sequential segment
  plan over any mix of Epics and standalone Stories, then delegates each
  segment to the Epic wave loop or the standalone multi-Story fan-out —
  preserving every flag and the parallel-delivery contract of the retired
  commands.
---

# /deliver [Epic IDs...] | [Story IDs...]

## Role

Router. `/deliver` owns input classification, segment-plan composition, and
path selection only — all phase content lives in the two path helpers:

- [`helpers/deliver-epic.md`](helpers/deliver-epic.md) — the full Epic
  delivery loop (preflight, wave loop fanning out
  [`helpers/epic-deliver-story`](helpers/epic-deliver-story.md),
  close-validation, epic-audit, code-review, retro, finalize, watch,
  auto-merge gate, cleanup).
- [`helpers/deliver-stories.md`](helpers/deliver-stories.md) — the
  standalone multi-Story path (`stories-wave-tick.js` continuous ready-set
  loop, operator confirmation, parallel fan-out to
  [`helpers/single-story-deliver`](helpers/single-story-deliver.md)).

## Input matrix (authoritative)

Fetch each supplied ID's labels and body (`type::*` label, `Epic: #N`
reference) before routing:

| Input | Route |
| --- | --- |
| Exactly one `type::epic` ID | **Epic path** — run [`helpers/deliver-epic.md`](helpers/deliver-epic.md) Phases 1–9 unchanged (single-segment plan; no confirmation prompt). |
| One or more `type::story` IDs, none carrying an `Epic: #N` reference | **Standalone path** — run [`helpers/deliver-stories.md`](helpers/deliver-stories.md) Phases 0–3 (single-segment plan; no confirmation prompt). |
| Any combination of ≥1 `type::epic` IDs and ≥0 standalone `type::story` IDs | **Segment plan** — compose and execute the sequential segment plan below. |
| Any Story carrying an `Epic: #N` reference (alone or mixed into an otherwise-valid set) | **Error**, naming every affected ID and the fix: `Story #<id> belongs to Epic #<n> — run /deliver <n>`. |

Per-ID classification is unchanged: fetch the `type::*` label and probe the
body for an `Epic: #N` reference before routing. Never guess a route.

## Segment plan (mixed / multi-Epic input)

When the supplied IDs span more than one Epic, or mix Epics with standalone
Stories, the router composes a **segment plan** and executes the segments
**strictly sequentially**:

1. **Standalone segment first** (when any standalone Story IDs are
   present): the full standalone-Story set forms **one** segment,
   delivered via [`helpers/deliver-stories.md`](helpers/deliver-stories.md)
   Phases 0–3 unchanged. It runs first because it is fast, each Story
   merges to `main` independently, and each subsequent Epic segment's
   Phase 7.0 base-sync then integrates those merges naturally instead of
   the Epic PR opening behind base.
2. **Epic segments in input order**: each `type::epic` ID forms its own
   segment, delivered via
   [`helpers/deliver-epic.md`](helpers/deliver-epic.md) Phases 1–9
   unchanged.

Sequential execution is a deliberate design decision: the Epic path assumes
a single main checkout (prepare's checkout guard, Phase 7.0
`git checkout epic/<id>`), holds a per-Epic lease, serializes same-machine
sessions via `epic-merge-lock.js`, and constrains dispatch to one wave at a
time. Segments are never interleaved or parallelized; running them one at a
time keeps both helpers' machinery untouched.

**Confirmation gate.** When the composed plan has more than one segment,
present it to the operator before dispatching — the segments, the IDs in
each, and the execution order — and wait for confirmation. `--yes`
suppresses this prompt. Single-segment plans route directly with today's
behavior (no new prompt; the standalone path's own Phase 1 confirmation
still applies as before).

**Failure policy.** A segment that ends non-complete (blocked, failed, or
halted at a gate) **stops the run** — no subsequent segment dispatches.
Report the terminal state: which segments completed, which segment halted
(and why), and which segments never started. Name the resume command:
re-running `/deliver` with the same IDs — both path helpers short-circuit
already-done work (the Epic path resumes idempotently from its checkpoint;
merged standalone Stories no-op).

## Flags (scoped per segment)

| Path | Flags |
| --- | --- |
| Epic | `--skip-epic-audit`, `--skip-code-review`, `--skip-retro`, `--full-retro`, `--steal`, `--as <handle>` |
| Story | `--dep <from>:<to>`, `--yes`, `--concurrency <n>` |

In a segment plan, Epic-path flags apply to **every** Epic segment;
Story-path flags apply to the standalone segment. `--yes` additionally
suppresses the router's segment-plan confirmation gate above. A flag with
no applicable segment in the plan is reported once as a no-op warning and
ignored — never an error (the existing convention, restated for segment
plans).

**Multi-Story parallel contract (preserved verbatim).**

```text
/deliver <id> <id> … --dep <from>:<to> --concurrency <n> --yes
```

preserves the retired multi-Story command's full surface — the same flags,
the same operator confirmation gate (suppressed by `--yes`), and the same
parallel fan-out to
[`helpers/single-story-deliver`](helpers/single-story-deliver.md) — but
schedules through `stories-wave-tick.js`'s **continuous ready-set loop**
(the shared `selectReadySet` core) rather than a static wave plan: each
Story dispatches the instant its own dependencies are done, capped by the
resolved global `concurrencyCap` and guarded against file-overlap
co-dispatch, exactly as the Epic path is. The parallelism lives **inside**
the standalone segment; segments themselves remain strictly sequential.

## Procedure

1. **Parse args.** At least one positive-integer ID is required.
2. **Classify.** Fetch each ticket's labels + body and apply the input
   matrix above. Any Epic-attached Story ID is a hard error naming the
   affected IDs and the fix — never guess a route.
3. **Compose the segment plan.** Standalone-Story set (when present) as
   one segment, then one segment per Epic ID in input order. For a
   multi-segment plan, present it and wait for operator confirmation
   (`--yes` suppresses).
4. **Execute segments sequentially.** For each segment in order, read the
   selected path helper **in full** and execute it from its entry phase,
   forwarding the segment's scoped flags. The helper's phase numbering,
   watchdogs, gates, and scripts are unchanged — this router adds no phase
   content. Stop on the first non-complete segment per the failure policy.
5. **Report.** On completion (or halt), summarize per-segment outcomes and,
   when halted, the resume command.

## Constraints

- `/deliver` requires planned tickets: Epics at `agent::ready` (the
  Epic helper's preflight enforces this, per segment) or well-formed
  standalone Stories. Planning happens in [`/plan`](plan.md); the
  plan-review gate between the two commands is a hard boundary.
- The router performs no git or label mutations itself; the path helpers
  own every script invocation.
- Segments execute strictly sequentially — never interleave a standalone
  Story fan-out with an Epic wave loop, and never run two Epic segments
  concurrently.

## See also

- [`/plan`](plan.md) — the unified planning entry point.
- [`helpers/deliver-epic.md`](helpers/deliver-epic.md) /
  [`helpers/deliver-stories.md`](helpers/deliver-stories.md) — the path
  helpers, delegated to per segment.
