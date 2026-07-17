---
description:
  Unified delivery entry point. Takes a list of Story ids, resolves their
  dependency graph from live state, and delivers each via the single
  deliver-story engine — story-<id> → PR → main.
---

# /deliver <storyId...>

## Role

Single delivery path with a single input shape: **a list of Story ids**.
`/deliver` owns input resolution and sequencing only — every Story runs
through [`helpers/deliver-story.md`](helpers/deliver-story.md). There is no
Epic wave loop, no `epic/<id>` integration branch, and no `--no-ff` wave
merges.

The dependency graph is **discovered, not declared**: `resolve-stories.js`
reads it from live state (body edges ∪ native GitHub `blocked_by` edges,
with every blocker resolved against its real issue state). You never hand it
a graph, and there is no batch label — which is what lets you deliver
Stories **across plan runs and over time**: a Story whose blocker landed
weeks ago in a different run is simply ready.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/deliver <storyId>` | Deliver one Story via `helpers/deliver-story.md`. |
| `/deliver <storyId> <storyId> ...` | Resolve the set with `resolve-stories.js`, then sequence by the discovered graph via `stories-wave-tick.js`. Default concurrency is **3**. |

Any named ticket that is not `type::story`, or that still carries an
`Epic: #N` footer, is a hard error naming the id and the fix (close or
re-plan as a v2 Story). Resolution refuses the whole set rather than
silently dropping the offending id and under-delivering.

