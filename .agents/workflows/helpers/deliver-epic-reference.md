---
description: >-
  Reference companion to `helpers/deliver-epic.md` — the recovery
  procedures, historical rationale, and troubleshooting detail lifted out
  of the runtime core so the always-ingested Epic-delivery prose stays lean.
  Not a slash command; consulted on demand when the core file points here.
caller: helpers/deliver-epic.md
---

# helpers/deliver-epic — reference (recovery, rationale, troubleshooting)

> **Not a slash command, not the runtime path.** This file is the
> reference companion to [`deliver-epic.md`](deliver-epic.md). The core
> file carries the phase flow, commands, gate contracts, and return shapes
> a `/deliver` run needs on every beat; this file holds the recovery
> procedures, the "why it works this way" rationale, and the
> troubleshooting detail the core points at with one-line pointers. Read a
> section here only when the matching pointer in the core sends you.

---

## Phase 1 — Preflight guards (Story #3482 / F-workflow-guards)

Before the snapshot phase runs — and before any worktree is created —
`epic-deliver-prepare.js` runs two **fail-closed** guards
([`lib/orchestration/epic-deliver-lease-guard.js`](../../scripts/lib/orchestration/epic-deliver-lease-guard.js)):

1. **Checkout safety.** Prepare refuses to start when the working tree is
   dirty or HEAD is on a branch other than the expected one (`epic/<id>`
   on a resume, or the project base branch on a fresh run). It will
   **not** check `epic/<id>` out over your work — the historic
   HEAD-yank footgun. Remediation: commit/stash/clean the tree, or
   switch to the expected branch, then re-run.
2. **Epic lease.** Prepare acquires the assignee-as-lease on the Epic
   ticket (`ticket-lease.acquireLease`). On a **live foreign claim**
   (a teammate's run with a fresh `story.heartbeat` within
   `delivery.lease.ttlMs`) it exits non-zero and names the current owner;
   a **stale** claim is silently reclaimed. The operator identity is
   resolved from `--as <handle>` → `github.operatorHandle` →
   `git config user.email`. Pass `--steal` to forcibly transfer a live
   foreign claim (the takeover is logged for auditability). The committed
   `github.operatorHandle` is the non-personal `@[USERNAME]` placeholder,
   which resolves to null — so when none of the three sources yields a real
   identity the guard **fails closed** (throws after the checkout guard
   runs) rather than driving an ownerless, unguarded delivery. Set your own
   handle in `.agentrc.local.json`, pass `--as <handle>`, or configure
   `git user.email`. The lease is the cross-clone coordination layer, while
   `epic-merge-lock.js` continues to serialize same-machine sessions.

Both guards throw on failure, which `runAsCli` maps to `process.exit(1)`
per [`orchestration-error-handling.md`](../../rules/orchestration-error-handling.md).

### Acceptance-table start gate

Once the preflight guards pass, the snapshot phase applies one more gate.
Before the wave loop fans out, the snapshot phase
([`lib/orchestration/epic-runner/phases/snapshot.js`](../../scripts/lib/orchestration/epic-runner/phases/snapshot.js))
asserts that the Epic either carries the `acceptance::n-a` waiver label
**or** has a `## Acceptance Table` managed section in its body — section
presence is sufficient. The reviewer's OK during `/plan` Phase 7 is the
approval signal. Neither condition met → the snapshot throws a clear error
(`[epic-deliver] Epic #<id> cannot launch: …` — naming the missing
`## Acceptance Table` section and the absent waiver) and `runAsCli` maps it
to `process.exit(1)`. Operator remediation: either run `/plan` Phase 7 to
author the acceptance table, or apply the `acceptance::n-a` label to opt
out.

---

## Phase 2 — Dispatch rationale and recovery

### Throughput tradeoff

The default `concurrencyCap` of 3 is the GLOBAL in-flight cap,
intentionally conservative — it keeps host-quota consumption low and avoids
flooding the GitHub API. For Epics with wide dependency-free fronts where
the host has adequate parallel-agent quota, raising
`delivery.deliverRunner.concurrencyCap` in `.agentrc.json` reduces
wall-clock time proportionally to the extra concurrency. The safe default
is left in place; this is a deliberate operator-tuning knob, not a hidden
performance ceiling. See `agentrc-reference.json`
`delivery.deliverRunner.concurrencyCap` for the configuration surface.

### Sub-agent dispatch capability

