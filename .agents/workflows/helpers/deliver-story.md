---
description:
  Execute one Story end-to-end: story-<id> from main, implemented in a worktree
  (optional ## Slicing checkpoints), derived-level ceremony, PR against main.
mandatoryReads: [deliver-digest.md]
---

# /deliver-story #[Story ID]

> **Lean spine.** Happy path + gate list; edge-case, recovery and reference
> detail lives in [`deliver-story-reference.md`](deliver-story-reference.md)
> ("reference" below). Invoked by [`/mandrel-deliver`](../mandrel-deliver.md).
> **Read [`deliver-digest.md`](deliver-digest.md) once, first** — the one
> bundled read every delivery needs. Steps cite it as "digest § N".

## Overview

The **one** delivery engine in v2:

```text
single-story-init.js → implement + commits → derived-level ceremony → push
  ──hand-off──▶ single-story-close.js (gates, PR → main, agent::closing)
  → CI watch + merge → single-story-confirm-merge.js (agent::done)
```

An `Epic: #N` reference marks a v1 ticket — **stop** and re-plan. Engine
traits and prerequisites: reference § Engine invariants.

## Who owns which step

Steps 0–2 belong to whoever implements. **Step 3 belongs to the orchestrator
that dispatched the work**, never to a spawned worker.

- **Inline dispatch** (a one-Story run — digest § 1): one session is both
  roles and walks Steps 0→7, no hand-off.
- **Sub-agent dispatch**: the `story-worker` stops at Step 2.5 with the branch
  pushed and returns a hand-off; the dispatching `/mandrel-deliver` session runs Step 3
  **in its own turn** and **serializes the tail — one close at a time across
  the run**, even though implementation ran in parallel (reference § Step 3).

**A worker returning no terminal envelope is expected, not a failure** — only
Step 3 mints one. Never re-dispatch the Story on it; resume per § Recovery
(reference § Idempotence).

## Step 0 — Initialize (`single-story-init.js`)

From the **main checkout**, **synchronously** with the maximum Bash timeout —
the per-tree install can take minutes; never `run_in_background`:

```bash
node .agents/scripts/single-story-init.js --story <storyId>
```

Every script below documents its own flags — run it with `--help`.
It validates `type::story`, takes the Story lease, seeds `story-<id>` from
`baseBranch`, materializes a worktree and flips `agent::executing` (reference
§ Step 0). Capture `workCwd` from the envelope.

**Land or block.** `remoteVerified: false` → flip `agent::blocked` quoting
`remoteProbe.detail` and stop. Implementing outside the worktree/branch/PR path,
or committing to local `main`, is forbidden.

**Step 0.5 — `cd "<workCwd>"`**, and prefix every path-based
Edit/Write/Read with that absolute worktree root — the `cd` alone does not
scope those tools (reference § Worktree scope).

## Step 1 — Implementation

One branch, one PR to `main`, commits against the inline `acceptance[]` /
`verify[]` and `## Spec`:

1. Read the Story body; its acceptance criteria are the contract. Docs are
   digest-first; read a caller-provided `checklistPath` first, and walk any
   `## Slicing` rows as **intra-session checkpoints** (reference § Step 1).
2. Implement and commit on the Story branch, iterating with quick advisory
   gates (`typecheck`, `lint`, scoped tests) — the full chain runs in Step 3,
   and the **one** creditable full-suite run at Step 2.5.

### Step 1a — Bounded acceptance self-eval loop (**required**)

Run the loop and score it with `acceptance-eval.js` — **digest § 4** carries
the invocation and the proceed / redraft / block contract; per-round mechanics
live in [`acceptance-self-eval.md`](acceptance-self-eval.md). **`proceed`** →
Step 2. **`block`** → **do not close**: post a `friction` comment and flip
`agent::blocked` (reference § Step 1a).

## Step 2 — Ceremony (profile + derived level)

Ceremony is `delivery.routing.ceremonyProfile` × the **derived change level**,
never a planner-authored verdict. **Digest § 3** is the incantation (change set
once, derive the level, resolve critics with `ceremony-routing.js`); edge cases
are reference § Step 2. Hard gates always run in Step 3 — the derived level
never disables them; do **not** pre-run the chain here — Step 2.5's credited
suite run is the sole exception.

### Step 2.5 — Push, then the creditable full-suite run, then hand off

**Push first.** After the self-eval loop's last fix commit, push
`story-<storyId>` to `origin`, confirming the remote ref moved: the capture
below is backgrounded, so *its* completion ends the turn.

Then run the full suite **once**, after the push, in the shape close credits
(**digest § 5**): the credit is keyed on the tree, not on push state, so only
a *later* commit invalidates it; a bare `npm test` deposits none. Red →
fix, commit, push, re-capture.

Then (sub-agent dispatch only) return the hand-off — Story id, `workCwd`,
branch, pushed head SHA, self-eval verdict, `verify[]` evidence — and stop.
Do not open the PR or compose a terminal envelope. An inline run captures
before Step 3.

## Step 3 — Close and land (`single-story-close.js`)

**The orchestrator's step** (§ Who owns which step), run in the **foreground**,
serialized against sibling Stories:

```bash
node <main-repo>/.agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
```

**The whole delivery tail** — gates, PR, merge wait, `agent::done` flip,
post-land tail in one process. Never background it, never delegate it to a
child, and never end your turn while it is still running: "close is running"
is not a return value. Branch on the envelope's `status` per **digest § 6**
(`landed` → Step 7; `pending` → run `nextCommand`; `blocked`/`checks-failed`
→ Step 4; `failed` → diagnose, re-run). Gate output is captured.

Internals, merge-wait budgets, the slow-CI **async** confirm mode, the
`autoMerge` policy and every close flag: reference § Step 3.

## Step 7 — Return contract {#return-contract}

Relay the validated envelope close emits between its
`--- STORY DELIVER TERMINAL ---` markers — never free-form prose, never a
hand-composed object. Statuses, exits and fields: **digest § 6** (SSOT: the
shipped [schema](../../schemas/story-deliver-terminal.schema.json)).
`pending` is the only sanctioned no-merge ending.

## Steps 4–6 — Recovery (**recovery-only**) {#recover}

A `landed` envelope means everything ran — go to Step 7. Enter recovery **only**
when the envelope routes you there; procedures are reference §§ Step 4–6.
Two rules the spine keeps: a red **disarms auto-merge**,
so only a green on a NEW head SHA re-arms it — a re-run is refused; fix at source
and push ([`rules/ci-remediation.md`](../../rules/ci-remediation.md)). And a
`tail.*: false` degrades the report, never the land.

**Watch exit codes** — `pr-watch-with-update.js` exits 0 green, 1 on a genuine
red, 2 slow-but-not-red (still-running, unresolved, or `notYetStarted`). Never
route a 2 onto the red path: nothing is broken and no digest exists to read.
Which slow condition, and what to do: reference § Step 4.

**Lost envelope first: read it off disk.** Close persists each to
`temp/orchestration/story-deliver-terminal-<storyId>.json`; branch on it per
digest § 6. Otherwise do not guess — probe **read-only** with
`node .agents/scripts/deliver-recover.js --story <storyId>`; it prints the
**one** next command with its evidence, never a menu. A live close answers
`close-in-flight`: wait, never re-init underneath it.

## Idempotence & constraints

Every script no-ops safely on re-run (reference § Idempotence). **Never** push
the Story branch to `main` — the PR is the only merge surface. Report state,
not process. Drive `agent::*` through
`update-ticket-state.js --ticket <id> --state <state>`.

## See also

[`deliver-digest.md`](deliver-digest.md), [`/mandrel-deliver`](../mandrel-deliver.md),
[`deliver-story-reference.md`](deliver-story-reference.md).
