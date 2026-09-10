---
description: >-
  Attended consolidation pass over this project's agent memory pool — merge
  duplicates, verify claims against the current tree, prune with operator
  confirmation, rewrite the index, and stamp the pool with the date and entry
  count the /mandrel-plan advisory measures its next nudge against.
---

# /memory-consolidate [--dry-run]

Agent memory drifts as the codebase moves: a workaround gets fixed, a budget
changes, two sessions save the same lesson twice. This is the sweep that
corrects it — and the **only** sanctioned writer of the memory pool outside a
session's own point-of-write corrections.

**Attended by contract.** Mandrel ships the trigger, the grounding and the
receipt; it never mutates the operator's personal memory store unsupervised.
Nothing here runs on a schedule, and no step deletes a file before Gate #2.

## Step 0 — Resolve the pool

`MANDREL_MEMORY_DIR` wins outright; otherwise the pool is
`~/.claude/projects/<cwd-slug>/memory/`, where `<cwd-slug>` is the absolute
working directory with every `/` and `.` replaced by `-`.

Report the resolved path and the entry count. **No pool → say so in one line
and stop** — an absent substrate is a clean no-op, never an error, and never a
reason to create one.

Each project (and each worktree) has its own pool: consolidate the pool of the
checkout you are in, and never reach across into another.

## Step 1 — Read the pool

Read `MEMORY.md` and every `*.md` entry. Group them by subject so duplicates
and supersessions surface together. Do not judge an entry from its index line —
the index is a pointer, the file is the claim.

## Step 2 — Classify each entry

Verify before you keep. Run `ls` / `grep` against the **current tree** for the
paths, flags, budgets and gate names an entry cites; re-measure a number rather
than trusting it (`wc -c` a file whose byte budget is quoted).

| Verdict | Means | Action |
| --- | --- | --- |
| `fresh` | Claims re-confirmed against the tree | Leave byte-identical |
| `correct` | Core lesson holds, a detail has moved | Rewrite the detail in place, keep the entry |
| `duplicate` | Same lesson as another entry | Merge into the richer one, propose the thinner for pruning |
| `superseded` | The thing it warns about is fixed or retired | Strike the claim, keep the correction visible |
| `dead` | Subject no longer exists at all | Propose for pruning |

**A closed issue is the subject of a retrospective, never evidence of
staleness.** These pools are largely delivery write-ups — "delivered this
Story", "fixed by that PR". The referenced issue being closed is what the
memory is *about*: the normal, healthy shape. A retired predecessor of this
workflow marked exactly that pattern stale, which is why it no longer exists.
Use `github.owner` / `github.repo` from `.agentrc.json` when an issue
genuinely needs probing, and treat an unreachable probe as unknown — never
as dead.

Prefer `correct` over `dead`. A rewritten entry keeps hard-won context; a
deleted one costs a future session the same mistake.

## Step 3 — Gate #1: present the plan

Write the full proposal to `temp/memory/consolidation-<date>.md` — per entry:
verdict, evidence, and the exact edit or merge proposed. Summarize inline:
counts per verdict and the specific prune candidates by name.

**STOP.** Do not edit until the operator responds.

## Step 4 — Apply the edits

On confirmation, apply the `correct`, `duplicate` and `superseded` rewrites.
Preserve each entry's frontmatter contract (`name`, `description`, `metadata`)
and keep `[[wiki-link]]` references resolvable — a merge that orphans a link
has moved the problem, not fixed it.

## Step 5 — Gate #2: confirm every deletion

**Deletion is never implied by Gate #1.** Name each file proposed for pruning
with its one-line reason, and offer **mark-vs-delete**: marking the claim
superseded in place is the default and always available. Wait for an explicit
yes; delete only what the operator names. Silence is not consent.

## Step 6 — Rewrite the index and stamp

Rewrite `MEMORY.md` so it holds exactly one pointer line per surviving entry —
title, link, hook. It is loaded into context every session, so it carries
pointers only, never memory content.

Then write the receipt to `.consolidation-stamp.json` in the pool root:

```json
{ "lastConsolidatedAt": "<ISO-8601 timestamp>", "entryCount": 42 }
```

`entryCount` is the surviving non-index `*.md` count **after** the rewrite —
count the directory, never the plan. It is the baseline the next run measures
growth against, so a wrong number silently mis-arms the nudge.

The `/mandrel-plan` Phase 0 advisory re-arms on exactly three conditions: the
stamp aging past `planning.memoryPool.staleAfterDays` (30),
`planning.memoryPool.growthDelta` (25) entries written since that count, or
`MEMORY.md` exceeding `planning.memoryPool.indexByteCeiling` (24576) bytes.
Pool size alone never triggers it — a pass that keeps every entry still quiets
the first two arms. A stamp with no `entryCount` leaves growth unmeasured, and
only the age and index arms can speak until the next pass writes one; a stamp
dated in the future reads as no stamp at all.

Write it **only** after Gate #2 — the stamp asserts an operator reviewed the
pass, so writing it early makes it a lie.

Close with counts: entries read, corrected, merged, pruned, the new total, and
**the rewritten `MEMORY.md`'s size in bytes beside that count** — the index is
truncated at the byte ceiling, so a pass that pruned entries but left the
index over the cap has not fixed the loss, and the number is the only way the
operator can see that. Then the forecast the operator would otherwise derive
by hand: when the advisory next fires, and which arm reaches it first.

## Constraints

- `--dry-run` runs Steps 0–3 and stops: the report is written, nothing mutates.
- Never delete an entry the operator did not name. Never write the stamp on a
  dry run or a declined gate.
- Never invent memories here — this pass corrects and prunes what sessions
  wrote; new memories come from the sessions that learned them.

## See also

[`/mandrel-plan`](mandrel-plan.md) (surfaces the advisory at its Gate #1),
[`/mandrel-deliver`](mandrel-deliver.md) (point-of-write corrections as work lands).