`Agent` calls emit no `model:` argument by default — children inherit from
the `general-purpose` sub-agent definition and the parent's worktree
context. No `--dangerously-skip-permissions` (no subprocess is spawned).
Per [`.agents/instructions.md` § 4](../../instructions.md)'s cost-aware
spawning heuristic, this optional per-call `model:` is the escape hatch: if
a specific call would run better on a cheaper or faster capability the host
exposes (a mechanical or read-only Story), pass `model:` as a per-call
literal at the `Agent(...)` site. This is **guidance only** — it adds no
config key, requires no model argument, and names no specific model; the
host and operator own the concrete choice.

### Fail-closed on an old-shape checkpoint

If the Epic still carries a pre-ready-set (`plan` / `currentWave` /
`totalWaves`) `epic-run-state` checkpoint, the tick **refuses to run** and
throws an explicit operator message — re-run
`epic-deliver-prepare.js --epic <id>` to re-seed the checkpoint in the
per-Story-status shape, then re-run `/deliver`.

### Crash recovery (record step)

If the host crashed *after* a child finished but *before* its return was
recorded, the next `tick` re-derives that Story's state directly from its
live label (the tick reads labels every beat), so a done-but-unrecorded
Story is recognised as done and never re-dispatched — there is no
falsely-`complete` empty wave to recover from. If you want to reconcile a
known-completed Story whose return text was lost, re-record it from its
live state by passing `--results '[{"storyId":<n>,"status":"done"}]'`
(verification re-checks the live label before recording `done`).

### 2e. Idle Watchdog

A Story's implementation loop can run for many minutes between
`story.dispatch.start` and the post-merge `story.merged` record. While
`observe` keeps the host LLM polling the Epic, it does **not** flag a
sub-agent that has gone silent (host crash, mid-Story stall, lost
return). The Idle Watchdog closes that gap.

