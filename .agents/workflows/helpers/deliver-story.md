---
description:
  Execute one Story end-to-end. Creates story-<id> from main, implements in a
  worktree (optional ## Slicing checkpoints), runs derived-level ceremony,
  opens a PR against main, and lands.
---

# /deliver-story #[Story ID]

> **Lean spine.** Happy path + gate list; edge-case, recovery, and
> reference detail lives in
> [`deliver-story-reference.md`](deliver-story-reference.md) ("reference"
> below); consult on demand. Invoked by [`/deliver`](../deliver.md).
>
> **Read [`deliver-digest.md`](deliver-digest.md) once, first.** It is the
> one bundled read of what every delivery needs — dispatch decision, engine
> invariants, the change-set/ceremony incantation, the acceptance-eval gate,
> and the terminal-envelope contract — replacing the per-session re-reads of
> the helper set and `story-deliver-terminal.schema.json` (Story #4736). The
> steps below cite it as "digest § N" rather than restating it.

## Overview

The **one** delivery engine in v2 — every Story (a lite-**shaped** Story
runs inline with inline critics, #4722; engine, gates, envelope
byte-identical):

```text
single-story-init.js → implement + commits → derived-level ceremony
  → single-story-close.js (gates, push, PR → main, agent::closing)
  → CI watch + merge → single-story-confirm-merge.js (agent::done)
```

An `Epic: #N` reference marks a v1 ticket — **stop** and re-plan.
There is no `epic/<id>` branch, no `--no-ff` wave merge (trait table:
reference § Engine invariants). Prerequisites: a `type::story` issue,
clean `gh auth status`, and `project.baseBranch` on local and `origin`.

## Step 0 — Initialize (`single-story-init.js`)

From the **main checkout**, **synchronously** with the maximum Bash
timeout — the per-tree install can take minutes; never `run_in_background`:

```bash
node .agents/scripts/single-story-init.js --story <storyId>
```

Flags: `--dry-run` (no mutations; skips lease + sweep), `--steal` (transfer
a foreign lease). It validates `type::story`, **acquires the Story lease**
(fails closed on a foreign assignee), fetches `origin`, seeds `story-<id>`
from `baseBranch` (idempotent reuse), materializes a worktree, runs a
guarded merged-`story-*` sweep, and flips `agent::executing` (reference
§ Step 0). Capture `workCwd` from the result envelope.

**Land or block (issue #4483).** `remoteVerified: false` → flip
`agent::blocked` quoting `remoteProbe.detail` and stop. Implementing outside
the worktree/branch/PR path or committing to local `main` is forbidden —
close's push is the only sanctioned landing.

**Step 0.5 — `cd "<workCwd>"`**, and prefix every path-based
Edit/Write/Read with that absolute root — the `cd` alone does not scope
those tools (reference § Worktree scope is not just the Bash cwd).

## Step 1 — Implementation

One branch, one PR to `main`, commits against the inline `acceptance[]` /
`verify[]` (and `## Spec`):

1. Read the Story body; the acceptance criteria are the contract. Docs are
   digest-first; read a caller-provided `checklistPath` before writing
   (reference § Step 1).
2. Implement. Walk any `## Slicing` rows as **intra-session checkpoints**
   (commit + flip each row) — never sibling tickets.
3. Commit on the Story branch; iterate with quick advisory gates
   (`typecheck`, `lint`, scoped tests) — the full close chain runs in
   Step 3.
4. Run the **full test command** once in the worktree (`npm test`) **before
   Step 1a** — repo-invariant guards outside the Story's scoped greps are
   the failure class that bounces deliveries. Fix and commit first.
5. Run the self-eval loop (Step 1a).

### Step 1a — Bounded acceptance self-eval loop (**required**)

Run the loop and score it with `acceptance-eval.js` — **digest § 4** carries
the invocation and the proceed / redraft / block contract; per-round critic
mechanics live in the single-homed include
[`acceptance-self-eval.md`](acceptance-self-eval.md).

**`proceed`** → Step 2 then Step 3. **`block`** → **do not close**: post a
`friction` comment and flip `agent::blocked` — commands and the
`evidence-gate.js --standalone` evidence-share mechanic: reference
§ Step 1a.

## Step 2 — Ceremony (profile + derived level)

Ceremony is `delivery.routing.ceremonyProfile` × the **derived change
level** — never a planner-authored verdict (Story #4542). **Digest § 3** is
the incantation: compute the change set once (Story #4593), derive the level,
resolve fresh-vs-inline critics with `ceremony-routing.js`; a lite Story runs
inline regardless (routing edge cases: reference § Step 2). Hard gates always
run in Step 3 — the derived level never disables them; do **not** pre-run the
close chain here.

## Step 3 — Close and land (`single-story-close.js`)

```bash
node <main-repo>/.agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
```

**The whole delivery tail** — gates, PR, merge wait, `agent::done` flip,
post-land tail in one process. Run it and **branch on the terminal envelope's
`status`** per the table in **digest § 5** (`landed` → Step 7; `pending` → run
`nextCommand`; `blocked`/`checks-failed` → Step 4; `failed` → diagnose and
re-run). Gate output is captured to
`temp/orchestration/close-gates-<storyId>.log` — a clean run prints a digest
line, a red gate replays its tail inline (Story #4736).

Internals (gate order, base-sync, auto-merge arming), the merge-wait
budgets, the slow-CI **async** confirm mode (Story #4698 — launch the
`pending` envelope's `nextCommand` as **background** Bash, never a
foreground poll), the `autoMerge` policy, and every close flag: reference
§ Step 3 — Merge wait, async mode, and flags.

## Steps 4–6 — Recovery router (**recovery-only**)

A `landed` envelope means everything ran — go straight to Step 7. Enter a
recovery path **only** when the envelope routes you there:

- **`blocked` / `checks-failed`** → fix, push a new commit (auto-merge stays
  armed), resume via `nextCommand`; triage per
  [`rules/ci-remediation.md`](../../rules/ci-remediation.md). The watch is
  internally blocking — never end a turn with prose and an unconfirmed
  merge (Story #1553). Reference § Step 4.
- **`pending`** → run `nextCommand` (`single-story-confirm-merge.js`) until
  resolved. Reference § Step 5.
- **`tail.statusResync: false`** → reference § Step 5.5;
  **`tail.refCleanup` / `tail.baseFastForward: false`** → reference § Step 6.

## Step 7 — Return contract (**required as a sub-agent**) {#return-contract}

End your turn by relaying the validated envelope close emits between its
`--- STORY DELIVER TERMINAL ---` markers — never free-form prose, never a
hand-composed object. Statuses, exits, and required fields: **digest § 5**
(whose SSOT is the shipped
[schema](../../schemas/story-deliver-terminal.schema.json), Story #4543).
`pending` is the only sanctioned no-merge ending, returned only when your own
budget is exhausted (Story #1553). Reference § Step 7.

## Recovering a stranded Story {#recover}

Unclear state (killed run, lost envelope, a re-run refusal — incl.
merged-but-label-stale)? Do not guess — probe **read-only** with
`node .agents/scripts/deliver-recover.js --story <storyId>`; it prints the
**one** next command with its evidence, never a menu.

## Idempotence & constraints

Every script no-ops safely on re-run (init re-prints `workCwd`; close and
confirm-merge short-circuit on a closed / `agent::done` Story; the PR probe
reuses an open PR).

- **Never** push the Story branch directly to `main` — the PR is the only
  merge surface.
- **Always** prefix path-based tools with the absolute `workCwd` root
  (Step 0.5); close's wrong-tree guard (Story #3364) is a backstop.
- **Report state, not process** — mirror the close envelope's fields; no
  step narration.
- Drive every `agent::*` transition through
  `update-ticket-state.js --ticket <id> --state <state>`.

## See also

- [`deliver-digest.md`](deliver-digest.md) — the one bundled framework read.
- [`/deliver`](../deliver.md) — unified entry point.
- [`deliver-story-reference.md`](deliver-story-reference.md) — all on-demand
  detail.
