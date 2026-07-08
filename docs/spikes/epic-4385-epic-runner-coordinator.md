# Spike: epic-runner coordinator sub-agent for the `/deliver` wave loop

> **Status:** Recommendation — **defer** (viable design, not yet adoptable as a
> default path). Spike for Epic #4385, Story #4388 (S6). Changes no production
> dispatch default; the coordinator is **not** implemented here and the idle
> watchdog / heartbeat substrate is **not** removed.

## Question

Today the **operator's top session** personally drives the entire `/deliver`
Epic wave loop (Phase 2 of `.agents/workflows/helpers/deliver-epic.md`): it
calls `wave-tick.js`, fans out one `Agent` call per ready Story, records each
return, re-ticks, and runs the 30-minute idle watchdog — for the full duration
of an Epic, which is routinely **hours**. That loop is mechanical
(dispatch → observe → record → re-tick) and consumes the operator's context
window and attention the whole time.

Now that the harness nesting limit is lifted (Claude Code 2.1.202 — a level-1
sub-agent carries the `Agent` tool; Epic #4385 / #2870), we can ask: **can a
per-segment _coordinator_ sub-agent own the wave loop instead**, so the
operator session delegates the loop once and reclaims its context until the
segment returns?

This spike resolves the four risk gates that decide whether that delegation is
safe:

1. **Crash-resume** — does a crashed coordinator resume onto the *same*
   `temp/epic-<id>/lifecycle.ndjson` checkpoint the current top-session loop
   uses?
2. **Retro env access** — does retro keep operator-session
   env/credential/MCP access at coordinator depth, or must it stay at the
   router level?
3. **Quota + watchdog** — does the extra agent-quota layer fit under the
   conservative concurrency cap, and does the idle watchdog relocate correctly
   into the coordinator?
4. **Recommendation** — adopt or defer, grounded in the first three.

## Proposed shape (what "coordinator" means here)

The `/deliver` router (`.agents/workflows/deliver.md`) already composes a
**sequential segment plan** over its input and delegates each Epic segment to
`helpers/deliver-epic.md`. The coordinator variant changes only *who runs the
Phase 2 loop*:

```text
/deliver <ids>                         ← operator top session (router, depth 0)
  → for each segment (sequential):
      Agent call → epic-runner coordinator  (depth 1, ONE standing agent)
        → Phase 2 wave loop:
            wave-tick.js → dispatch ready set → observe → record → re-tick
            Agent call × (cap) → helpers/epic-deliver-story  (depth 2)
        → returns segment terminal state to the router
  → router runs the env-privileged tail (retro, finalize, auto-merge) itself
```

Two invariants are load-bearing for the whole analysis and are asserted here up
front:

- **Single checkout per segment.** The coordinator runs in the *same* working
  checkout as the router (per-Story worktrees at `.worktrees/story-<id>/` are
  created by `story-init.js` for the depth-2 children, exactly as today). The
  coordinator does **not** get its own checkout. This is why the shared-
  filesystem checkpoint (Gate 1) and the ledger the watchdog scans (Gate 3)
  resolve identically at depth 1.
- **Scope = the mechanical loop only.** The coordinator owns Phase 2 (the
  dispatch/observe/record/re-tick loop) and its embedded idle watchdog —
  nothing else. Phases 3–9 (close-validation, epic-audit, code-review, retro,
  integration gate, finalize, watch-and-iterate, auto-merge, cleanup) stay at
  the router by default. Gate 2 is the reason this scoping is mandatory, not
  merely tidy.

---

## Gate 1 — Crash-resume lands on the same NDJSON-ledger checkpoint

**Verdict: PASS (substrate is depth-invariant), with one new liveness edge.**

The current loop's resume contract has two durable substrates, both **outside**
any agent's context window:

- The **`epic-run-state` structured comment** on the Epic (GitHub) — the flat
  per-Story status map and the global cap, seeded by `epic-deliver-prepare.js`
  and spliced by `epic-execute-record-wave.js`.
- The **append-only NDJSON ledger** at `temp/epic-<id>/lifecycle.ndjson` — the
  explicit resume target named in the `deliver-epic.md` contract. Every
  dispatch attempt is durably recorded by `lifecycle-emit-story-dispatch.js`
  **before** the `Agent` call fires; the matching `story.dispatch.end` is
  appended after the return is recorded. A `story.dispatch.start` with no
  matching `story.dispatch.end` is the canonical in-flight signal.

Neither substrate lives in the loop-runner's LLM context. The ledger path is
resolved from the project root by `lib/config/temp-paths.js`; because the
coordinator shares the router's checkout (invariant above), `temp/epic-<id>/`
resolves to the **same absolute path** at depth 1 as at depth 0. The
coordinator's `lifecycle-emit-*` calls append to the identical file; its
`wave-tick.js` reads the identical file. Crucially, `wave-tick.js` re-derives
readiness from the **live** Story labels/bodies on every beat, and the record
step re-derives a done-but-unrecorded Story from its live label — so recovery
reads GitHub + the shared ledger, never in-context state. **This machinery is
depth-invariant**: relocating it from depth 0 to depth 1 does not move the
checkpoint.

The one genuinely new edge is the **resume _trigger_**, which moves up a level.
Today, if the top session dies, the operator re-runs `/deliver <epicId>` and
idempotent-by-checkpoint resume picks up at the next undispatched ready set.
With a coordinator, a **crashed coordinator** is a silent sub-agent from the
router's point of view (a parent never sees inside a child at any depth — the
same reason the idle watchdog exists). Two things make this tractable and keep
Gate 1 green:

- **Recovery is already idempotent.** Re-spawning the coordinator (or re-running
  `/deliver <epicId>`) resumes from the exact same `epic-run-state` + NDJSON
  ledger. The coordinator is stateless over that checkpoint, exactly like the
  top session is today. A coordinator that died mid-loop leaves the ledger in a
  recoverable state (in-flight Stories are those with an unclosed
  `story.dispatch.start`), and the next tick re-derives their live status. No
  double-dispatch onto a `story-<id>` branch results, because the deterministic
  branch-commit check (below, Gate 3) protects a Story still gaining commits.
- **The router needs a coordinator-liveness signal**, symmetric to the existing
  Story-level heartbeat. This is the only *new* substrate the coordinator path
  requires: the coordinator must emit a `coordinator.heartbeat`-class ledger
  record (or reuse the existing lifecycle bus) at each loop beat, and the router
  must apply a thin watchdog over it — the mirror image of what the coordinator
  does for its Story children. This is additive; it does not weaken the
  checkpoint.

**Conclusion:** the checkpoint the coordinator resumes onto is byte-identical to
the top-session one, because it is the same on-disk NDJSON ledger + the same
GitHub comment, and both are read fresh each beat. Gate 1 is satisfied at the
substrate level; the only cost is one new router→coordinator liveness edge that
reuses the existing heartbeat pattern.

---

## Gate 2 — Retro env / credential / MCP access at coordinator depth

**Verdict: retro MUST stay at the router (operator) level. Do not move it into
the coordinator.**

Phase 6 retro is deliberately placed **before the PR opens** for one documented
reason: it must run in the operator's local session with **full env access —
env vars, credentials, and MCP servers**. `retro-run.js` resolves a
config/provider and calls `runRetro`, whose provider may reach for exactly those
privileged surfaces; the GitHub upsert is the source of truth, and the local
`temp/epic-<id>/retro.md` mirror is best-effort.

Whether a sub-agent inherits the operator session's **MCP wiring and
credentials** at depth is **not an established invariant** of this build. What is
confirmed is narrower: sub-agents inherit the parent's worktree context and
permissions, and `Skill`-in-subagent works (confirmed 2026-06-10). MCP-server
availability and credential propagation *at depth* are a harness concern the
framework has not proven, and treating them as guaranteed is precisely the kind
of silent assumption that would strand retro on a coordinator where the provider
cannot reach its MCP/credential surface.

The Story offers this exact escape hatch — "or documents that retro stays at the
router level" — and that is the correct resolution:

- **The coordinator owns the mechanical wave loop only.** The loop needs no
  privileged env: `wave-tick.js`, the `Agent` fan-out, `epic-execute-record-
  wave.js`, and the lifecycle emits are all deterministic CLI + GitHub label
  operations that already run correctly in any Story sub-agent context today.
- **Retro (and, by the same precaution, any other env-privileged phase) stays at
  the router.** After the coordinator returns the segment's terminal wave state,
  the router — still the operator's local session with full env access — runs
  Phase 6 retro exactly as it does now. This preserves the documented env-access
  invariant with zero risk, and it is consistent with Epic #4385's Non-Goal of
  *not* disturbing places where the current arrangement is correct by design.