**Cadence.** While any Story is in flight (i.e. `nextAction.kind` is
`observe` or the most recent dispatch's `in-flight` list is non-empty),
re-tick every **30 minutes** with the watchdog flag:

```bash
node .agents/scripts/wave-tick.js --epic <epicId> --check-idle 30
```

> **Why 30, not 10 (Story #3900).** Heartbeats fire only at Story-level
> phase transitions, and `implementing → closing` routinely exceeds 10
> minutes for a healthy Story. A 10-minute threshold therefore tripped the
> watchdog on every long-running Story, whose prescribed remediation —
> re-dispatch — put two agents on one `story-<id>` branch (the worst
> failure mode in the system). The threshold is widened to 30 minutes and
> the staleness test now also consults a deterministic branch-commit
> signal (below), so a Story still gaining commits is never flagged.

The `--check-idle <minutes>` mode scans the per-Epic lifecycle ledger
(`temp/epic-<epicId>/lifecycle.ndjson`) for Stories that carry a
`story.dispatch.start` without a matching `story.dispatch.end` (the
canonical in-flight list — see § 2a's `nextAction['in-flight']`), and
compares each in-flight Story's most recent ledger event (any
`story.*` event, notably the `story.heartbeat` records emitted by
`story-phase.js` at each Story-level phase transition) against the
threshold. **Before flagging a stall, it also checks the last commit on
`story-<id>` via `git log` (Story #3900): a Story whose branch carries a
commit newer than the threshold is making forward progress and is left
in-flight, never stalled — deterministic protection against the
false-positive re-dispatch hazard even when no heartbeat has landed.**
The CLI emits one envelope on stdout and exits non-zero when at least
one in-flight Story has been silent for ≥ the threshold:

```json
{
  "kind": "wave-stall",
  "epicId": <n>,
  "thresholdMinutes": <n>,
  "checkedAt": "<ISO-8601>",
  "stalled": [{ "storyId": <n>, "lastEventAt": "<ISO-8601>", "idleMinutes": <n> }],
  "inFlight": [<storyId>, ...]
}
```

**On a stall.** When the watchdog exits non-zero, post the envelope
verbatim as a `wave-stall` structured comment on the Epic (use
[`post-structured-comment.js`](../../scripts/post-structured-comment.js)
with `--kind wave-stall`), then re-evaluate the affected Stories: if a
child sub-agent has crashed (no `story.dispatch.end`, no recent
heartbeat, no commit on `story-<id>`), re-dispatch the Story per § 2b of
the core incrementing the `--attempt` counter; if the child is alive but
genuinely blocked, flip the Story to `agent::blocked` and proceed per
§ 2d's `observe` branch.

Stop the watchdog cadence once `wave-tick.js` returns `epic-complete` —
there are no in-flight Stories left to monitor.

---

## Phase 6.5 — Post-wave integration gate (Epic #4131, F1/F4)

This phase runs **after** the Phase 2 wave loop reports `epic-complete` and
**before** the Phase 7 finalize emit opens the PR to `main`. Where every gate
before it (`selectAudits`, the cross-epic-leak guard `#3362`, diff-against-base,
the file-assumption gate) is **change-set-scoped** — it narrows its evidence to
the Epic's `changedFiles` — this is the one **deliberately-global** gate: its
evidence spans the **whole product**, not just the change set. The disease it
catches is the surface that each Story shipped correctly in isolation yet that
the assembled product cannot reach: a route nobody can navigate to, or a
persona journey that the integrated waves silently broke. A change-set lens
never sees that, because no single Story's diff contains the orphan.

Skip when `--skip-integration-gate` (log the override; record a manual
intervention per [§ Recording manual interventions](#recording-manual-interventions)).
The gate is otherwise **always evaluated**, but it is a **silent no-op when
unconfigured** (see *No-op when unconfigured* below) so consumers who ship no
nav config and no journey suite are unaffected.

### 6.5a — Whole-product navigability (reuses the Phase 4 lens)

Run the `navigability` lens
([`audit-navigability.md`](../audit-navigability.md), the deliberately-global
lens delivered in this Epic's wave 0) in **whole-route mode** against the
integrated `epic/<epicId>` tip. Unlike its Phase 4 change-set-routed invocation,
here it is driven explicitly over the consumer's **entire** route tree + nav
registry — it is on the global-lens allowlist (`GLOBAL_LENS_ALLOWLIST` in
[`lib/audit-suite/selector.js`](../../scripts/lib/audit-suite/selector.js)) and
exempt from the cross-epic-leak guard `#3362`, so a route orphaned anywhere in
the product is in scope even when no Story in this Epic touched it.

The lens reads the consumer's navigability config (resolved from `.agentrc.json`):

- `delivery.quality.navigability.routeGlobs` — the route-tree SSOT the lens
  enumerates.
- `delivery.quality.navigability.navRegistry` — the nav-registry SSOT the lens
  cross-checks every route against.

A whole-product finding is a **hard failure**: an **orphaned route** (a route
with no nav door for any entitled persona) or a **dead nav href** (a nav door
pointing at a route that no longer exists). On a hard failure the gate **blocks
finalize** and names the orphaned surface (route identifier / nav-door
identifier only — never the route body or persona PII, per
`security-baseline.md`). Do **not** proceed to Phase 7.

### 6.5b — Consumer journey suite

Run the consumer's per-persona journey suite — the integrated, cross-Epic
persona-journey verification — over the `epic/<epicId>` tip:

- `delivery.quality.navigability.journeySuite` — path/command for the journey
  suite. Absent ⇒ this sub-step is skipped (no-op).

A failing journey (a persona cannot complete an end-to-end journey through the
assembled product) is a **hard failure**: block finalize and name the broken
journey. This is the runtime complement to 6.5a's static reachability check —
6.5a proves a door exists; the journey suite proves the door, and everything
behind it, actually works when the waves are integrated.

### 6.5c — `@pending` ≠ green for surface-adding Epics (F4)

The Phase 7 finalize chain runs the acceptance-spec reconciler
([`acceptance-spec-reconciler.js`](../../scripts/acceptance-spec-reconciler.js)),
which classifies every AC ID into `satisfied` (covered by a non-pending
scenario), `pending` (covered **only** by scenarios tagged `@pending`), or
`missing`. For a **surface-adding Epic** — one whose risk verdict carries a
surface-adding signal (a route-adding change set, the `navigability` lens routed
in Phase 4, or a configured `routeGlobs` match) — this phase tightens that
contract: an AC whose coverage is **only `@pending`** is treated as
**unsatisfied**, not green. A surface-adding Epic whose acceptance coverage is
**only `@pending`** therefore **fails the close gate** instead of passing —
shipping a new surface behind a deferred-forever `@pending` scenario is exactly
the late-gate gap this Epic exists to close.

This is **purely additive** and **scoped to surface-adding Epics**:
refactor-only and docs-only Epics (no surface-adding signal) are **unaffected** —
their `@pending` handling is exactly as before, and the existing
`satisfied` / `missing` reconciliation is **not** de-scoped for any Epic.

### No-op when unconfigured

With **no** navigability config (`routeGlobs` / `navRegistry`) and **no**
`journeySuite` present in `.agentrc.json`, this entire phase degrades to a
**silent no-op**: 6.5a and 6.5b skip (nothing to enumerate or run) and 6.5c's
surface-adding signal cannot fire without route globs, so the `@pending`
tightening never engages. The gate adds **zero** behaviour to an unconfigured
consumer — it neither blocks finalize nor changes the existing change-set-scoped
gates. The override flag `--skip-integration-gate` is the explicit operator
escape hatch (consistent with `--skip-epic-audit`) for a configured consumer who
wants to bypass the gate for a specific run.

### Fail safe and loud

Per the Tech Spec's security note, this gate sits on the **critical path** to
finalize. It MUST fail **safe and loud**: a hard failure **blocks** finalize and
**names the cause** (the orphaned route, dead href, broken journey, or
`@pending`-only AC), never silently passes. A genuinely unconfigured consumer is
the **only** silent path, and that path **passes** (it is a no-op, not a block).
On a hard failure, post a friction structured comment naming the surface, flip
the Epic to `agent::blocked`, and park for the operator — do **not** open the PR.

---

## Phase 7 — Finalize (close-tail listener chain)

### 7.0 — Sync Epic branch from `main` (Story #2580)

Before firing the close-tail emit, sync the Epic branch with
`origin/main` so the PR opens with the latest base commits already
integrated. The Epic branch may be behind `main` if other PRs merged
during the wave loop; without this step, the Epic→`main` PR opens
"behind base" and (with branch-protection's `up-to-date branch` rule)
stalls at the merge gate.

```bash
git checkout epic/<epicId>
node .agents/scripts/sync-branch-from-base.js \
  --branch epic/<epicId> --base main
```

Outcomes:

- **`fast-forward` / `merge-commit` / `noop-already-current`** → push
  the resulting tip and continue to Phase 7.1: `git push origin epic/<epicId>`.
- **`conflict`** → resolve in the Epic checkout (`git merge --no-edit
  origin/main`, fix conflicts, `git commit --no-edit`), then re-run the
  sync command. Once it exits 0, continue. Operator-recoverable; not an
  agent loop.
- **`fetch-failed`** → re-check network / `origin` access and re-run.

This is a workflow-level step (operator-driven), not part of the
close-tail listener chain. The sync runs from the main checkout so
the resulting tip lands on `epic/<epicId>` before Phase 7.1 fires
the bus-driven close-tail.

### 7.1 — Close-tail listener chain

`node .agents/scripts/lifecycle-emit.js --epic <epicId> --event epic.close.end`
emits `epic.close.end` onto the lifecycle bus. **Every close-time
responsibility below runs inside the listener chain — the operator
shells nothing manually. The `Finalizer` listener (Story #2894 —
bus-owned finalize) composes three helpers under
`.agents/scripts/lib/orchestration/finalize/` and emits the canonical
chain.** Treat this section as a runtime contract — `/deliver`
just fires the emit and reads the resulting ledger.

1. **Acceptance-table reconciliation — bus-driven.** The
   `AcceptanceReconciler` listener invokes
   [`acceptance-spec-reconciler.js`](../../scripts/acceptance-spec-reconciler.js)
   to diff the AC IDs declared in the Epic body's `## Acceptance Table`
   section against `@ac-*` / `@pending` tags in `tests/features/**`,
   recording each row's verification outcome
   (`satisfied` / `pending` / `missing`) into the table's Disposition
   column via a section-scoped upsert of the Epic body. A
   non-OK reconciliation throws (per
   [`rules/orchestration-error-handling.md`](../../rules/orchestration-error-handling.md)),
   aborting finalize **before** any PR is opened — so the Epic stays
   unfinalized until the AC coverage gap is fixed. The reconciler returns
   `status: 'waived'` without scanning features when the Epic carries
   `acceptance::n-a`, and defends against direct CLI invocation by
   refusing to run when the body has no `## Acceptance Table` section
   and no waiver is set (the
   start gate in Phase 1 would normally catch that first).
2. **PR open / ready — bus-driven (Story #2894; earlyPr split Story
   #4359).** On `acceptance.reconcile.ok` the `Finalizer` listener
   resolves `delivery.ci.earlyPr` via
   [`getCiDelivery`](../../scripts/lib/config/ci.js) (default `true`) and
   branches:
   - **`earlyPr` on (default)** — the Epic PR already exists as a draft
     (Phase 2 opened it at wave 1 with
     [`openOrLocatePr`](../../scripts/lib/orchestration/finalize/open-or-locate-pr.js)
     `{ draft: true }`). Finalize locates it and flips it ready-for-review
     via
     [`markPrReady`](../../scripts/lib/orchestration/finalize/open-or-locate-pr.js)
     rather than creating a PR. `gh pr ready` on an already-ready PR is a
     no-op, so replay is idempotent.
   - **`earlyPr` off** — finalize invokes `openOrLocatePr` with
     `{ epicId, headBranch: 'epic/<id>', baseBranch: 'main' }` (no
     `draft`). The helper probes for an existing open PR on the head branch
     first (idempotent locate path — a re-run of `/deliver` on the same
     branch short-circuits without opening a duplicate) and only opens a
     new PR when none exists.

   In both modes the PR title/body contract (`feat: Epic #<id>` /
   `Closes #<id>`) is identical. The listener then
   emits `pr.created` → `epic.finalize.end` and **stops** (Story
   #3367). It does **not** emit `epic.merge.ready`: that event is
   the sole `AutomergeArmer` trigger, and emitting it from finalize
   would cascade `epic.close.end` synchronously through the arm →
   `MergeWatcher` → `Cleaner` → `BranchCleaner` reap, deleting the
   `epic/<id>` branch before the PR merged and bypassing the
   `AutomergePredicate` disqualification gate. The auto-merge arm is
   driven later from the gated watch path (`pr.created` → `Watcher`
   → `epic.watch.end` → `AutomergePredicate` → `epic.merge.ready` →
   `AutomergeArmer`) re-entered in Phase 8.5. The merge-lockout rule
   in [`check-lifecycle-lint.js`](../../scripts/check-lifecycle-lint.js)
   keeps `gh pr merge --auto --squash --delete-branch` confined to
   `AutomergeArmer` — Phase 7 never shells the merge command.
3. **Hand-off — bus-driven (Story #2894).** After `openOrLocatePr`
   returns, the `Finalizer` chains
   [`postHandoffComment`](../../scripts/lib/orchestration/finalize/post-handoff-comment.js)
   to upsert the canonical `epic-handoff` structured comment naming
   the PR URL. The helper is idempotent — the handoff comment is
   edited in place via `upsertStructuredComment` rather than
   appending a duplicate. There is **no planning-ticket close sweep**
   (Story #4324): the planning artifacts live as sections of the Epic
   body itself, so there are no context tickets to close and nothing
   blocks the Epic's `Closes #<id>` auto-close path.

Branch cleanup is out-of-band (Phase 9 reaps local refs after merge; the
rare "scrap and reset" case for an unmerged Epic is handled manually).

---

## Phase 8 — Watch-and-iterate remediation

### 8.1 Remediation

For each failed required check: fetch the log
(`gh run view <runId> --log-failed`), classify and fix:

- **lint / format** → `npm run lint` + `npx biome check --apply` (or
  `format --write`); commit, push.
- **maintainability / crap baseline drift** → re-run the ratcheted
  script. Refresh the baseline only when drift is justified by the
  diff; otherwise fix at source.
- **test failure** → reproduce with `npm test`, fix source or test.
- **coverage threshold** → add tests (preferred); refresh baseline only
  when the diff demonstrably can't be covered.
- **anything else** → read the log, fix at source.

Push to `epic/<epicId>` and re-run
`node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>`.

### 8.2 When to halt

Three consecutive iterations on the same failure class without
convergence → friction comment, flip to `agent::blocked`, park. Unknown
failure class on first encounter → attempt source-level fix; log
friction if diagnosis takes more than one round.

### 8.3 Hard prohibitions

**Never** `gh pr merge` from Phase 8 (Phase 8.5 is the only merge
site). **Never** force-push to `main`. **Never** push empty commits or
refresh baselines to dodge a red check.

---

## Phase 8.5 — Auto-merge predicate detail

`AutomergePredicate` subscribes to `epic.automerge.start` (Story #3901 —
before that this event had **zero** subscribers and the entire Phase 8.5
gate was a dead wire). It evaluates the structured-signal verdict and
emits `epic.merge.ready` on a clean verdict or `epic.merge.blocked`
otherwise. The CI-freshness gate is skipped on this event because Phase 8
already polled every required check to green — `epic.automerge.start`
carries `prUrl` but no `checkOutcomes`.

The `AutomergeArmer` listener subscribes to the downstream
`epic.merge.ready` outcome and fires `gh pr merge --auto --squash
--delete-branch` only when `clean: true`. `clean: true` requires
**all** of:

- `state.manualInterventions[]` is empty;
- every wave's `status === "complete"`;
- no story envelope carries a `blockerCommentId` or non-`done` status;
- code-review reports `0` 🔴 + `0` 🟠 findings;
- the retro's machine-readable `automerge-verdict` trailer reports
  `cleanSprint: true` (Story #3901 — the predicate reads the parsed JSON
  trailer `retro-run.js` writes into the retro body, **not** an emoji
  string-match on the human-facing "🟢 Clean sprint" prose).

When clean, the listener fires `gh pr merge --squash --delete-branch`.
Otherwise the listener records disqualifying reasons via
`epic.merge.blocked` and exits without merging — operator merges
manually.

### Recording manual interventions

Whenever you step outside the happy path during a delivery, record it
(each entry disqualifies auto-merge):

```bash
node .agents/scripts/epic-deliver-note-intervention.js \
  --epic <epicId> --reason "<one-line description>"
```

Triggers: `AskUserQuestion` mid-run; `git restore`/`reset` against the
tree; child-reported `--no-ff` recovery, stash dance, or out-of-band
merge surgery; child closes via `--skipValidation`; force-pushing or
empty-committing to dodge CI diagnosis.

---

## Phase 9 — Local branch cleanup detail

Phase 9 runs **automatically** inside the lifecycle bus once auto-merge
arms: the `BranchCleaner` listener subscribes to `epic.cleanup.start`
and reaps local refs before `Cleaner` archives the `temp/epic-<id>/`
tree. No operator step is required on the auto-merge path.

What gets reaped (in order, all in-process):

1. The main checkout is switched off `epic/<id>` to `baseBranch` when
   needed (otherwise `git branch -D epic/<id>` is refused).
2. Every `story-<id>` listed in the `epic-run-state` checkpoint, plus
   `epic/<id>`. Attached worktrees are removed with the standard
   `git worktree remove` → `--force` → filesystem-rm fallback (the
   last step covers Windows file-locks).
3. `git remote prune <remote>` drops stale `<remote>/...` tracking
   refs left behind by `gh pr merge --delete-branch`.
4. The `wt-branch` scratch ref left by `story-close.js`'s internal
   merge worktree is deleted when no worktree still points at it.

Per-branch failures aggregate into the listener's classification log
(`reaped` / `failed` / `no-state` / `skipped-duplicate`) and are
visible in `temp/epic-<id>/lifecycle.ndjson`. They do not block the
rest of cleanup.

For out-of-band cleanup re-entry (resume after a crash, or operator
override), fire `epic.merge.armed` via the lifecycle-emit helper:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.merge.armed --pr-url <prUrl>
```

If Phase 8.5 fell back to the operator-merges-button path (`gh pr
merge --auto` was declined), the `epic.merge.armed` event never fires
inside this run and Phase 9 will not run automatically. **Do not** hand-reap
the refs with a raw `git branch -D` sequence — drive the same
`BranchCleaner`-backed reap the auto-merge path uses by firing
`epic.merge.armed` after the operator merges the PR:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.merge.armed --pr-url <prUrl>
```

That single emit reaps `epic/<epicId>` and every `story-<id>` ref from the
checkpoint, prunes stale tracking refs, and fast-forwards local `main` to
`origin/main` — the whole Phase 9 reap, not a partial hand-roll. A plain
`git-cleanup.js` sweep alone will **not** catch the `story-<id>` refs here,
because the epic PR squash-merge breaks the `git branch --merged main` signal
and the stories never had their own PRs; the lifecycle-emit surface above is
the correct driver.

Re-running `/deliver <epicId>` reaches the same outcome without the manual
emit: the idempotent-resume auto-arm
(`detectMergedUncleanedEpic` → `armCleanupIfMerged` in
[`epic-cleanup.js`](../../scripts/lib/orchestration/epic-cleanup.js)) detects
the merged-but-uncleaned Epic and fires `epic.merge.armed` for you.
