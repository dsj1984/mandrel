---
name: git-workflow-and-versioning
description:
  Structures git workflow practices. Use when making any code change. Use when
  committing, branching, resolving conflicts, or when you need to organize work
  across multiple parallel streams.
---

# Git Workflow and Versioning

## Policy Capsule

- The always-on git core — canonical branch shape (`story-<storyId>` seeded from `main`), the Conventional-Commit subject contract and its allowed type set, the `refs #<id>` reference, and the push / hygiene MUSTs — lives in [`.agents/rules/git-conventions.md`](../../../rules/git-conventions.md); that rule is the SSOT and wins on conflict. This skill adds **only** what the rule does not own.
- Commit early and often: each successful increment is its own save point. Never accumulate large uncommitted changes.
- Keep commits atomic — one logical thing per commit. Never mix formatting changes with behavior changes, or refactors with features.
- Treat commits as revertable save points: when a change breaks something, `git reset --hard HEAD` returns you to the last known-good increment, so you never lose more than one step of work.
- Provide a structured Change Summary on completion with `CHANGES MADE`, `THINGS I DIDN'T TOUCH (intentionally)`, and `POTENTIAL CONCERNS` — the "didn't touch" section is mandatory to demonstrate scope discipline.
- Use git worktrees (not branch-switching) for parallel agent work so concurrent streams stay isolated until explicitly merged. The runtime already materializes one worktree per Story under `.worktrees/story-<id>/`.

## What the rule owns (do not restate)

Branch naming, the allowed commit types, `refs #`, squash-merge delivery, push
validation, and local-checkout hygiene are the always-on rule's job. Read
[`git-conventions.md`](../../../rules/git-conventions.md) for those; do not
carry a divergent copy here. In particular, the framework's only sanctioned
delivery shape is `story-<id>` → PR → squash-merge to `main`: there is no
short-lived personal branch flow to prescribe, and delivery is squash-merge, so
this skill offers no contrary branching or history-preservation guidance.

## The Save-Point Pattern

Work in the loop `implement slice → test → verify → commit → next slice`. Each
green increment is a commit; if the next change fails, revert to the last
commit and investigate rather than debugging forward from a broken state. This
means you never lose more than one increment of work.

## Change Summaries

After any modification, provide a structured summary — it makes review easier,
documents scope discipline, and surfaces unintended changes:

```text
CHANGES MADE:
- src/routes/tasks.ts: Added validation middleware to POST endpoint

THINGS I DIDN'T TOUCH (intentionally):
- src/routes/auth.ts: Has a similar validation gap but out of scope

POTENTIAL CONCERNS:
- The new schema rejects extra fields — confirm that is desired.
```

The "DIDN'T TOUCH" section is the important one: it shows you exercised scope
discipline and did not go on an unsolicited renovation.