**Conclusion:** Gate 2 resolves by **scoping**, not by proving MCP-at-depth.
Retro stays at the router level; the coordinator is deliberately confined to the
env-agnostic loop. This scoping is a hard requirement of the design, not an
optimization — it is what keeps the operator-session env-access guarantee intact.

---

## Gate 3 — Quota layer vs. concurrency cap, and watchdog relocation

**Verdict: quota fits as cap + 1 standing agent; the Story-facing watchdog
relocates 1:1 into the coordinator, plus one thin router-level check is added.**

### Quota accounting against the conservative cap

The default `concurrencyCap` is **3** — the GLOBAL in-flight cap on **Stories**,
intentionally conservative to bound host quota and GitHub API load. It caps the
Story fan-out, not supervisory agents.

- **Today:** peak = the operator top session (doing light dispatch/record work)
  + up to 3 concurrent Story children = **3 compute-heavy agents** under the cap,
  with the top session mostly waiting.
- **Coordinator:** peak = 1 **standing coordinator** (alive for the whole loop,
  hours) + up to 3 concurrent Story children = **cap + 1 = 4** live agents. The
  coordinator sits **outside** the Story cap — it is a supervisor, not a Story
  slot — so the cap's semantics are unchanged; the host quota budget simply
  gains a persistent **+1**.

The relevant caution is `instructions.md` § 4: **every nesting level re-pays the
full always-loaded context.** The coordinator re-pays once (a bounded, one-time
cost amortized over a multi-hour loop), and each Story child now re-pays at
**depth 2** instead of depth 1 (same always-loaded bytes, one level deeper —
verified-supported, since depth 2 is empirically confirmed). Net quota cost: one
standing supervisory agent for the duration of the loop, in exchange for freeing
the operator's context window. This is a real but **modest and bounded**
overhead — it does not scale with Story count, and it does not raise the Story
concurrency itself.

