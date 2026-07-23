---
description:
  Unified delivery entry point. Takes a list of Story ids, resolves their
  dependency graph from live state, and delivers each via the single
  deliver-story engine — story-<id> → PR → main.
---

# /deliver <storyId...>

> **Lean spine.** Happy path + gate list. Sequencing edge cases, dispatch
> mechanics, lite-route inline execution, checklist threading, ceremony, and
> the per-run epilogue live in the on-demand
> [`helpers/deliver-reference.md`](helpers/deliver-reference.md).

## Role

Single delivery path, single input shape: **a list of Story ids**. `/deliver`
owns input resolution and sequencing only — every Story runs through
[`helpers/deliver-story.md`](helpers/deliver-story.md). No Epic wave loop, no
`epic/<id>` integration branch, no `--no-ff` wave merges.

The dependency graph is **discovered, not declared**: `resolve-stories.js`
reads it from live state (body edges ∪ native GitHub `blocked_by` edges, every
blocker resolved against its real issue state). You never hand it a graph, and
there is no batch label — which is what lets you deliver Stories **across plan
runs and over time**. The `plan-run::<id>` grouping label is filter metadata
only — never a resolution input (there is no `--run` or `--dep` axis).

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/deliver <storyId>` | Deliver one Story via `helpers/deliver-story.md`. |
| `/deliver <storyId> <storyId> ...` | Resolve the set with `resolve-stories.js`, then sequence by the discovered graph via `stories-wave-tick.js`. Default concurrency is **3**. |

Any named ticket that is not `type::story`, or still carrying an `Epic: #N`
footer, is a **hard error** naming the id and the fix (close or re-plan as a v2
Story). Resolution refuses the whole set rather than silently under-delivering.

## Flags

| Flag | Meaning |
| --- | --- |
| `--concurrency <n>` | **Optional** per-run override of the fan-out cap. Omit it to honor `delivery.deliverRunner.concurrencyCap` (config default **3**, including any `.agentrc.local.json` override); pass it **only** for a one-run cap. `1` = sequential. |
| `--yes` | Suppress the multi-Story confirmation gate. |
| `--steal` | Forwarded to `single-story-init.js` / lease steal. |
| `--wait-merge` | Force close-and-land (the default; `delivery.routing.closeAndLand`). |
| `--no-wait-merge` | Opt out; stop at `agent::closing` for a human land. |

**Operator-merge implies no-wait.** `--no-auto-merge` and
`delivery.ci.autoMerge: "strict"` leave the PR un-armed: the Story rests at
`agent::closing` for the human merge and is **not** flipped to `agent::blocked`
(`--wait-merge` does not override this). A genuine *arm failure* differs — it
still waits and still blocks, because that is a fault to report, not an operator
decision to respect.

## Procedure

1. **Resolve the set.** One command, for one Story or many:
   `node .agents/scripts/resolve-stories.js --ids <id,id,...>`. It validates
   the set and shows what will run: read `stories[]`, `dag[]`, and `done[]` to
   present the order in step 2. You do **not** thread them into step 3 — the
   tick re-resolves the graph itself every beat. Resolution hard-errors
   (exit 1) on a named id that is not a Story, carries an `Epic: #N` footer, or
   whose native edges cannot be read — a missing gate would co-dispatch a Story
   against an unlanded blocker.

2. **Confirm (N>1).** Present the order; wait unless `--yes`.

