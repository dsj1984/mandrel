# Epic lifecycle code review — `/epic-plan` + `/epic-deliver`

> **Date:** 2026-06-10
> **Scope:** ~4,600 lines of workflow prose, ~23k LOC of entry-point scripts,
> ~102k LOC under `.agents/scripts/lib/` (48k in `lib/orchestration` alone).
> Reviewed by five parallel deep-dives (planning, wave loop, story lifecycle,
> close-tail / lifecycle bus, prose layer). The highest-severity claims were
> independently verified in source.
>
> **Remediation tracking:** GitHub Stories #3900–#3911 (see
> [§6 Recommended sequence](#6-recommended-sequence)). All carry
> `type::story` + `meta::framework-gap`.
>
> **✅ Status: RESOLVED (2026-06-10).** All twelve remediation Stories
> (#3900–#3911) have been delivered and merged to `main` across a
> dependency-aware 5-wave `/story-deliver` run. Every §1 defect is repaired,
> the dead runner stratum (§2.1) is deleted, the state surfaces (§2.2) are
> collapsed, the resilience gaps (§3) are closed, and the planning/structural
> simplifications (§4) are landed. Per-Story merge commits are listed in
> [§6 Recommended sequence](#6-recommended-sequence). The findings below are
> retained as the historical review record; each is annotated with its
> resolving Story.

## TL;DR

The pipeline's deterministic core — DAG/wave planning, git-probe validation,
lease/checkout guards, the merge-recovery state machine, `evidence-gate` — is
genuinely good. But the codebase is carrying a **dead second architecture**: an
in-process epic-runner (bus + `WaveSession` + 19 listeners) was superseded by
the "host LLM drives CLIs" model, and roughly **10–15k LOC of the old stratum
is still wired in but unreachable**. Worse, **four load-bearing features
silently died in that migration** while the docs still describe them as live.

- **Deletable with zero capability loss:** ~12–15k LOC of JS and ~28% of the
  prose layer.
- **New code needed to make the surviving features actually work:** ~100 LOC.

The framework lints itself (781 LOC across `check-lifecycle-lint.js` /
`check-lifecycle-doc-drift.js`, a required CI check) yet none of the broken
features below were caught, because those gates police listener-table
**formatting** rather than **connectivity**. One contract test — *every
schema'd event has ≥1 production emitter and ≥1 production subscriber* — would
have caught most of §1.

---

## 1. Verified broken-by-construction defects

Each was confirmed in source; each is also documented as working in the
workflow prose. (Fix or delete — do not leave half-dead.)

### 1.1 Auto-merge can never fire → Story #3901

`epic.automerge.start` has **zero subscribers** in the chain `lifecycle-emit.js`
builds; `lib/orchestration/lifecycle/listeners/automerge-predicate.js:342`
subscribes only to `epic.watch.end`, which only the test-only `Watcher` emits.
Phase 8.5 of `epic-deliver.md` — the flagship "conditional auto-merge" in the
skill description — is a dead wire. The real run ledger for Epic #3823 confirms
no `epic.watch.*` / `epic.merge.*` / `epic.cleanup.*` event has ever been
emitted in production (so Phase 9 auto-cleanup never runs either).

### 1.2 Phase 8 "watch until green" watches nothing → Story #3902

`pr-watch-with-update.js` was collapsed (Story #2327, "<50 lines, exactly one
bus.emit") into a shim that emits `pr.created` into a **freshly created bus
with no listeners**, then exits 0. The fully implemented 557-line `Watcher`
(poll loop + `mergeStateStatus: BEHIND` recovery + update-branch cap) is
unreachable. The workflow then says "Exit 0 → proceed to Phase 8.5" — i.e. the
pipeline advances to (attempted) auto-merge with CI red or still running.

### 1.3 The idle-watchdog/heartbeat system cannot work, and actively harms → Story #3900

Three independent breaks compound:

- **(a)** `story.dispatch.end` is emitted only by
  `lib/orchestration/wave-session.js`, which nothing imports except tests — so
  every dispatched Story is "in-flight" forever and `--check-idle` flags
  completed Stories as stalled.
- **(b)** Heartbeats are appended via a **relative** `temp/` path
  (`lib/config/temp-paths.js` joins `'temp'`; `appendFileSync` resolves against
  `process.cwd()`). The story child `cd`s into `.worktrees/story-<id>/` before
  calling `story-phase.js` (no `--cwd`), so `story.heartbeat` records land in
  `<worktree>/temp/epic-N/lifecycle.ndjson` while the host reads the
  main-checkout copy.
- **(c)** Heartbeats fire only at phase transitions; `implementing → closing`
  routinely exceeds the 10-minute threshold.

Net: every healthy long-running Story trips the watchdog, whose prescribed
remediation is **re-dispatch** — and there is no per-Story lease, so that
yields two concurrent agents on one `story-<id>` branch (the worst failure mode
in the system, manufactured by its own safety mechanism). The same broken
heartbeat lookup also makes the Epic lease guard **silently reclaim live
foreign claims** (the exact audit-#3513 bug it was built to fix).

### 1.4 Phase 6 retro has no runner → Story #3903

`epic-deliver.md:484` says the retro is "driven by `epic-deliver.js`" — **that
file does not exist**. `runRetro` (`retro-runner.js`) has no CLI wrapper and
hard-requires `bus`+`provider`; the most recent real delivery shows the host
LLM hand-improvising a `run-retro.mjs` with a bare bus (so `retro.start/end`
never reached the ledger). The retro body then feeds the auto-merge predicate
via an emoji string-match (`'🟢 Clean sprint'.includes()`).

### 1.5 Planning `--force` re-plan and `--resume` idempotency are broken → Story #3905

- `spawnReconcilerApply`
  (`lib/orchestration/epic-plan-decompose/phases/reconcile-spawn.js`) invokes
  `epic-reconcile.js --apply --yes` **without `--explicit-delete`**, and
  `epic-reconcile.js` hard-exits 2 whenever the plan carries close ops. So the
  documented close-and-recreate `--force` re-plan fails on any changed ticket
  set — *after* the spec was already overwritten.
- `--resume`'s idempotency rests entirely on the gitignored
  `temp/epic-N/state.json` slug→issue map; if it's missing, the reconciler
  degrades to an empty mapping and **recreates the full Feature/Story tree on
  top of the existing one** — and `--resume` is precisely the documented
  recovery for that situation. The "title-matching resume" described in
  `epic-plan.md:833` no longer exists in code.

### 1.6 A believed-enforced planning validator validates nothing → Story #3906

`lib/orchestration/task-body-validator.js` skips any Story whose body is a
string; the decompose-author skill **mandates** string bodies (object bodies
throw in `createOp`). So the verify-tier suffix rule, vague-verb check, and
non-empty-goal check — which the skill tells the model are machine-checked —
never run on any canonical decomposition. Same genus: the story-init
`dependency-guard` (300 LOC) can never block under 3-tier
(`tasks.length === 0 → continue`) and has a destructuring bug (`config` passed
where `orchestration` expected) proving it never ran in anger; the dispatch
concurrency-gate has "no default loader wired" so it trivially passes; the
focus-overlap engine always produces zero edges since Task deletion.

### 1.7 Silent failure at finalize → Story #3904

`lifecycle-emit.js` exits 0 with success-shaped JSON even when the acceptance
reconciler fails or `closePlanningTickets` throws — listener classifications
are collected in memory and discarded; `epic.blocked` has no subscriber in the
CLI chain (no label flip, no comment, no notification). The workflow's promise
that "a non-OK reconciliation throws, aborting finalize" is false at the CLI
boundary.

---

## 2. Streamlining — what to delete

### 2.1 The dead runner stratum (~6–8k LOC + tests) → Story #3908

`wave-session.js`, `wave-scheduler.js`, `StoryLauncher.launchWave`,
`wave-gate.js`, `epic-deliver-close-tail.js` (547 LOC duplicate orchestrator
whose phase order already disagrees with the markdown), `commit-assertion.js`,
`blocker-wait.js`, the tick spec-path, `CheckpointPointerWriter` (writes a
checkpoint nothing reads), and the ~11 listeners + `factory.js` + `TraceLogger`
with no production activation path. **Note:** `commit-assertion.js` was the
**only** defense against a Story marked done with zero commits — decide
consciously: rewire it into `verifySingleResult` (one `git rev-list` per
done-claim) or accept label-trust and delete. Several of these violate the
repo's own hard-cutover doctrine (one even hides from the doctrine's grep via
`'orches' + 'tration'` string-splitting).

### 2.2 State-surface sprawl → Story #3909

An Epic run currently writes to five overlapping surfaces (`epic-run-state`
checkpoint, `dispatch-manifest` comment + 2 temp mirrors, `lifecycle.ndjson`,
`signals.ndjson` wave events, `epic-run-progress` + per-Story
`story-run-progress` comments at five phase transitions each). The per-wave
manifest refresh re-runs a **full dispatch pipeline** (re-fetch all tickets,
recompute waves) to update a cosmetic comment nothing reads. In planning, the
`epic-plan-state` comment's `phase` field is write-only telemetry duplicating
the labels at ~8 GitHub round-trips per plan. Keep three: checkpoint (resume),
ledger (forensics), one operator-facing progress comment.

### 2.3 Story-close redundancy → Story #3907 / Story #3909

Two parallel baseline-refresh subsystems (~1,800 LOC) score MI/CRAP up to three
times per clean close and emit the identical `chore(baselines):` commit; three
format-autofix modules for "format, commit if dirty"; cascade machinery sized
for a tree with fan-out >1 that can no longer exist; `story-deliver-prepare.js`
is a whole process that re-reads the comment `story-init` wrote seconds earlier.

### 2.4 Duplicated graph computation → Story #3909

Three-and-a-half wave/DAG implementations (prepare's `build-wave-dag`,
dispatcher's `dispatch-pipeline`, `stories-wave-tick`, plus the dead tick
spec-path) that can disagree on wave numbering. One function, two
presentations.

### 2.5 Prose layer (~28% cuttable) → Story #3910

`epic-plan.md` restates 346 lines of its two helpers nearly in full, and the
copies have **already diverged** — the wrapper calls `maxTickets` "the hard
ceiling" while helper+skill+script implement a soft budget with
`--allow-over-budget`; `helpers/epic-plan-spec.md` is a stale generation that
omits the Acceptance Spec entirely (a model loading only it produces a plan
that hard-fails `/epic-deliver`'s start gate). The acceptance self-eval loop
exists in triplicate; `single-story-deliver.md`'s routing table describes the
pre-rename `/story-deliver` and routes Epic-attached Stories to a command that
refuses them; Task-era debris (`tasksDone/tasksTotal` in the parent's demanded
return contract, "Bookend Lifecycle", troubleshooting "a Story with no child
Tasks") and an unfilled template token survive throughout.

---

## 3. Resilience & idempotence gaps (beyond §1) → Story #3907

- **story-close "merged locally, push failed":** the recovery probe greps the
  **local** `epic/<id>` ref, so a re-run classifies the unpushed merge as
  `ALREADY_MERGED`, skips the push, flips the ticket done, and deletes the
  branch local+remote — the work then exists only in one clone, and a sibling's
  `pull --rebase` can linearize away the `(resolves #N)` merge commit four
  subsystems depend on. Restrict probe (d) to `origin/…` or make
  resume-from-post-merge unconditionally re-push.
- **Scoped format-autofix runs in the wrong tree** (`story-close/phases/gates.js:239`
  gets main-checkout `cwd`, not `worktreePath`) and can land an unreviewed
  `fix(story-close):` commit on whatever branch the main checkout has out,
  including `main`. Pass `worktreePath`; assert branch identity before
  committing.
- **Wave-complete livelock:** only `record-wave` advances `currentWave`; if the
  host crashes after children finish but before recording, every re-tick
  returns `wave-complete` for the same index forever and the workflow says
  "loop". Let mode B accept "reconcile every Story in `plan[N]` from GitHub"
  with no returns.
- **Mode-B reconcile erases `blocked`:** a garbled return from a genuinely
  blocked child is recorded `failed`, losing `blockerCommentId` and steering
  the operator to the wrong remediation. Add the `agent::blocked` branch.
- **A manually closed Story is re-dispatched:** tick classifies by labels only;
  three different done-predicates exist across the codebase. Align on one
  `isStoryDone(ticket)` that respects `state === 'closed'`.
- **Spec-phase rerun demotes the Epic** (Story #3905-adjacent): re-running
  `epic-plan-spec.js` on a fully decomposed Epic unconditionally flips
  `agent::ready` → `agent::review-spec` and re-takes the lease; the plan lease
  also has no recorded claim-time, making the documented "`--steal` once you
  confirmed the other run is dead" undecidable.
- **Smaller but real:** worktree reuse rewrites `dependenciesInstalled: 'false'`
  to `'skipped'`, defeating the retry exactly when it matters; the
  acceptance-eval round cap trusts a self-reported `round` in a scratch file
  and doesn't survive a subagent restart (derive it from the `acceptance-eval`
  signals already appended to `signals.ndjson`); Windows `force-drain` matches
  holders by command-line substring and can `taskkill` its own ancestor shell
  mid-close; the preflight cache fingerprints only the Epic ticket, so
  Story-dependency edits don't invalidate it; partial-recovery reruns append a
  duplicate `## Planning Artifacts` section to the Epic body.

---

## 4. Overengineering vs. native frontier-model capability → Story #3910 (planning), Story #3911 (structural)

The clearest pattern in planning is **deterministic keyword/regex/Jaccard
proxies for judgment the host model is already making**:

| Mechanism | Verdict |
|---|---|
| Ticket structural validation (hierarchy, cycles, dep resolution), file-assumption git probes, `maxTickets` hard gate | **Keep** — cheap, hard, catches real hallucinations; highest-value determinism in the pipeline |
| Epic lease + checkout guards, evidence-gate skip-cache, PR open/locate probes, merge-reachability gating | **Keep** |
| Clarity gate (heading-presence ≥4/5 — passes an Epic with *no* Acceptance Criteria) | Replace scorer with one prompt sentence; keep the idempotent persist CLI |
| Spec-freshness "net-new cue" keyword classifier (18 keywords / 80-char window) | Delete the cue classifier; the decompose-side git probes are the real gate |
| BDD `findBestScenarioMatch` Jaccard the *skill asks the LLM to run* | Keep the scanner index, delete the matcher — the model authors the Disposition column either way |
| `duplicate-search` token-Jaccard | Replaceable by "fetch open Epic titles, ask the model"; harmless but 2023-era |
| Risk verdict: schema → axis-derivation → routing → one boolean | Keep schema + audit comment; collapse derivation/routing (~180 LOC) — the model authors the axes, so it already controls the gate |
| Phase 7.5 section gate (standalone CLI + module + manual phase validating a file the previous phase deletes) | Right check, wrong altitude — move the one-line call inside `runSpecPhase`, delete the CLI and the phase |
| Consolidate critic (fresh-context pass) | Keep the pattern; but its central "scope-preserving" claim has **no runtime check** — add a 30-line acceptance-union diff or drop the claim |
| Retro compactness heuristics, perf-signal classification, emoji string-match for "clean" | LLM judgment + a machine-readable JSON trailer on the comment; keep the deterministic intervention/wave-status inputs |

On the prose side, the fossil guardrails worth deleting: mode-B
return-parsing scaffolding (the repo's own Story #3864 measured **zero**
malformed terminal returns and deleted the parser — but kept the prompt
ceremony), the mid-run persona re-read, per-commit `git branch --show-current`
ritual (worktrees pin the branch), the literal "Heartbeat or block." magic
phrase, and Windows reap-taxonomy education in every story subagent's prompt.
The HITL pile-up in `/epic-plan`'s ideation path (up to 6 sequential
confirmations, including a duplicate of the skill's own gate) trains
rubber-stamping that dilutes the two gates that matter (risk review, re-plan
overwrite).

**Guardrails worth keeping** (encode non-obvious harness truths): synchronous
`Bash(timeout)` for story-init (never `Monitor`), "Edit tools ignore shell
cwd", ledger-before-dispatch ordering, "audit `findings: []` is intentional",
the `--base main` prohibition, one Agent call per Story for context isolation.

---

## 5. Calibration — what is genuinely good

`evidence-gate.js` (SHA + config-hash keyed skip cache, worktree-aware, fails
open on evidence-write errors) — the best cost/value ratio in the layer. Also
sound: `openOrLocatePr`'s probe/create split, `AutomergeArmer`'s
`autoMergeRequest` probe, `Cleaner`'s atomic rename + archive probe,
`epic-cleanup`'s fail-closed open-PR guard, `LedgerWriter`'s secret strip, the
PID-liveness + age-based steal in `epic-merge-lock.js`, the merge-recovery state
machine, `sync-branch-from-base`'s branch guard, and the DAG/wave planner. The
problem is not the parts; it is that the wiring between several of them exists
only in tests and prose.

---

## 6. Recommended sequence

| Step | Work | Stories | Status |
|---|---|---|---|
| **1. Repair (~100 LOC)** | Make the four silently-dead features work again and close the correctness gaps. | #3900, #3901, #3902, #3903, #3904, #3905, #3906, #3907 | ✅ Done |
| **2. Delete the dead stratum** | Remove the unreachable in-process runner + listeners (~10k LOC), consistent with the hard-cutover doctrine. | #3908 | ✅ Done |
| **3. Collapse state surfaces** | Keep checkpoint + ledger + one progress comment; drop the rest. | #3909 | ✅ Done |
| **4. Simplify planning + sweep prose** | Trim deterministic proxies; single-home each procedure; remove Task-era / stale-rename references. | #3910 | ✅ Done |
| **5. Structural (directional)** | Replace the bus with direct calls; collapse the steady-state wave loop. **Depends on steps 1–2.** | #3911 | ✅ Done |

All steps delivered and merged to `main` on 2026-06-10.

### Step 1 — repair stories

| Story | Title | Resolution |
|---|---|---|
| [#3900](https://github.com/dsj1984/mandrel/issues/3900) | repair idle-watchdog + Epic-lease via main-checkout ledger path and dispatch-end emission | ✅ [PR #3926](https://github.com/dsj1984/mandrel/pull/3926) (`9bd172bc`) |
| [#3901](https://github.com/dsj1984/mandrel/issues/3901) | make the Phase 8.5 auto-merge gate reachable + add event-connectivity contract test | ✅ [PR #3932](https://github.com/dsj1984/mandrel/pull/3932) (`509e0af2`) |
| [#3902](https://github.com/dsj1984/mandrel/issues/3902) | make Phase 8 pr-watch actually poll CI to green instead of emitting into an empty bus | ✅ [PR #3925](https://github.com/dsj1984/mandrel/pull/3925) (`078a891`) |
| [#3903](https://github.com/dsj1984/mandrel/issues/3903) | ship `retro-run.js` CLI so Phase 6 retro is executable (remove phantom `epic-deliver.js`) | ✅ [PR #3924](https://github.com/dsj1984/mandrel/pull/3924) (`b663840`) |
| [#3904](https://github.com/dsj1984/mandrel/issues/3904) | propagate finalize/listener failures to `lifecycle-emit` exit code and ledger | ✅ [PR #3927](https://github.com/dsj1984/mandrel/pull/3927) (`588f0ba3`) |
| [#3905](https://github.com/dsj1984/mandrel/issues/3905) | repair `--force` re-plan (`--explicit-delete`) and `--resume` idempotency on missing `state.json` | ✅ [PR #3928](https://github.com/dsj1984/mandrel/pull/3928) (`617a1215`) |
| [#3906](https://github.com/dsj1984/mandrel/issues/3906) | re-point or remove vacated validators and dead init guards | ✅ [PR #3929](https://github.com/dsj1984/mandrel/pull/3929) (`15caad90`) |
| [#3907](https://github.com/dsj1984/mandrel/issues/3907) | correct story-close push-failure recovery + format-autofix cwd, and close wave-loop resilience gaps | ✅ [PR #3930](https://github.com/dsj1984/mandrel/pull/3930) (`7ac053a9`) |

### Steps 2–5

| Story | Title | Resolution |
|---|---|---|
| [#3908](https://github.com/dsj1984/mandrel/issues/3908) | delete the dead in-process epic-runner stratum (bus/listeners/wave-session) | ✅ [PR #3936](https://github.com/dsj1984/mandrel/pull/3936) (`fcea7170`; 225 ins / 12,810 del) |
| [#3909](https://github.com/dsj1984/mandrel/issues/3909) | collapse overlapping run-state/progress surfaces to checkpoint+ledger+one comment | ✅ [PR #3945](https://github.com/dsj1984/mandrel/pull/3945) (`80b598c3`) |
| [#3910](https://github.com/dsj1984/mandrel/issues/3910) | simplify deterministic planning proxies and sweep stale/duplicated workflow prose | ✅ [PR #3931](https://github.com/dsj1984/mandrel/pull/3931) (`6b53fa80`) |
| [#3911](https://github.com/dsj1984/mandrel/issues/3911) | replace lifecycle bus with direct calls + collapse steady-state wave loop | ✅ [PR #3948](https://github.com/dsj1984/mandrel/pull/3948) (`037afdec`) — ADR `20260610-lifecycle-bus-retained`: bus **retained** (its schema-validate / ledger-ordering / seqId / secret-strip guarantees are load-bearing for the resume contract; the hot path already uses direct ledger-appends per #3900, and #3901's event-connectivity contract test meets the wrong-emit motive); wave-loop collapse already completed via #3909/#3907/#3900. |

> **Sequencing note (historical):** steps 1–2 ran before step 5. Story #3911
> (structural) was intentionally last — it did not start until the surviving
> features worked (#3900–#3907) and the dead stratum was removed (#3908). In
> delivery, #3911's architect pass concluded the bus should be **kept** (see
> the resolution note above) rather than replaced, since the wave-loop
> collapse was already achieved by the earlier repairs and the bus's
> invariants are load-bearing.

### Dependencies (encoded in GitHub)

Logical "blocked by" dependencies are encoded in each dependent issue body
using Mandrel's canonical `blocked by #N` token (parsed by
[`lib/dependency-parser.js`](../.agents/scripts/lib/dependency-parser.js) and
consumed by `stories-wave-tick.js` / `epic-deliver-prepare.js`). Only true
logical dependencies are encoded — "B cannot be correct or possible until A
lands" — not mere same-file edit collisions.

| Story | Blocked by | Why |
|---|---|---|
| #3907 | #3900 | Needs the corrected in-flight signal (dispatch-end + ledger path) before it can subtract in-flight from the dispatch set. |
| #3901 | #3903 | The auto-merge predicate must read the machine-readable retro trailer that #3903 introduces (replacing the emoji string-match). |
| #3908 | #3900, #3901, #3902, #3907 | What is "dead" cannot be determined until the repairs decide which listeners/modules get rescued vs. deleted. |
| #3909 | #3908 | Don't collapse state surfaces whose writers are mid-deletion. |
| #3910 | #3906 | Planning-proxy simplification layers on the vacated-validator cleanup. |
| #3911 | #3908, #3909 | Bus replacement + wave-loop collapse must follow dead-listener removal and state-surface collapse. |

Resulting dependency-aware wave plan (`stories-wave-tick.js`, acyclic):

| Wave | Stories |
|---|---|
| 0 | #3900, #3902, #3903, #3904, #3905, #3906 |
| 1 | #3901, #3907, #3910 |
| 2 | #3908 |
| 3 | #3909 |
| 4 | #3911 |