The trade only turns bad if the coordinator *also* fans out env-privileged or
deeper work (e.g. the Phase 4 audit sweep from Story #4385 S3), which would push
to **depth 3+** — announced as supported (max 5) but **not independently
verified beyond depth 2** on this build. The scoping in Gate 2 already forbids
this: the coordinator runs the loop and nothing else, so the depth budget stays
within the verified envelope (coordinator @ 1, Stories @ 2).

### Watchdog relocation

The idle watchdog (`wave-tick.js --epic <id> --check-idle 30`) today runs in the
top session while any Story is in flight. It scans `temp/epic-<id>/
lifecycle.ndjson` for Stories with an unclosed `story.dispatch.start`, compares
each in-flight Story's most recent `story.*` event (notably `story.heartbeat`)
against the 30-minute threshold, and — critically — also checks the last commit
on `story-<id>` via `git log`, so a Story still gaining commits is never flagged
(the deterministic false-positive guard, Story #3900). On a stall it posts a
`wave-stall` comment and re-dispatches (incrementing `--attempt`) or blocks.

This relocates **cleanly and 1:1 into the coordinator**, because the coordinator
already owns every input and action the watchdog needs:

- **Inputs are shared-filesystem + GitHub**, readable at depth 1 (the ledger is
  the same file per the Gate 1 invariant; `git log` reads the same checkout).
- **The remediation action _is_ the coordinator's own job** — re-dispatching a
  stalled Story via a § 2b `Agent` fan-out is exactly what the coordinator does
  every beat. The watchdog is not a separate capability; it is the same loop with
  a staleness predicate.

So the Story-facing watchdog moves into the coordinator with no semantic change.
The **one addition** Gate 1 already identified is a **thin router-level watchdog
over the coordinator itself** — a coordinator that goes silent is invisible to
the router the same way a silent Story child is invisible to the coordinator.
That router check reuses the identical pattern (heartbeat + deterministic
progress signal + re-spawn on stall) at one level up. Epic #4385's Non-Goal is
explicit that the watchdog/heartbeat substrate is **depth-invariant and must not
be removed** — the coordinator path *confirms* this by requiring the substrate at
**two** levels, not one.

**Conclusion:** quota fits as a bounded cap + 1; the Story-facing watchdog
relocates correctly into the coordinator; a second, thin router→coordinator
watchdog is a required addition (not a removal), keeping the substrate intact at
both depths.

---

## Gate 4 — Recommendation: **DEFER** (viable, not yet a default)

Grounded in the three gates above:

| Gate | Outcome | Residual cost |
| --- | --- | --- |
| 1 — Crash-resume | **PASS** — same on-disk NDJSON ledger + GitHub `epic-run-state`, read fresh each beat; depth-invariant | One new router→coordinator liveness edge (reuses heartbeat pattern) |
| 2 — Retro env access | **RESOLVED by scoping** — retro stays at the router; coordinator confined to the env-agnostic loop | Coordinator cannot own any env-privileged phase |
| 3 — Quota + watchdog | **TRACTABLE** — cap + 1 standing agent; watchdog relocates 1:1 | A second thin watchdog layer at the router |

No gate is a hard blocker. The design is **viable**: the checkpoint substrate is
depth-invariant, the env-access invariant is preserved by scoping, and the
watchdog/quota costs are bounded and understood. But the honest recommendation
is to **defer adoption as a default delivery path**, for three reasons the
evidence above surfaces:

1. **The win is real but bounded; the new failure surface is not free.** The
   benefit is reclaiming the operator's context during a mechanical loop —
   valuable, but it buys nothing that changes *delivery correctness*. Against it,
   the coordinator introduces a genuinely new failure mode (router↔coordinator
   liveness, a second watchdog layer, a crashed-coordinator resume trigger). That
   is negative expected value **until** the win is measured against the added
   operational surface on a real Epic.
2. **Depth verification is thin at exactly the boundary this leans on.** Depth 2
   is empirically confirmed; depths 3–5 are announced but **not independently
   verified** on this build. The scoped coordinator lives safely at depth 1 with
   Stories at depth 2 — but the design has no headroom, and any later ask to let
   the coordinator also run the audit fan-out (S3) or a critic pass (S4) would
   push into unverified depth. Adopting the coordinator as a default now would
   invite that push before the envelope is proven.
3. **MCP-at-depth is unproven, and the whole retro scoping rests on avoiding
   it.** Gate 2 is safe *because* it never relies on MCP/credential propagation
   at depth. That is the right call today, but it means the coordinator can never
   grow to own a privileged phase until MCP-at-depth is empirically nailed. A
   default path with a permanent "can never touch env" ceiling is a design worth
   proving deliberately, not defaulting into.

### Recommended next step (not a silent cutover)

Per Epic #4385's acceptance criterion that **neither spike is a silent cutover**,
do **not** flip the coordinator on as the default. Instead:

- **Prototype the coordinator behind an explicit opt-in flag** (e.g. a
  `delivery.deliverRunner.coordinator` config gate defaulting to `false`), scoped
  strictly to the Phase 2 loop + its embedded watchdog, with retro and all
  env-privileged phases left at the router.
- **Measure on a real multi-wave Epic**: operator-context tokens saved vs. the
  added coordinator standing-quota cost, the router-watchdog overhead, and any
  observed crash-resume behavior on an induced coordinator kill.
- **Gate default adoption on**: (a) S3/S4 landing and proving depth-2 fan-out in
  production, (b) depth 3+ independently verified on the target build, and (c)
  the MCP-at-depth question resolved for any future privileged phase.

Until those three land, the operator-owned wave loop remains correct by default,
and the coordinator stays a proven-viable, measured, opt-in path — not the
default.

## Non-goals honored

- **No coordinator is implemented as a default path.** This document changes no
  dispatch default; the flat, operator-owned wave loop is unchanged.
- **The idle watchdog / heartbeat substrate is not removed.** The analysis
  *depends* on it and in fact requires it at two depths — consistent with Epic
  #4385's Non-Goal that the substrate is depth-invariant, not a flat-dispatch
  tax.

## References

- `.agents/workflows/helpers/deliver-epic.md` — the Epic delivery path
  (Phase 2 wave loop, retro Phase 6, the lifecycle-bus contract naming the NDJSON
  ledger as the resume target).
- `.agents/workflows/helpers/deliver-epic-reference.md` — the throughput
  trade-off (`concurrencyCap` = 3 global cap), the § 2e Idle Watchdog cadence /
  staleness test / branch-commit guard, and the crash-recovery record step.
- Epic #4385 / watch ticket #2870 — the lifted nesting limit (verified depth 2,
  announced max 5) and the S6 acceptance gates this spike resolves.