3. **Sequence.** Loop until the tick reports `epilogueDue: true`:

   ```bash
   node .agents/scripts/stories-wave-tick.js \
     --stories <id,id,...> --probe-live \
     --dispatched <every id you have dispatched so far>
   ```

   **Do not add `--concurrency` unless the operator explicitly asked for a
   per-run cap.** Omitting it lets the tick resolve the cap from
   `delivery.deliverRunner.concurrencyCap` — including a `.agentrc.local.json`
   override. An explicit `--concurrency <n>` wins over config for that run, so a
   filled-in literal (e.g. `3`) silently defeats the operator's override.

   Each beat re-probes live state to derive done / in-flight itself; you never
   compute them (Story #4594). `--dispatched` is the one thing you must supply —
   the append-only list of every id you spawned this run — and cross-run
   de-confliction via the assignee lease is automatic
   ([`helpers/deliver-reference.md` § Sequencing edge cases](helpers/deliver-reference.md);
   [§ Dispatch mechanics](helpers/deliver-reference.md) covers role-scoped
   spawn, lite-route execution, and `checklistPath`).

   Branch on the exit code:
   - **0** — dispatch each `ready` id (already capped and overlap-free). Empty
     `ready` with work in flight means "waiting"; keep looping.
     `epilogueDue: true` means every Story is done — go to step 4.
   - **2** — `cycleError`: the graph is self-referential. Fix the `depends_on`
     declarations; do not retry.
   - **3** — `wedged`: nothing dispatchable, nothing in flight, undone Stories
     waiting on blockers that are not done. The envelope names the stuck ids and
     unmet blockers. Land the blocker or include it in `--ids`; do not retry
     unchanged.
   - **4** — `blocked`: a Story carries `agent::blocked`, named in `blocked[]`
     with `blockedReason` — the protocol's HITL pause
     ([`instructions.md` § 1.J](../instructions.md)). **Stop the loop and
     surface it; do not poll.** Read the friction comment
     (`gh issue view <id> --comments`) and resume only once the operator
     unblocks it (`update-ticket-state.js --ticket <id> --state agent::ready`).
     A blocked Story outranks a wedge but not a cycle (fix the graph first).

4. **Per-run epilogue (N>1).** Once step 3 reports `epilogueDue: true`, run
   `node .agents/scripts/plan-run-epilogue.js --stories 101,102` — audit
   roster, follow-up roll-up, sibling coherence. A single-Story run skips it.
   Detail:
   [`helpers/deliver-reference.md` § Per-run epilogue](helpers/deliver-reference.md).

## Branch model (authoritative)

```text
story-<id>  →  PR  →  main (squash + required checks)
```

No `epic/<id>` integration branch and no `--no-ff` wave merge. Dependent
Stories land sequentially so each builds on the previous merge to `main`.
Ceremony depth (profiles + derived level via `ceremony-routing.js`,
review depth reading the same level) and the mechanism table:
[`helpers/deliver-reference.md` § Ceremony](helpers/deliver-reference.md).

## Reading a Story's outcome

Each Story's delivery ends in exactly one schema-validated terminal envelope
([`story-deliver-terminal.schema.json`](../schemas/story-deliver-terminal.schema.json),
Story #4543) — `landed` | `pending` | `blocked` | `failed`, the SSOT for the
shape; this workflow does not restate its fields.

`pending` is **not** a failure: the bounded merge wait expired with the PR
healthy (or a human owns the merge), nothing was mutated, and the
`nextCommand` resumes it — run that rather than re-dispatching. The slow-CI
`async` mode (Story #4698) returns `pending` by design — launch its
`nextCommand` as a background invocation (reference appendix).

For a Story in an unclear state — including the merged-but-label-stale one a
`/deliver` re-run refuses outright — probe it read-only with
`node .agents/scripts/deliver-recover.js --story <storyId>`.

## Constraints

- **Land or block — never a silent local build.** Worktrees, `story-<id>`
  branches, close-validation, and PR-to-`main` are the only sanctioned delivery
  mechanism. Attended delivers default to close-and-land
  (`delivery.routing.closeAndLand: true`); use `--no-wait-merge` only when a
  human lands the PR.
- `/deliver` never plans — tickets come from [`/plan`](plan.md). The router
  performs no git/label mutations; `deliver-story` owns every script.

## See also

- [`/plan`](plan.md) — unified planning entry point.
- [`helpers/deliver-story.md`](helpers/deliver-story.md) — the one Story
  delivery engine.
- [`helpers/deliver-reference.md`](helpers/deliver-reference.md) — sequencing,
  dispatch, ceremony, and epilogue detail.
