---
description:
  Unified delivery entry point. Takes Story ids or a plain-language prompt,
  derives which path the work belongs on, and lands it via the single
  deliver-story engine — story-<id> → PR → main.
---

# /mandrel-deliver

> **Lean spine.** Happy path + gate list. Sequencing, dispatch mechanics, intent
> phrases, ceremony and the epilogue live in on-demand
> [`helpers/deliver-reference.md`](helpers/deliver-reference.md) ("reference"
> below); the unplanned path in
> [`helpers/deliver-light.md`](helpers/deliver-light.md). Every delivery reads
> [`helpers/deliver-digest.md`](helpers/deliver-digest.md) once.

## Role

One delivery door. `/mandrel-deliver` owns input resolution, sequencing and the
close-and-land tail; Stories are implemented via
[`helpers/deliver-story.md`](helpers/deliver-story.md).

The dependency graph is **discovered, not declared** — `resolve-stories.js`
reads it from live state, so you can deliver Stories **across plan runs and over
time**. `plan-run::<id>` is filter metadata, never a resolution input.

## Inputs

Classify what the operator typed **before** anything else, and say which shape
you read:

| Invocation | Shape | Behavior |
| --- | --- | --- |
| `/mandrel-deliver` | bare | List the open `agent::ready` Stories and ask which to deliver. Deliver nothing until answered. |
| `/mandrel-deliver 4712` | ids | One Story via `helpers/deliver-story.md`, **inline in this session** — no `story-worker` spawn. |
| `/mandrel-deliver 4712 4713 …` | ids | Resolve the set, then beat `deliver-run.js` — it sequences by the discovered graph and hands back the spawns and closes. |
| `/mandrel-deliver 4712 - 4716` | ids | A **range** — every id in the inclusive span. |
| `/mandrel-deliver 4700` (a `type::epic`) | ids | The Epic's **open** child Stories. Mixes with Story ids. |
| `/mandrel-deliver add a --json flag to doctor` | prompt | Unplanned work: gate, author a receipt Story, land it — [`helpers/deliver-light.md`](helpers/deliver-light.md). |

**The discriminator is lexical and total.** An argument matching `^#?\d+$` is an
id, and `^#?\d+\s*[-–—]\s*#?\d+$` an inclusive **range** — pass one on as a
single unspaced token, never hand-expanded (reference). Either shape
means ids; anything else means a prompt. A **mixed** invocation (ids *and*
prose) is **ambiguous, not fatal** — disambiguate it rather than refusing:
ask which was meant, or, when the reading is obvious, name the one you
inferred before acting on it. A ticket that is neither `type::story` nor
`type::epic` is a **hard error**.

## Saying what you want

No flags to remember: state intent — *"…but I'll merge it myself"*, *"…one at a
time"* — and announce what you read. Phrasings and the flags they fill in:
reference § Intent phrases.

`--yes` is **runner-set, never operator-typed**: cron, `/loop` and headless
dispatch set it to mean *nobody is at the keyboard*, which fails the unplanned
path's over-scope stop closed to an envelope instead of a question. Never add it
to an attended run.

## Procedure

0. **Classify and announce.** Read the invocation per § Inputs and state the
   shape. A prompt leaves for
   [`helpers/deliver-light.md`](helpers/deliver-light.md); bare asks; ids go on.

1. **Resolve the set.** One command, one Story or many:
   `node .agents/scripts/resolve-stories.js --ids <id,id,...>`. It validates the
   set and shows what will run: read `stories[]`, `dag[]` and `done[]` to
   present the order in step 2, but do **not** thread them into step 3 — every
   beat re-resolves the graph. A one-id run comes back `dispatchMode: "inline"`
   and runs [`helpers/deliver-story.md`](helpers/deliver-story.md) in this
   session; step 3 is the multi-Story path. An Epic id expands to its open child
   Stories first — **announce it**. It hard-errors (exit 1) on an id that is
   neither a Story nor an Epic, on an Epic with no open children, or on edges
   it cannot read — a missing gate would co-dispatch against an unlanded
   blocker.

2. **Confirm (N>1).** Present the order; wait unless `--yes`.

