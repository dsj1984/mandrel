---
description: >-
  Single-delivery Epic path (invoked by /deliver when the route resolves to
  `single`). Collapses a spec-only Epic — one that authored NO Story tickets —
  into ONE guarded in-session slice walk on `epic/<id>`: prepare `--single`,
  walk the Epic body's `## Delivery Slicing` table in order (implement + commit
  each slice, flip its checkpoint marker), run per-AC-cluster acceptance
  critics, then hand off to `deliver-epic.md` Phase 3 for the merge tail
  (Phases 3–9 reused byte-for-byte). Not a second engine — deliver-epic with
  Phases 1–2 replaced by the slice walk.
---

# helpers/deliver-epic-single — single-delivery Epic path (invoked by /deliver)

> **Runtime core.** The single-delivery executor for Epic #4475. The
> [`/deliver`](../deliver.md) router dispatches here when
> [`resolveEpicDeliveryRoute`](../../scripts/lib/orchestration/deliver-route.js)
> returns `single` (the Epic carries `delivery::single` or its
> `epic-plan-state` checkpoint has `decompose.shape === "single"`), unless the
> `delivery.routing.singleDelivery=false` kill-switch forces fan-out.

## Overview

A spec-only plan (authored by `/plan`'s single-delivery variant) creates **no
Story tickets** — the Epic body's `## Delivery Slicing` table is the whole
work breakdown and the audit trail. There is nothing to fan out, so this path
does not run the [`deliver-epic.md`](deliver-epic.md) Phase 1–2 wave loop.
Instead it walks the slicing table **in order** inside one guarded session on
`epic/<id>`.

The **least-surface insight** (adopted design): in `deliver-epic.md` only
**Phases 1–2 are Story-tier-specific**. **Phases 3–9 are Epic-scope** — they
operate on `epic/<id>` + the Epic body's `## Acceptance Table` and dereference
**no** Story ticket (close-validation, epic-audit lens roster, code-review over
the cumulative `main..epic/<id>` diff, retro, integration gate, finalize →
reconcile → the merge machine). So:

```text
single-delivery = deliver-epic  with Phases 1–2 replaced by an in-session
                  slice walk (S1/S2/S2a below), and Phases 3–9 reused
                  byte-for-byte (S2b handoff).
```

```text
/deliver <epicId>   (route: single)
  → S1  Prepare        (epic-deliver-prepare.js --single — slice map, ONE worktree)
  → S2  Slice walk     (walk ## Delivery Slicing in order; commit + flip each slice on epic/<id>)
  → S2a Acceptance     (per-AC-cluster fresh-context critics over the cumulative diff)
  → S2b Handoff        → deliver-epic.md Phase 3 … Phase 9 (merge tail, unchanged)
```

---

## Contract

- **One long guarded session.** No Story fan-out, no `Agent` dispatch for
  implementation — you (the LLM running this helper) implement each slice
  in-session on `epic/<id>`. The per-AC-cluster acceptance critics (S2a) are
  the **only** `Agent` spawns, and they are read-only maker-blind critics.
- **Idempotent by checkpoint.** The `epic-run-state` slice map
  (`slices[id].status ∈ {pending, done, blocked, failed}`) is the resume
  target: a re-run **skips `done` slices** — the work already sits on
  `epic/<id>`, so it is never re-paid.
- **Single pause point.** Only `agent::blocked` halts. If a slice or an
  acceptance cluster cannot be satisfied, flip the Epic to `agent::blocked`,
  post a friction comment, and park — never fall silent, never proceed to
  close with an unmet AC.
- **No Story-ticket dereference (audit receipt).** Nothing in this path reads,
  enumerates, or transitions a `type::story` ticket. The leaf unit is a
  `## Delivery Slicing` slice; the acceptance unit is an `## Acceptance Table`
  AC cluster; the merge tail is Epic-scope. This is the load-bearing property
  that lets Phases 3–9 be reused unchanged.
- **Land or block (issue #4483).** The worktree / `epic/<id>` branch / PR path
  is the ONLY sanctioned delivery mechanism. Executing slices inline in the
  main checkout or committing to local `main` is forbidden regardless of how
  the environment looks. Prepare surfaces `remoteVerified`; on `false` flip to
  `agent::blocked` quoting `remoteProbe.detail` and halt.

---

## S1 — Prepare the single run

```bash
node .agents/scripts/epic-deliver-prepare.js --epic <epicId> --single [--steal] [--as <handle>]
```

`--single` short-circuits Story enumeration
([`runEpicDeliverPrepareSingle`](../../scripts/epic-deliver-prepare.js)). It:

1. **Refuses `acceptance::n-a`** (fail-closed front gate). Under single
   delivery the non-waivable epic-level acceptance reconcile is the ONLY
   acceptance gate, so an Epic declaring "no acceptance criteria" is
   structurally incoherent — prepare throws. (The back gate is S2b's
   reconcile; see [Non-waivable reconcile](#non-waivable-acceptance-reconcile).)
2. Runs the same fail-closed preflight guards as the fan-out prepare
   (checkout-safety + Epic lease).
3. Seeds `epic/<id>` and materializes **ONE** worktree at
   `.worktrees/epic-<epicId>/` on it.
4. Parses the Epic body's `## Delivery Slicing` table and writes the
   `epic-run-state` **slice map** (`deliveryShape: "single"`, `storyCount: 0`,
   `concurrencyCap: 1`) — idempotent + resume-preserving (a re-run keeps every
   already-`done` slice).
5. Writes the per-Epic docs digest.

Treat the printed JSON as `state`:
`{ epicId, deliveryShape, storyCount: 0, sliceCount, slices, epicBranch, workCwd, worktreeCreated, checkpointInitializedAt, docsDigestPath }`.
Flip the Epic to `agent::executing` (idempotent) after the CLI returns.

> **`sliceCount === 0`.** A missing / unparseable `## Delivery Slicing` table
> yields an empty slice map — there is nothing to walk. That is a plan-quality
> defect: post a friction comment, flip to `agent::blocked`, and halt (do NOT
> proceed to an empty close).

### S2 — `cd` into the worktree (absolute-path discipline)

```bash
cd "<workCwd from S1>"
```

All subsequent commands run from this directory.

> **Worktree scope is not just the Bash cwd.** `cd <workCwd>` steers the Bash
> tool's cwd but does **not** scope the path-based Edit/Write/Read tools — you
> MUST prefix every such path with the absolute `workCwd` root or risk
> silently editing the main checkout (same discipline as
> [`single-story-deliver.md`](single-story-deliver.md) Step 0.5).

---

## S2 — Walk the Delivery Slicing table in order

Read the Epic body's `## Delivery Slicing` table. Walk it **strictly in
order** as an in-session checklist. The ordered slicing **is** the audit trail
(the plan authored no tickets), and the ordering encodes the dependency chain
— never reorder or parallelize.

For each slice `slice-<n>` (1-based, matching the checkpoint's slice-map keys),
**skip it when `slices[slice-<n>].status === "done"`** (resume: the work is
already on `epic/<id>`). Otherwise:

1. **Announce the slice.** Emit `slice.start` on the ledger. This same
   boundary call also exports the active-slice env
   (`CC_EPIC_ID` / `CC_SLICE_ID`) into the worktree's `.env.local`, which
   arms the PostToolUse hook to emit `slice.heartbeat` for the rest of this
   slice (below):

   ```bash
   node <main-repo>/.agents/scripts/slice-phase.js \
     --epic <epicId> --slice slice-<n> --event start --slice-index <n-1> --title "<slice label>"
   ```

2. **Implement the slice** on `epic/<id>` in the worktree. Apply the relevant
   [skills](../../instructions.md) and local-lens concerns for the slice's
   footprint. You do **NOT** run a per-step `slice.heartbeat` CLI (Epic
   #4476): once `--event start` armed the active-slice env, the PostToolUse
   hook emits a throttled `slice.heartbeat` off the token stream as a free
   byproduct of every tool call, so the `/deliver` §2e Idle Watchdog can tell
   this one long session from a dead one without a dedicated bookkeeping turn.
   (The `slice-phase.js --event heartbeat` CLI remains available for an
   explicit beat if you deliberately want one, e.g. a long non-tool wait.)

3. **Commit** the slice to `epic/<id>` before the next slice
   (conventional subject, `(refs #<epicId>)`). Run the advisory quick gates
   (`lint`, `typecheck`) while iterating so drift surfaces early.

4. **Flip the marker + close the slice.** After the commit lands, flip the
   checkpoint marker `pending → done` and emit `slice.end`:

   ```bash
   node <main-repo>/.agents/scripts/slice-phase.js \
     --epic <epicId> --slice slice-<n> --event end --outcome done --record done
   ```

   (`--record done` splices `slices[slice-<n>].status = "done"` via
   [`recordSliceStatus`](../../scripts/lib/orchestration/epic-run-state-store.js)
   so a resumed run skips this slice.)

If a slice cannot be completed, emit `slice.end --outcome blocked
--record blocked`, post a friction comment, flip the Epic to `agent::blocked`,
and park.

When every slice is `done`, proceed to S2a.

---

## S2a — Per-AC-cluster acceptance critics (the acceptance-dilution guard)

**This is the load-bearing risk mitigation.** In the fan-out shape each Story
ran its own fresh-context acceptance self-eval critic, so acceptance coverage
was distributed across the Story tree for free. Collapsing to one session would
degrade that to two redraft rounds scoring every AC at once — the "acceptance
dilution" risk the design calls out as blocking. The fix restores the
distributed critic count.

1. **Cluster the ACs.** Parse the Epic body's `## Acceptance Table` AC ids
   (`AC-<n>`), ordered by their associated Delivery-Slicing slice, then split
   into clusters of at most `delivery.acceptanceEval.clusterCeiling` (default
   **4**, hard-clamped to `[1, 8]`) via
   [`clusterAcceptanceCriteria`](../../scripts/lib/orchestration/acceptance-clusters.js).
   The result is **exactly `ceil(totalACs / clusterCeiling)`** clusters — the
   fan-out width.

2. **One maker-blind critic per cluster.** For **each** cluster author **one**
   maker-blind verdict — NOT a continuation of your implementing turn, so the
   critic does not grade its own homework. There MUST be
   **exactly `ceil(totalACs / clusterCeiling)`** critic passes — **one per
   cluster** — never a single critic over all ACs (that is the collapse this
   guard forecloses). Each critic runs the shared
   [`acceptance-self-eval.md`](acceptance-self-eval.md) mechanic scoped to its
   cluster: it scores **that cluster's ACs** against the cumulative
   `git diff main...epic/<epicId>` diff (plus any `verify[]` evidence the ACs
   reference) and writes a verdict file under `temp/` conforming to
   [`acceptance-eval-verdict.schema.json`](../../schemas/acceptance-eval-verdict.schema.json).

   > **Fresh-vs-inline is risk-routed PER CLUSTER — the count is fixed
   > (Epic #4478, M7-B).** Whether a given cluster's critic runs as a
   > fresh-context spawn or inline is resolved per cluster by
   > `resolveCeremonyForRisk`
   > ([`ceremony-routing.js`](../../scripts/lib/orchestration/ceremony-routing.js))
   > from the Epic's `planningRisk.overallLevel` and
   > `delivery.routing.freshCriticSampleRate`: **`high`/`medium` → fresh spawn**,
   > **`low` → inline** (except the sampling-floor fraction forced fresh),
   > **missing/unknown → fresh + full ceremony**. This is **strictly** a
   > fresh-vs-inline choice **per cluster**: the number of clusters — hence the
   > number of critic passes and verdicts — stays **exactly**
   > `ceil(totalACs / clusterCeiling)` under **every** risk level. Risk routing
   > NEVER re-slices, merges, or drops a cluster.
   >
   > - **Fresh** → emit a **separate** `Agent` tool call
   >   (`subagent_type: acceptance-critic` when
   >   `delivery.routing.roleScopedAgents` is on — the default — else
   >   `general-purpose`), maker-blind, scoped to that cluster's ACs.
   > - **Inline** → author that cluster's verdict inline in a deliberately
   >   scoped self-critical pass (re-read only the diff + that cluster's ACs,
   >   treat the implementation reasoning as untrusted). The gate, schema, and
   >   proceed/redraft/block decision are identical.
   > - **Nesting-absent fallback.** If the host cannot spawn a nested `Agent` at
   >   this depth at all, author **every** cluster's verdict inline regardless of
   >   the risk verdict. Note the fallback in any block/friction comment.

3. **Gate each cluster (Epic-scoped).** Run the gate per cluster:

   ```bash
   node <main-repo>/.agents/scripts/acceptance-eval.js \
     --epic <epicId> --cluster <clusterId> --verdict <verdict-path>
   ```

   The Epic-scoped invocation (no `--story`) scopes the redraft-round count
   **per cluster** off the Epic's `signals.ndjson`. It exits:
   - **`proceed`** (every AC in the cluster `met`) → this cluster is clear.
   - **`redraft`** (some `partial`/`unmet`, rounds remain) → redraft the
     flagged ACs on `epic/<id>`, commit, and re-run this cluster's critic.
   - **`block`** (round cap reached, ACs still unmet) → exit non-zero. **STOP
     the whole run.** Flip the Epic to `agent::blocked` and post a friction
     comment naming the unmet ACs (with their cluster) and their evidence.
     **Never proceed to close (S2b) with any cluster blocked.**

4. Only when **every** cluster returns `proceed` do you proceed to S2b.

---

## S2b — Hand off to deliver-epic.md Phase 3 (merge tail, reused unchanged)

Everything downstream of the acceptance gate is Epic-scope and reused
**byte-for-byte** — there is exactly one home for the merge machinery. Continue
at [`deliver-epic.md`](deliver-epic.md) **Phase 3** and run **Phases 3–9
verbatim**:

- Phase 3 — close-validation (lint + test + ratchets on `epic/<id>`)
- Phase 4 — epic-close lens roster
- Phase 5 — code-review (the ONE maker-blind cumulative-diff review — the
  north-star's "review is a fresh-context critic")
- Phase 6 — retro
- Phase 6.5 — integration gate
- Phase 7 — finalize (branch-sync → `epic.close.end` → reconcile → open PR)
- Phase 8 — watch-and-iterate to green CI
- Phase 8.5 — auto-merge gate
- Phase 9 — cleanup

Do **not** copy those phases here. Read `deliver-epic.md` from Phase 3 and run
them exactly as the fan-out route does — they never touch a Story ticket, so
they compose unchanged over the slice-walked `epic/<id>` branch.

### Non-waivable acceptance reconcile

Phase 7's `epic.close.end` fires the bus-owned `AcceptanceReconciler`. Under
single delivery this listener is **non-waivable** (design §2c, the back gate):
[`acceptance-reconciler.js`](../../scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js)
resolves the delivery shape (off `epic-run-state.deliveryShape` or the
`delivery::single` label) and treats a `status: "waived"` reconcile as
**`failed`** (`acceptance.reconcile.failed` → `epic.blocked`) instead of
passing it through. Combined with the S1 front gate (prepare refusing
`acceptance::n-a`), this structurally forecloses shipping a single Epic with
its sole acceptance gate waived.

---

## Idempotence and resume

Re-runs resume from the slice map: `done` slices are skipped, `pending` slices
resume in order. The per-cluster acceptance signals on the Epic stream let a
resumed run pick up the correct redraft round per cluster. The PR from Phase 7
is updated in place. `slice.start` / `slice.end` / `slice.heartbeat` on the
ledger give the resume path and the idle watchdog an inspectable forward-
progress signal for the single long session.

---

## Constraints

- **Never** fan out `Agent` calls for slice implementation — the slice walk is
  in-session. The only `Agent` spawns are the S2a maker-blind acceptance
  critics (read-only), and only for clusters the risk router sends `fresh`.
- **Never** dereference, enumerate, or transition a `type::story` ticket —
  this path has none.
- **Never** collapse the S2a critics to fewer than
  `ceil(totalACs / clusterCeiling)` **critic passes** — one maker-blind verdict
  per cluster (fresh spawn or inline; the risk router chooses the mode, never
  the count) — and **never** proceed to S2b with a blocked cluster.
- **Never** merge `epic/<epicId>` to `main` outside Phase 8.5 — the merge tail
  is `deliver-epic.md`'s, unchanged.
- **Always** flip the slice marker `→ done` after each slice commits, and
  **always** post a friction comment before any non-`complete` outcome.

## See also

- [`deliver.md`](../deliver.md) — the router that dispatches here.
- [`deliver-epic.md`](deliver-epic.md) — the fan-out path; its Phases 3–9 are
  this helper's merge tail.
- [`acceptance-self-eval.md`](acceptance-self-eval.md) — the per-cluster critic
  mechanic.
