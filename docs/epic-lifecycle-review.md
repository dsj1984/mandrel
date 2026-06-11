# Epic lifecycle code review — open findings (follow-up)

> **Original review:** 2026-06-10, `/epic-plan` + `/epic-deliver` surface
> (workflow prose, entry-point scripts, `lib/orchestration`), five parallel
> deep-dives.
>
> **Re-verified:** 2026-06-10 at v1.58.0 (commit `158ebc75`). All twelve
> remediation Stories
> ([#3900](https://github.com/dsj1984/mandrel/issues/3900)–[#3911](https://github.com/dsj1984/mandrel/issues/3911))
> were delivered and merged. Every §1 broken-by-construction defect
> (auto-merge dead wire, no-op pr-watch, idle-watchdog/heartbeat breaks,
> phantom retro runner, `--force`/`--resume` breakage, vacated validators,
> silent finalize failure) is confirmed repaired in source; the dead
> in-process runner stratum was deleted (#3908, 12.8k LOC removed); the state
> surfaces were collapsed (#3909); the headline prose divergences were fixed
> (#3910); and #3911 closed with an ADR (`20260610-lifecycle-bus-retained`)
> **keeping** the bus because its schema-validate / ledger-ordering / seqId /
> secret-strip guarantees are load-bearing. Resolved findings have been
> removed from this document — the full original record is in this file's git
> history (`95fbaaf3`, marked resolved in `1bcde389`).
>
> What remains below: sub-findings the stories did **not** cover, items
> consciously **deferred** by ADR, and two record corrections — each
> re-verified against current `main`.

---

## 1. Sub-findings not covered by the remediation stories

### 1.1 Story-close redundancy (was §2.3) — **resolved by Story #4017**

Story #4017 collapsed the cluster:

- **One baseline-refresh funnel.** The standalone delta-cap evaluator module
  was deleted (the evaluator now lives inside
  [`auto-refresh-runner.js`](../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js)),
  and both story-close call paths — the gate-failure attribution retry and
  the post-gates bounded auto-refresh — route through the single
  `runRefreshCommit` funnel in
  [`refresh-commit.js`](../.agents/scripts/lib/orchestration/story-close/baseline-attribution/phases/refresh-commit.js),
  sharing one per-close `cycleState` idempotency token. A clean close
  computes each baseline kind once and emits at most one
  `chore(baselines): refresh <kind> for story-<id>` subject per kind.
- **One format-autofix module.**
  [`format-autofix.js`](../.agents/scripts/lib/orchestration/story-close/format-autofix.js)
  now hosts both the whole-tree and scoped entry points plus the shared
  plumbing; the two redundant siblings were deleted (the #3907 worktree-cwd
  fix and branch assert are preserved).
- **Cascade grouping deleted.** `ticketing/bulk.js` walks parents
  sequentially (fan-out ≤ 1 under the 3-tier hierarchy).
- **Prepare inlined.** The standalone prepare CLI is gone; `story-init.js`
  applies the install tri-state and renders the initial Story-phase
  snapshot in-process, consuming its own init result.

### 1.2 Wave/DAG computation (was §2.4) — partially mitigated by structure

All three wrappers bottom out in the shared `lib/Graph.js#assignLayers`
kernel, which softens the original "can disagree on wave numbering" claim —
but the story-level adjacency building is still triplicated
([`build-wave-dag.js`](../.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js),
[`dispatch-pipeline.js:182`](../.agents/scripts/lib/orchestration/dispatch-pipeline.js)
via `computeStoryWaves`, and `stories-wave-tick.js` calling the kernel
directly), and the **dead tick spec-path survives**:
[`lib/wave-runner/tick.js`](../.agents/scripts/lib/wave-runner/tick.js)
still accepts `spec`/`state` arguments that no production caller passes —
only a test exercises them.

*Recommendation:* delete the spec-path; extract one shared adjacency builder.

### 1.3 Prose/Task-era crumbs (was §2.5 — mostly resolved by #3910)

The big divergences are fixed (maxTickets is now documented as a soft budget,
`helpers/epic-plan-spec.md` authors all three artifacts with an explicit
SSOT-pointer, the routing table is corrected). Five crumbs remain — one small
sweep:

- [`helpers/single-story-deliver.md:635`](../.agents/workflows/helpers/single-story-deliver.md)
  see-also entry still labels `/story-deliver` as "Epic-attached Story
  execution" (it is standalone-only).
- [`epic-plan.md:17`](../.agents/workflows/epic-plan.md) — "backlog of
  Features, Stories, and Tasks".
- [`helpers/epic-deliver-story.md:314`](../.agents/workflows/helpers/epic-deliver-story.md)
  — "when all Tasks are closed".
- `lib/task-utils.js:22` — the bookend-task predicate survived (module
  deleted by Story #4021).
- [`epic-runner/sub-agent-return.js`](../.agents/scripts/lib/orchestration/epic-runner/sub-agent-return.js)
  still parses `tasksDone`/`tasksTotal` from child returns.

### 1.4 Resilience small items (was §3 tail) — all six still present

Story #3907 fixed its six headline items (push-recovery probe, autofix cwd,
double-dispatch, `isStoryDone`, blocked-reconcile, wave livelock). The
smaller-but-real tail was not covered:

1. **Worktree reuse defeats the install retry:**
   [`worktree/lifecycle/creation.js:56,90`](../.agents/scripts/lib/worktree/lifecycle/creation.js)
   returns `installStatus: 'skipped' (worktree-reused)` even after a prior
   *failed* install, and prepare's `deriveInstallAction('skipped')` then
   skips the retry exactly when it matters.
2. **Acceptance-eval round cap trusts a self-reported scratch value:**
   [`acceptance-eval-decision.js:107`](../.agents/scripts/lib/orchestration/acceptance-eval-decision.js)
   reads `verdict?.round` instead of deriving the round from the
   `acceptance-eval` signals already appended to `signals.ndjson`; it does
   not survive a subagent restart.
3. **Windows `force-drain` can kill its own ancestor shell:**
   [`force-drain.js`](../.agents/scripts/lib/worktree/lifecycle/force-drain.js)
   still matches holders by command-line substring over `Win32_Process` and
   `taskkill /T /F`s each hit with no own-pid/ancestor exclusion.
4. **Preflight cache fingerprints only the Epic ticket:**
   [`preflight-cache.js:68–79`](../.agents/scripts/lib/orchestration/preflight-cache.js)
   hashes Epic `id/body/labels/updatedAt` only, so Story-dependency edits
   don't invalidate it. (Commit `26bf1b3b` / #3960 is adjacent but distinct —
   it made the file-assumption gate wave-aware, not the cache key.)
5. **Partial-recovery reruns duplicate `## Planning Artifacts`:**
   [`plan-epic.js:391`](../.agents/scripts/lib/orchestration/epic-plan-spec/phases/plan-epic.js)
   appends unconditionally; the strip in `planning-state-manager.js` runs
   only under `--force`.
6. **Spec-phase rerun still demotes the Epic, and `--steal` is still
   undecidable:** `run-spec-phase.js:205` unconditionally flips a
   fully-decomposed Epic from `agent::ready` to `agent::review-spec` (#3905
   fixed only `--explicit-delete` and the `state.json` reseed), and the plan
   lease records no claim-time — liveness comes solely from
   `story.heartbeat` ledger scans, which `/epic-plan` never emits, so the
   lease guard treats *any* foreign claim as live and the documented
   "`--steal` once you confirmed the other run is dead" remains
   out-of-band.

---

## 2. Consciously deferred by ADR — revisit or formally accept

ADR `20260610-planning-determinism-dispositions`
([docs/decisions.md](decisions.md)) recorded keep/defer dispositions for the
§4 deterministic-proxy table. Status after re-verification:

| Item | Status |
|---|---|
| Clarity gate heading scorer | **Resolved by other means** — scorer kept but hardened: `clear` now additionally requires the Acceptance Criteria section ([epic-plan-clarity.js:85](../.agents/scripts/lib/epic-plan-clarity.js)), which closes the original complaint ("passes an Epic with no Acceptance Criteria") |
| Consolidate-critic "scope-preserving" claim | **Resolved** — claim dropped per ADR (option 2); `assertNoSingleStoryFeature` is the only runtime backstop, stated plainly |
| Retro emoji string-match | **Resolved** — machine-readable `automerge-verdict` JSON trailer emitted by the retro and parsed by the auto-merge predicate; malformed/absent trailer disqualifies |
| Spec-freshness 18-keyword cue classifier | **Deferred** — still in [`spec-freshness.js:77–92`](../.agents/scripts/lib/orchestration/spec-freshness.js) |
| BDD `findBestScenarioMatch` Jaccard | **Deferred** — still in [`bdd-scenario-scanner.js:300`](../.agents/scripts/lib/bdd-scenario-scanner.js) |
| Risk axis-derivation/routing (~180 LOC) | **Deferred** — `planning-risk.js` + `plan-review-routing.js` intact |
| Phase 7.5 standalone section-gate CLI | **Deferred** — `epic-plan-spec-validate.js` + manual phase ([epic-plan.md:623](../.agents/workflows/epic-plan.md)) survive |
| `duplicate-search` token-Jaccard | **Unaccounted** — still present and *not listed* in the ADR's deferred set; add it to the ADR or do the replacement |

The deferrals are legitimate recorded decisions; this document keeps them
only so the next planning pass either schedules them or upgrades the ADR to
"accepted permanently". The one action item is `duplicate-search`, which fell
through the cracks of the ADR.

## 3. Prose fossils remaining (was §4 prose)

- **Mode-B return-parsing ceremony** — `epic-deliver.md:301–326` still
  demands the per-child JSON return contract in every dispatch prompt.
  *Severity downgraded:* since #3907, garbled/empty returns reconcile from
  GitHub instead of crashing, so the ceremony is now redundancy rather than a
  load-bearing parser — but it is still prompt weight in every child.
- **Windows reap-taxonomy education** — still taught to every story subagent
  at [`helpers/epic-deliver-story.md:303–317`](../.agents/workflows/helpers/epic-deliver-story.md).

The other fossils (mid-run persona re-read, per-commit
`git branch --show-current` ritual, "Heartbeat or block." magic phrase, the
HITL pile-up in `/epic-plan` ideation) are confirmed gone — the new Phase 1.5
ideation gate (`7cf47258`) explicitly folds into the existing Phase 1 stop
rather than adding one.

## 4. Record corrections

1. **`wave-scheduler.js` was not deleted.** The #3908 commit message
   (`fcea7170`) lists it among the dead-stratum deletions, but
   `git show --name-status` proves it was untouched — it survives as a
   **live** dependency of the kept `build-wave-dag.js` (imported by
   `epic-deliver-prepare.js` / `epic-deliver-preflight.js`). Not a bug; the
   commit message is simply inaccurate on this one file. Recorded here so
   nobody "finishes the deletion" against a live module.
2. **The zero-commit-done defense is now strictly weaker, by documented
   choice.** `commit-assertion.js` (the only guard against a Story marked
   done with zero commits) was deleted in #3908 with label-trust consciously
   accepted in the commit body. The surviving guard,
   [`verifySingleResult`](../.agents/scripts/lib/orchestration/wave-record-io.js)
   (wave-record-io.js:72–103), re-fetches each done-claim but checks
   **labels/state only**. If that trust is ever regretted, the original
   review's alternative still applies: one `git rev-list` per done-claim
   inside `verifySingleResult` restores the defense for ~10 LOC.

---

## 5. Updated recommendation sequence

| Priority | Work | From |
|---|---|---|
| P2 | Collapse the story-close redundancy cluster (one refresh funnel, one autofix module, delete cascade grouping, inline prepare) — the largest remaining LOC win | §1.1 |
| P2 | Fix the six resilience tail items — small diffs, real failure modes; the Windows `taskkill`-own-ancestor (§1.4.3) and the spec-rerun demotion + undecidable `--steal` (§1.4.6) first | §1.4 |
| P3 | Delete the dead tick spec-path; extract one shared adjacency builder | §1.2 |
| P3 | One prose sweep: five Task-era crumbs + the mode-B ceremony + Windows reap-taxonomy | §1.3, §3 |
| Decide | Schedule or permanently accept the four ADR-deferred proxies; add `duplicate-search` to the ADR either way | §2 |
| Optional | `git rev-list` check in `verifySingleResult` if label-trust proves too weak | §4.2 |

## What was confirmed good (unchanged)

The deterministic core praised in the original review — DAG/wave planning,
git-probe validation, lease/checkout guards, the merge-recovery state
machine, `evidence-gate.js` — remains the strongest part of the layer, and
the #3900–#3911 repairs connected the wiring that previously existed only in
tests and prose: the auto-merge gate is reachable behind a real CI-green
poll, the watchdog reads the ledger the children actually write, finalize
failures propagate to the exit code, and an event-connectivity contract test
(#3901) now guards against the silent-disconnection failure mode that
produced most of the original §1.
