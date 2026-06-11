---
description:
  Walk the operator through a code change until they genuinely understand it.
  Targets a PR, a branch, or the working-tree diff, then drives the
  `core/knowledge-transfer` skill (restate-first, why-ladder, mastery gates,
  persistent checklist) with an operator-controlled stop at every checkpoint.
---

# /explain [PR# | branch | --staged | --diff <ref>]

## Overview

`/explain` is the **operator-facing comprehension command**. Use it when code
landed (or is about to) and you want to be sure you actually understand it —
the problem it solves, why it was solved this way, the design decisions, the
edge cases, and the blast radius. It is the after-the-fact counterpart to
[`/plan`](helpers/plan-epic.md) Phase 11 (which walks the operator through a
*plan* before delivery); both drive the same engine.

```text
/explain 1234            → walk through merged/open PR #1234
/explain story-104       → walk through the diff of branch story-104 vs main
/explain --staged        → walk through the currently staged changes
/explain --diff HEAD~3   → walk through the diff from HEAD~3 to working tree
/explain                 → no subject given: ask what to explain, then proceed
```

This command **delegates the method** to the
[`core/knowledge-transfer`](../skills/core/knowledge-transfer/SKILL.md) skill.
This file owns only **subject resolution** (which diff) and the handoff into
that skill. Read the skill before running — it defines the loop, the
why-ladder, the depth levels, the quizzing rules, and the operator-stop
contract.

## When to use `/explain`

| Scenario | Command |
| --- | --- |
| Understand a change that already merged | `/explain <PR#>` |
| Understand a branch before merging it | `/explain <branch>` |
| Understand what you are about to commit | `/explain --staged` |
| Understand a freshly planned Epic backlog | `/plan` Phase 11 (automatic) |

## Step 1 — Resolve the subject

Determine the change to explain from the argument:

- **PR number** (`/explain 1234`) — read the PR metadata and diff:

  ```bash
  gh pr view 1234 --json title,body,state,headRefName,baseRefName
  gh pr diff 1234
  ```

- **Branch** (`/explain story-104`) — diff the branch against the base
  branch (`project.baseBranch`, default `main`):

  ```bash
  git diff main...story-104
  ```

- **`--staged`** — the staged working-tree changes:

  ```bash
  git diff --staged
  ```

- **`--diff <ref>`** — an explicit diff range:

  ```bash
  git diff <ref>
  ```

- **No argument** — ask the operator which PR, branch, or range they want
  walked through, then resolve as above. Do not guess.

Read the resolved diff **and** the surrounding code it touches before
explaining anything — ground every explanation in the real artifact, never
the title alone.

## Step 2 — Drive the comprehension loop

Activate [`core/knowledge-transfer`](../skills/core/knowledge-transfer/SKILL.md)
with the resolved change as the subject. Follow the skill exactly:

1. **Frame & gather** — state the change in one sentence; write the checklist
   to `temp/comprehension-<subject>.md`.
2. **Restate-first** — ask the operator what they already understand before
   explaining.
3. **Fill gaps one layer at a time** along the why-ladder
   (problem → why → branches → solution → why this solution → design
   decisions → edge cases → broader impact), confirming mastery at each layer
   and offering the stop exit before advancing.
4. **Close** — summarize coverage, note any unchecked items, leave the
   checklist artifact in place.

Honor depth requests (ELI5 / intern / peer) and quiz via the host's
structured-question mechanism when it sharpens understanding.

## Constraints

- **Operator-invoked only.** Never auto-fire `/explain`, and never run it
  inside a non-interactive delivery sub-agent — there is no operator to
  teach.
- **Operator controls the exit.** Stop the moment the operator says they are
  satisfied; this command never blocks or gates anything.
- **Read-only.** `/explain` teaches; it does not modify code, tickets, or
  branches. The only file it writes is the `temp/` checklist artifact.

## See also

- [`core/knowledge-transfer`](../skills/core/knowledge-transfer/SKILL.md) —
  the comprehension engine this command drives.
- [`/plan`](helpers/plan-epic.md) — Phase 11 runs the same engine over a plan
  before delivery.
- `/code-review` (Claude Code built-in) — correctness review of a diff. A
  different concern: `/explain` builds *operator* understanding, not a defect
  list.
