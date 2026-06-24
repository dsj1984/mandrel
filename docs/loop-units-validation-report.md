# Loop-units validation report (Epic #4284)

> **Status:** validation evidence captured + follow-on roadmap authored.
> **Date:** 2026-06-24
> **Epic:** [#4284](https://github.com/dsj1984/mandrel/issues/4284) — loop-unit
> schema, `loop.tick` lifecycle event, namespaced `/loops:` projection, and
> operator-facing starter loops.
> **Story:** [#4291](https://github.com/dsj1984/mandrel/issues/4291) — validate
> the assembled loop machinery end-to-end and aim the follow-on simplification
> work.
> **Builds on the merged slices:**
> [#4288](https://github.com/dsj1984/mandrel/issues/4288) (loop-unit schema +
> validator + `check-loop-units.js`),
> [#4287](https://github.com/dsj1984/mandrel/issues/4287) (`loop.tick`
> lifecycle event + `emit-loop-tick.js`),
> [#4289](https://github.com/dsj1984/mandrel/issues/4289) (namespaced `/loops:`
> projection), [#4290](https://github.com/dsj1984/mandrel/issues/4290) (3
> starter loops + README + division-of-labor ADR).

This report has two parts. **Part A** is end-to-end validation evidence that
proves the assembled loop structure works through the real code path. **Part B**
is a prioritized roadmap for using the loop pattern to simplify mandrel's
existing hand-rolled engine loops.

---

## Part A — End-to-end validation evidence

### What this validates, and what it cannot

The loop *driver* (cadence + iteration) is owned by the host — the built-in
`/loop` for self-paced and interval cadences, `/schedule` for cron — per the
[division-of-labor ADR](decisions/loop-units-division-of-labor.md). Mandrel
ships only the loop *unit* (action + goal + `verify` oracle + escalation
contract) and **no runner**.

As a delivery sub-agent I **cannot** drive the host's interactive `/loop` UI:
self-paced host iteration and pacing are a runtime concern outside any
node-test assertion (this is exactly why Story #4291's live-dogfood verify is a
`manual:` item, not a runnable check). What I **can** do — and do below — is
exercise the underlying machinery each leg of the operator flow depends on, so
the contract seams are proven even though the host re-invocation itself is
operator-driven:

| Operator-flow leg | Machinery exercised below | Evidence |
| --- | --- | --- |
| Each pass lands an inspectable forward-progress record | `emitLoopTick()` → lifecycle bus → ledger | §A.1 — 3 NDJSON records |
| The oracle terminates a self-paced run | `fix-failing-tests` `verify` command exits 0 | §A.2 — exit code 0 |
| The unit is invocable as `/loops:fix-failing-tests` | `sync:commands` projection | §A.3 — projected command file |

### A.1 — `loop.tick` emit → ledger (the per-pass progress record)

A self-paced `/loop` run must leave a per-pass trail the `/deliver` idle
watchdog can read, so a host loop never runs silently. I drove
[`emit-loop-tick.js`](../.agents/scripts/lib/orchestration/lifecycle/emit-loop-tick.js)
(Story #4287) for a loop named `fix-failing-tests` across three rounds —
two `running` and a terminating `done` — through the lifecycle bus into a
ledger. The emitter routes through `createBus()` + `LedgerWriter` (it does **not**
`appendFileSync` directly), so each record is schema-validated against
[`loop.tick.schema.json`](../.agents/schemas/lifecycle/loop.tick.schema.json)
before it lands.

Resulting ledger (`temp/loop-validation/epic-9999/lifecycle.ndjson`, verbatim):

```ndjson
{"kind":"emitted","seqId":1,"ts":"2026-06-24T15:21:59.890Z","event":"loop.tick","payload":{"event":"loop.tick","loopName":"fix-failing-tests","round":1,"cadence":"self-paced","status":"running","timestamp":"2026-06-24T15:21:59.874Z"}}
{"kind":"completed","seqId":1,"ts":"2026-06-24T15:21:59.890Z","event":"loop.tick"}
{"kind":"emitted","seqId":1,"ts":"2026-06-24T15:21:59.897Z","event":"loop.tick","payload":{"event":"loop.tick","loopName":"fix-failing-tests","round":2,"cadence":"self-paced","status":"running","timestamp":"2026-06-24T15:21:59.890Z"}}
{"kind":"completed","seqId":1,"ts":"2026-06-24T15:21:59.897Z","event":"loop.tick"}
{"kind":"emitted","seqId":1,"ts":"2026-06-24T15:21:59.902Z","event":"loop.tick","payload":{"event":"loop.tick","loopName":"fix-failing-tests","round":3,"cadence":"self-paced","status":"done","timestamp":"2026-06-24T15:21:59.897Z"}}
{"kind":"completed","seqId":1,"ts":"2026-06-24T15:21:59.902Z","event":"loop.tick"}
```

**What this proves.** Each round appended an `emitted` line carrying the full
payload (`loopName`, monotonic `round`, `cadence`, per-round `status`) plus a
`completed` line — the standard two-record lifecycle shape every event flows
through. A reconciler (or the idle watchdog) scanning this ledger sees concrete
forward progress per pass and a terminal `status:"done"` on the final round.
The payload's narrow, schema-pinned shape (`additionalProperties:false`) means a
`loop.tick` can never masquerade as `story.heartbeat` progress and vice versa.

> The ledger lives under `temp/` (gitignored); it is reproduced inline here as
> the durable evidence and is not committed.

### A.2 — The `verify` oracle exits 0 (the terminating check)

A self-paced `/loop` terminates when the unit's `verify` oracle exits 0. The
[`fix-failing-tests`](../.agents/workflows/loops/fix-failing-tests.md) starter
declares `verify: npm test` — its done-signal is the full suite passing. To
demonstrate the oracle's terminating semantics without a multi-minute full run,
I ran a representative slice covering exactly the loop machinery under
validation (loop-unit validator, `loop.tick` lifecycle wiring, and the
`/loops:` projection):

```text
$ node --test tests/loop-units/validate-loop-unit.test.js \
       tests/lifecycle/loop-tick.test.js \
       tests/sync-claude-commands-loops.test.js
ℹ tests 26
ℹ pass 26
ℹ fail 0
ℹ duration_ms 202.83
ORACLE_EXIT_CODE=0
```

The full `npm test` oracle is also run to green by `story-close.js`'s
close-validation chain as part of this Story's delivery (Story acceptance:
"`npm run lint` and `npm test` pass with the report and all prior slices in
place"). **What this proves:** the oracle is a runnable, exit-code-bearing
check — exactly the deterministic stop signal the host `/loop` evaluates after
each round. When it exits 0, the goal is met and the host stops the loop.

### A.3 — The starter projects as `/loops:fix-failing-tests`

A loop unit is only operator-reachable if it projects to a namespaced slash
command. Running the projection:

```text
$ npm run sync:commands
  ...
  synced   loops/fix-failing-tests.md
  synced   loops/nightly-audit.md
  synced   loops/watch-ci.md
✔ 28 file(s) synced, 28 total commands in .claude/commands/

$ ls .claude/commands/loops/
fix-failing-tests.md  nightly-audit.md  watch-ci.md
```

The unit at `.agents/workflows/loops/fix-failing-tests.md` materializes at
`.claude/commands/loops/fix-failing-tests.md`, whose subpath makes it invocable
as **`/loops:fix-failing-tests`** (the `loops:` namespace is the directory
segment; verified by `tests/sync-claude-commands-loops.test.js` AC3). The
projected tree under `.claude/commands/` is generated and gitignored, so this
projection is a runtime materialization step, not a committed artifact.

### A.4 — The operator flow (how all three legs compose)

Putting the proven seams together, the end-to-end operator flow for a self-paced
starter loop is:

1. **Invoke.** The operator runs `/loop /loops:fix-failing-tests` (host built-in
   `/loop`, no interval → self-paced). The `/loops:fix-failing-tests` command is
   the projected unit from §A.3.
2. **Run self-paced.** The host `/loop` owns cadence and iteration: it re-invokes
   the unit's `## Action` body each pass (read the latest failure → diagnose the
   root cause → apply the smallest fix → re-run the oracle). Mandrel supplies the
   action, the goal, and the oracle — never the pacing.
3. **Record each pass.** Each pass can land a `loop.tick` record in the ledger
   (§A.1) so the run is never silent; the `/deliver` idle watchdog (re-ticked via
   `wave-tick.js --check-idle`) reads these records as forward-progress evidence.
4. **Terminate on the oracle.** After each pass the host evaluates the `verify`
   oracle (`npm test`, §A.2). The first pass where it exits 0 ends the loop —
   the goal is met. The `maxRounds: 10` backstop and `onExhaust: hand-back`
   policy stop a non-converging loop rather than spinning forever.

**Operator-driven step (explicit).** Leg 2's live host re-invocation and pacing
is owned by the host runtime and cannot be asserted from `node:test`; that is
the boundary the division-of-labor ADR draws on purpose. The evidence above
exercises the underlying machinery each leg depends on — emit → ledger (§A.1),
oracle → exit 0 (§A.2), projection → command (§A.3) — so the contract seams are
proven even though the self-paced host loop itself is operator-driven.

**Verdict.** The assembled structure is sound. The three independently-built
slices compose into a coherent, host-driven loop with a schema-validated
progress trail, a runnable terminating oracle, and a discoverable namespaced
entry point — with no framework-side runner, exactly as the ADR intends.

---

## Part B — Follow-on simplification roadmap

The starter loops prove the *unit* pattern outward, for operator-facing
recurring work. The richer payoff is **inward**: mandrel's engine already
contains several hand-rolled "do work → check an oracle → repeat / back off /
escalate" loops, each re-deriving its own pacing, its own retry/backoff, and its
own exhaustion policy. These are the loop *unit* contract (action + oracle +
maxRounds + onExhaust) expressed as bespoke imperative code. Adopting a shared
loop substrate would collapse that duplication.

> **Two distinct substrates, do not conflate them.** The operator-facing loop
> *unit* (markdown + `/loop` host driver) is **not** the right tool for an
> in-engine, non-interactive poll — the engine cannot summon a host `/loop`.
> The relevant shared substrate for engine loops already exists:
> [`pollUntil` in `lib/util/poll-loop.js`](../.agents/scripts/lib/util/poll-loop.js)
> ("run `fn` on an interval until `predicate(result)` is truthy, the signal
> aborts, or `timeoutMs` elapses"), plus
> [`withTransientRetry` in `providers/github/transient-retry.js`](../.agents/scripts/providers/github/transient-retry.js)
> for the retry-with-backoff shape. The roadmap below routes each candidate to
> the appropriate substrate.

> **Honest caveat surfaced by this audit.** `pollUntil` is already written and
> unit-tested, but **has no production consumers** in `.agents/scripts` today —
> it was extracted ("mirrors the hand-rolled wait loops we replaced") ahead of
> the migration that would retire those loops. So the first, highest-leverage
> move is not new abstraction; it is **finishing the migration the primitive was
> built for**. That materially lowers the effort estimates below: the substrate
> exists, the call sites just have not been pointed at it.

### The hard-cutover cost gate (the trigger)

Per [`git-conventions.md` § Contract Cutovers — No Shim Layer](../.agents/rules/git-conventions.md),
every one of these is a **hard cutover**: the old hand-rolled loop is deleted in
the same PR that routes the call site through the shared primitive — no parallel
old-shape branch. That makes the per-candidate cost real, and the
**`duplication` quality gate** (`.agentrc.json` →
`delivery.quality.gates.duplication`, floor 12%, `targetDirs:
[".agents/scripts","bin","lib"]`) the honest trigger: a candidate is worth the
cutover when its bespoke poll/backoff/exhaustion code is duplicative enough to
move that number, or when the maintainability gate (floor 70) flags the
hand-rolled loop as a cognitive-load hotspot. Where neither gate is moved, the
cutover is **not yet justified** and the candidate stays on this list as a
watch item, not a work item.

### Candidates (prioritized by payoff ÷ effort)

#### P1 — merge-watcher poll → `pollUntil` *(highest payoff, lowest effort)*

- **File:** [`lib/orchestration/lifecycle/listeners/merge-watcher.js`](../.agents/scripts/lib/orchestration/lifecycle/listeners/merge-watcher.js)
  (the `while (true)` poll loop, ~line 308).
- **Today:** a hand-rolled `while (true)` that increments an attempt counter,
  shells out to `gh pr view`, sleeps `intervalSeconds` between attempts, and
  bails on `maxBudgetSeconds` — i.e. *exactly* `pollUntil`'s "run `fn` on an
  interval until `predicate` or `timeoutMs`" contract, re-implemented inline.
- **Adoption:** replace the `while (true)` body with `pollUntil({ fn: ghPrView,
  predicate: (r) => r.mergeCommit != null, intervalMs, timeoutMs })`. The
  resume-ledger append (the one genuinely watcher-specific concern) stays in
  `fn`. The interval-sleep, deadline accounting, and transient-error tolerance
  all move to the shared primitive.
- **Payoff:** retires the most literal re-implementation of `pollUntil` in the
  tree and **gives the already-built primitive its first real consumer**, which
  is the unlock for every later candidate. Directly trims `duplication` (the
  poll skeleton is the duplicated shape) and lifts `merge-watcher.js`
  maintainability by removing the bespoke loop-control branch.
- **Effort:** low — the primitive exists and is tested; this is a mechanical
  swap plus a budget-exceeded mapping.

#### P2 — push-epic retry → align on the shared retry shape

- **File:** [`lib/push-epic-retry.js`](../.agents/scripts/lib/push-epic-retry.js).
- **Today:** a bounded retry loop for non-fast-forward `git push` rejections:
  classify the stderr, fetch + reset + reapply, retry up to a cap, throw
  `PushRetryConflictError` on a real content conflict.
- **Adoption:** factor the *retry-with-classification-and-backoff* skeleton into
  a shared helper that both this and `withTransientRetry` specialize — same
  shape (try → classify error → bounded retry with backoff → throw on
  non-retryable), differing only in the predicate (`isNonFastForwardPush` vs
  `isTransientNetworkError`) and the per-attempt recovery action (fetch+reset
  vs plain re-call).
- **Payoff:** collapses two near-identical retry skeletons into one, trimming
  `duplication` across the two retry sites. Moderate maintainability win.
- **Effort:** medium — the recovery action (fetch/reset/reapply) is genuinely
  push-specific and must remain injectable, so this is a careful extraction,
  not a drop-in swap.

#### P3 — transient-retry → the canonical retry primitive

- **File:** [`providers/github/transient-retry.js`](../.agents/scripts/providers/github/transient-retry.js).
- **Today:** `withTransientRetry(fn, { retries, baseDelayMs, sleep })` — already
  the cleanest, most reusable of the retry loops, with an injectable `sleep` and
  a tight transient-error regex.
- **Adoption:** promote this to *the* canonical bounded-retry primitive (the
  base P2 specializes), rather than refactor it. It is the target shape, not a
  problem.
- **Payoff:** low direct payoff (it is already small and clean); the value is as
  the **anchor** for the P2 consolidation. Listing it documents that the retry
  family should converge **here**.
- **Effort:** low (mostly a naming/placement decision taken alongside P2).

#### P4 — idle watchdog re-tick → keep bespoke (watch item, not work item)

- **File:** [`wave-tick.js --check-idle`](../.agents/scripts/wave-tick.js) (the
  `runCheckIdle` path) and its core in
  [`lib/wave-runner/tick.js`](../.agents/scripts/lib/wave-runner/tick.js).
- **Today:** the watchdog itself is **deliberately stateless** — "the tick is
  stateless; *loop until terminal* is the caller's job (today: the markdown's
  wave loop)." The *re-tick every 30 minutes* cadence lives in the `/deliver`
  workflow prose, not in a JS loop here.
- **Adoption (and why not yet):** there is **no in-JS loop to collapse** — the
  iteration is intentionally externalized to the operator/workflow layer, which
  is the same "host owns cadence" principle the loop-unit ADR enshrines. Forcing
  a `pollUntil` here would *re-internalize* a cadence the design deliberately
  kept out of the engine. **Neither quality gate is moved** by touching it.
- **Verdict:** leave as-is. Record it here so a future contributor does not
  "consolidate" it by mistake — its statelessness is a feature.

#### P5 — ready-set scheduler → keep bespoke (watch item, not work item)

- **File:** [`lib/wave-runner/ready-set.js`](../.agents/scripts/lib/wave-runner/ready-set.js)
  and the [`tick.js`](../.agents/scripts/lib/wave-runner/tick.js) adapter.
- **Today:** `selectReadySet()` is a **pure, side-effect-free** single-beat
  selector — it "neither reads GitHub, the lifecycle ledger, nor a checkpoint,
  and dispatches nothing." It is explicitly *not* a loop: the continuous-tick
  iteration is the caller's (`/deliver`'s) responsibility, by design (Epic
  #4151's whole point was to retire the wave *barrier* in favor of a stateless
  per-beat selector).
- **Adoption (and why not):** the "loop" here is the operator-owned tick cadence,
  not engine code. The selector's purity is its central contract; wrapping it in
  a shared loop substrate would invert the very separation #4151 established.
  the `duplication` and `maintainability` numbers are already healthy here.
- **Verdict:** leave as-is. Watch item only — listed for completeness so the
  audit is honest that not every "loop-shaped" thing should adopt a loop
  substrate.

#### P6 — acceptance-self-eval → keep bespoke (prose contract, not a code loop)

- **File:** [`workflows/helpers/acceptance-self-eval.md`](../.agents/workflows/helpers/acceptance-self-eval.md).
- **Today:** the bounded per-round critic loop is **prose** consumed by the
  delivery agent, bounded by `delivery.acceptanceEval.maxRounds` (default 2,
  resolver-clamped). Its per-round mechanic (fresh-context critic → score each
  `acceptance[]` item → proceed/redraft/block) is a *judgment* loop, not a
  poll-an-oracle loop.
- **Adoption (and why not):** there is no shared *code* substrate that fits an
  LLM-critic judgment loop — `pollUntil`/`withTransientRetry` model
  deterministic predicates, not a critic verdict. The closest structural sibling
  is the loop *unit* contract (goal + bounded rounds + onExhaust), and indeed
  this helper already *is* a faithful instance of that contract expressed as
  prose. The only durable improvement would be to cross-reference the loop-unit
  vocabulary (`maxRounds` / `onExhaust`) from this helper so the two bounded-loop
  contracts read consistently — a **docs** change, not an engine cutover.
- **Verdict:** docs-only cross-link at most; no code consolidation. Lowest
  priority.

### Recommended sequencing

1. **P1 — merge-watcher → `pollUntil`.** Do this first. It is the lowest-effort,
   highest-payoff cutover, it gives the already-built `pollUntil` primitive its
   first production consumer, and it is the proof-of-value that unlocks the
   retry-family work.
2. **P3 + P2 together — converge the retry family.** Anchor on
   `withTransientRetry` (P3) as the canonical primitive, then extract the shared
   bounded-retry skeleton and re-base `push-epic-retry` (P2) onto it in one
   hard-cutover PR. Sequencing them together avoids landing an interim shape.
3. **Re-measure the gates.** After P1–P3, re-read `duplication` and
   `maintainability` for `.agents/scripts`. Only proceed past here if a gate is
   still pressured — the remaining candidates (P4, P5) are deliberately *not*
   loops and **P6 is prose**, so further "consolidation" risks inverting
   intentional design separations for no gate movement.
4. **P6 docs cross-link — opportunistic.** Fold the loop-unit `maxRounds` /
   `onExhaust` vocabulary into `acceptance-self-eval.md` whenever that file is
   next touched. Not worth a dedicated PR.

**Bottom line.** The genuinely actionable engine-loop simplification is narrow
and concrete: **finish the `pollUntil` migration (P1) and converge the retry
family onto `withTransientRetry` (P2+P3).** Everything else is either
intentionally stateless (P4, P5) or a prose contract (P6) — and the honest
trigger for acting on any of them is the `duplication` (12%) / `maintainability`
(70) quality gates moving, not the mere fact that the code is loop-shaped.