> **Retired (Story #4540).** `--run <planRunId>` and the `plan-run::<id>`
> label are gone, along with `--dep`. Batch identity was the wrong axis:
> it could not express an edge to a Story planned in another run, while
> ordering already lives in the dependency edges themselves. Deliver the
> ids; the graph resolves itself.

## Flags

| Flag | Meaning |
| --- | --- |
| `--concurrency <n>` | **Optional** per-run override of the ready-set fan-out cap. Omit it to honor `delivery.deliverRunner.concurrencyCap` (config default **3**, including any `.agentrc.local.json` override); pass it **only** when the operator explicitly wants a one-run cap. Set `1` for sequential. |
| `--yes` | Suppress the multi-Story confirmation gate. |
| `--steal` | Forwarded to `single-story-init.js` / lease steal. |
| `--wait-merge` | Force close-and-land (the default; `delivery.routing.closeAndLand`, default `true`). |
| `--no-wait-merge` | Opt out of close-and-land; stop at `agent::closing` for a human land. |

**Operator-merge implies no-wait.** `--no-auto-merge` and
`delivery.ci.autoMerge: "strict"` deliberately leave the PR un-armed, so
there is nothing for close to land: the Story rests at `agent::closing` for
the human merge, and is **not** flipped to `agent::blocked`. An explicit
`--wait-merge` does not override this — close cannot land a PR that was
never armed. A genuine *arm failure* is different: it still waits and still
blocks, because that is a fault to report rather than an operator decision
to respect.

## Procedure

1. **Resolve the set.** One command, for one Story or many:

   ```bash
   node .agents/scripts/resolve-stories.js --ids <id,id,...>
   ```

   This validates the set and shows the operator what will run: read
   `stories[]`, `dag[]`, and `done[]` to present the order in step 2. You do
   **not** thread them into step 3 — the tick re-resolves the graph itself
   from the same machinery, every beat. Do **not** rebuild the graph by hand;
   it is discovered from live state, including edges a body does not spell
   out and blockers outside the delivered set.

   Resolution hard-errors (exit 1) on a named id that is not a Story, still
   carries an `Epic: #N` footer, or whose native dependency edges cannot be
   read. A failed edge read is fatal by design: a missing gate would
   co-dispatch a Story against an unlanded blocker.

2. **Confirm (N>1).** Present the order and wait unless `--yes`.

3. **Sequence.** Loop until the tick reports `epilogueDue: true`:

   ```bash
   node .agents/scripts/stories-wave-tick.js \
     --stories <id,id,...> --probe-live \
     --dispatched <every id you have dispatched so far>
   ```

   **Do not add `--concurrency` unless the operator explicitly asked for a
   per-run cap.** Omitting it is what lets the tick resolve the cap from
   `delivery.deliverRunner.concurrencyCap` — including a `.agentrc.local.json`
   override. An explicit `--concurrency <n>` wins over config for that run
   (`resolveConcurrencyCap` returns the flag before it ever reads config), so
   filling in a literal — e.g. the documented default `3` — silently defeats
   the operator's configured override. Thread `--concurrency` through here
   only when it was passed to `/deliver`.

   Each beat re-probes live state: it re-resolves the graph, classifies done
   (`agent::done` or a closed issue — including foreign blockers that landed
   in another run), and derives in-flight from live `agent::executing` /
   `agent::closing` labels. You never compute `done` or `in-flight` — that
   accounting is read from reality every beat (Story #4594).

   **`--dispatched` is the one thing you must tell it (Story #4601).** List
   every Story id you have spawned this run. Live state cannot instantly report
   a Story you dispatched moments ago: `single-story-init.js` publishes
   `agent::executing` before the worktree install (Story #4620 moved it ahead
   of the multi-minute install, so the window is now short rather than
   minutes-long), but it is not zero — until the label lands the Story still
   reads `agent::ready` and, without `--dispatched`, the next beat would hand
   it back and a second sub-agent would join the first on the same branch and
   worktree, interleaving commits. `--dispatched` closes that residual
   same-run window.

   **Cross-run de-confliction is automatic (Story #4620).** A Story another
   operator is delivering is withheld without any bookkeeping from you: the
   probe reads the Story's assignee lease and, when it belongs to a different
   operator, withholds the Story and reports it in the envelope's
   `foreignHeld: [{ id, holder }]` (with `foreignHeldReason`). That is not a
   failure or a wedge — the holder's run owns the branch, and this run picks
   the Story up automatically once their lease clears. Init is the backstop:
   it refuses a Story already labelled `agent::executing`, or one whose lease a
   different operator holds, unless you pass `--steal`. Assignee-based
   withholding needs `github.operatorHandle` set (in `.agentrc.local.json`);
   without it the probe logs a warning and leans on init's lease refusal alone.

   The rule is **append-only: add each id as you dispatch it and never remove
   one.** The flag is additive, not authoritative — the probe unions it into
   the label-derived set and then filters it against live state, so an id that
   has since gone `agent::done` is dropped for you. Re-listing an id costs
   nothing and cannot double-count a slot; *omitting* one is the only way to
   get this wrong. This is why `--dispatched` is not the `--done` bookkeeping
   #4594 retired, and why `--in-flight` remains rejected under `--probe-live`.

   Branch on the exit code:
   - **0** — dispatch each `ready` id (the set is already capped and
     overlap-free). An empty `ready` with work in flight means "waiting";
     keep looping. `epilogueDue: true` means every Story is done — leave the
     loop and go to step 4.
   - **2** — `cycleError`: the graph is self-referential. Fix the
     `depends_on` declarations; do not retry.
   - **3** — `wedged`: nothing is dispatchable, nothing is in flight, and
     undone Stories are waiting on blockers that are not done. The envelope
     names the stuck ids and their unmet blockers. Either land the blocker
     first or include it in `--ids`. Do not retry unchanged — the state
     cannot improve on its own.
   - **4** — `blocked`: one or more Stories carry `agent::blocked`, named in
     `blocked[]` with `blockedReason`. This is the protocol's HITL pause
     ([`instructions.md` § 1.J](../instructions.md)) — **stop the loop and
     surface it to the operator; do not poll.** No beat can clear it, because
     a human owes a decision. Read the Story's friction comment, and resume
     only once the operator has unblocked it:

     ```bash
     gh issue view <id> --comments
     node .agents/scripts/update-ticket-state.js --ticket <id> --state agent::ready
     ```

     A blocked Story outranks a wedge (its blockers are moot while a human
     owes a decision) but not a cycle (exit 2 — fix the graph first).

   For each `ready` Story id, read
   [`helpers/deliver-story.md`](helpers/deliver-story.md) **in full** and
   execute it (init → implement → ceremony → close-and-land). Under
   `--yes` / injected helper content, execute directly without a re-read
   turn.

4. **Per-run epilogue (N>1).** Once step 3 reports `epilogueDue: true`
   (every Story done), keyed on the delivered id set:

   ```bash
   node .agents/scripts/plan-run-epilogue.js --stories 101,102
   ```

   This executes, in order:
   - `audit-roster` — selects cross-Story audit lenses over the combined
     landed tip and posts `plan-run-audit-roster` on the primary Story;
     the host MUST walk each listed lens against the combined diff
   - `follow-up-rollup` — friction follow-ups across every Story in the
     run (files issues when auto-file is on; posts `follow-ups`)
   - `sibling-coherence` — Spec/Acceptance coherence check across sibling
     bodies (`plan-run-sibling-coherence`)

   A single-Story run skips the epilogue — follow-ups are captured on
   merge confirm instead (`captureStoryFollowUps`).

## Branch model (authoritative)

Every Story:

```text
story-<id>  →  PR  →  main (squash + required checks)
```

There is no `epic/<id>` integration branch and no `--no-ff` wave merge.
Dependent Stories land sequentially so each builds on the previous merge
to `main`.

## Ceremony (profiles + two scopes)

Ceremony depth is selected by `delivery.routing.ceremonyProfile`
(`minimal` | `standard` | `strict`, default `standard`) and the **change
level derived from the Story's own diff** — the changed files' intersection
with the sensitive-path classes in `audit-rules.json`
(`review-depth.js#deriveChangeLevel`), not a planner-authored verdict
(Story #4542):

| Profile | Acceptance critic | When to use |
| --- | --- | --- |
| `minimal` | Always inline | Tiny trusted N=1 Stories |
| `standard` | Derived-level routed (+ sampling floor) | Default |
| `strict` | Always fresh-context | High-assurance / regulated surfaces |

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, close-and-land | `deliver-story` / `single-story-close` |
| **Per-Story (profile + derived level)** | Acceptance critic mode; review depth | `ceremony-routing.js` + `review-depth.js` + `code-review.js` |
| **Per-run (N>1)** | Audit roster · follow-up roll-up · sibling coherence | `plan-run-epilogue.js` once at run end |
| **Per-Story land tail** | Follow-up capture · status resync · ref cleanup · base fast-forward | `single-story-close/phases/post-land.js` (in-process, per-step reported) |

## Reading a Story's outcome

Each Story's delivery ends in exactly one schema-validated terminal envelope
([`story-deliver-terminal.schema.json`](../schemas/story-deliver-terminal.schema.json),
Story #4543) — `landed` | `pending` | `blocked` | `failed`. That schema is the
SSOT for the shape; this workflow does not restate its fields.

`pending` is **not** a failure: the bounded merge wait expired with the PR
healthy and in flight (or a human owns the merge), nothing was mutated, and
the envelope's `nextCommand` names what resumes it. Run that command rather
than re-dispatching the Story.

For a Story in an unclear state — including the merged-but-label-stale one a
`/deliver` re-run refuses outright — probe it read-only:

```bash
node .agents/scripts/deliver-recover.js --story <storyId>
```

## Constraints

- **Land or block — never a silent local build.** Worktrees, `story-<id>`
  branches, close-validation, and PR-to-`main` are the only sanctioned
  delivery mechanism. Attended delivers default to close-and-land
  (`delivery.routing.closeAndLand: true`); use `--no-wait-merge` only when
  a human will land the PR.
- `/deliver` never plans — tickets come from [`/plan`](plan.md).
- The router performs no git/label mutations; `deliver-story` owns every
  script invocation per Story.

## See also

- [`/plan`](plan.md) — unified planning entry point.
- [`helpers/deliver-story.md`](helpers/deliver-story.md) — the one Story
  delivery engine.
- Placeholder design Story for a fully deterministic deliver-run
  orchestrator: [#4521](https://github.com/dsj1984/mandrel/issues/4521).