3. **Run the beat.** One command per beat, repeated until the envelope reports
   the run `done`:

   ```bash
   node .agents/scripts/deliver-run.js \
     --stories <id,id,...> [--handoff <id>]...
   ```

   **Do not add `--concurrency` unless the operator explicitly asked for a
   per-run cap** — an explicit value wins over config, so a literal defeats a
   `.agentrc.local.json` override.

   Each beat re-probes live state and keeps its own accounting: the run ledger
   under `<tempRoot>/run-<id>/` records every id it hands out, so **nothing is
   maintained across beats by you**. Cross-run de-confliction via the assignee
   lease is automatic. Branch on the exit code:
   - **0** — spawn one `story-worker` per `ready[]` entry, **all in one turn**,
     each with that entry's `promptPath` file as its prompt; run each `close[]`
     entry's command foreground and serialized as hand-offs arrive. An empty
     `ready` with work in flight means "waiting", so beat again — **unless
     `stalledDispatch[]` is non-empty**: those ids were dispatched but still
     read `agent::ready`, which is a live init window the first beats or two
     and a spawn that never started one after that. Beating again cannot
     clear it. Relay `stalledDispatchReason` — it carries the recovery — and
     let the operator decide; never edit the ledger for them.
     `done: true` means every Story is landed — step 4.
   - **2 / 3 / 4** — `cycleError` / `wedged` / `blocked`: stop the loop and
     route per reference. **4** is the protocol's HITL pause
     ([`instructions.md` § 1.J](../instructions.md)) — surface it and wait for
     the operator; never poll.

4. **Land what the workers hand back** (§ Closing what the workers hand back —
   the beat renders each command), then, with every Story landed, run the
   **per-run epilogue (N>1)**:
   `node .agents/scripts/plan-run-epilogue.js --stories 101,102`; N=1 has none
   ([reference](helpers/deliver-reference.md)). Every close rolls its container
   Epic up from its children.

5. **Correct what the change invalidated.** If a memory you recalled this
   session is now wrong — a trap this landed, a budget it moved — fix that entry
   now, while both the old belief and the new fact are in context, and say so
   when you report. No memory substrate → skip silently. Sweeping the whole pool
   is [`/memory-consolidate`](memory-consolidate.md), not this step.

## Closing what the workers hand back {#tail}

**The tail is the orchestrator's, not the worker's.** A dispatched
`story-worker` stops at a pushed branch and returns a hand-off; **you** run
[`helpers/deliver-story.md`](helpers/deliver-story.md) Step 3
(`single-story-close.js`) for it, foreground, and relay its envelope. Pass the
id as `--handoff` on the next beat and run the `close[]` command it prints
verbatim — the beat knows the run topology, so it decides
`--merge-watch-mode async` for you.

**Serialize the tail.** Implementation runs in parallel; closing does not.
Close one Story at a time — closes contend on the base branch, the merge queue
and the checkout. A worker handing back mid-close waits its turn.

**A worker returning no terminal envelope is expected**, not a failure to answer
with a re-dispatch: only close mints one. Close the pushed branch, or probe
read-only with `node .agents/scripts/deliver-recover.js --story <storyId>` and
resume what it names.

**Reading the outcome.** Each close ends the Story in one schema-validated
envelope — `landed` | `pending` | `blocked` | `failed`; statuses, exits and
fields are digest § 5. `pending` is **not** a failure — run its `nextCommand`.

**Branch model (authoritative).** `story-<id>` → PR → `main` (squash +
required checks), per digest § 2; dependent Stories land sequentially. The
acceptance verdict owner follows the ceremony profile alone
(`ceremony-routing.js`); the **derived level** feeds review depth instead
(`review-depth.js`). The rule and its one home are digest § 3; the profile
table is reference § Ceremony.

## Constraints

- **Land or block — never a silent local build** (digest § 2). Attended delivers
  default to close-and-land (`delivery.routing.closeAndLand: true`); rest at
  `agent::closing` only when a human owns the merge.
- **`/mandrel-deliver` never plans.** Planned tickets come from
  [`/mandrel-plan`](mandrel-plan.md), and a refused prompt **escalates**: the
  light path ends, and the escalation's `nextCommand` is what owns the work —
  seeded with `escalation.reasons`, in this session or a fresh one
  ([`helpers/deliver-light.md`](helpers/deliver-light.md) § Continuing into
  `/mandrel-plan`).

## See also

[`/mandrel-plan`](mandrel-plan.md), [`helpers/deliver-story.md`](helpers/deliver-story.md) (the
engine), [`helpers/deliver-light.md`](helpers/deliver-light.md) (the unplanned
prompt path, shared with `/mandrel-plan` Gate #1).
