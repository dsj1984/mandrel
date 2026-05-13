---
name: Orphan .worktrees break root biome lint
description: Nested biome.json in partial-reap worktree residue silently fails `npm run lint` at sprint-close time
type: feedback
originSessionId: fe1e8f7f-8acc-4bde-aba3-29780de36dce
---

# Orphan .worktrees break root biome lint

When `story-close` returns `branchDeleted: false` on Windows, the `.worktrees/story-<id>/` directory is left on disk with its own `biome.json`. Biome v2 treats that nested copy as a "nested root configuration" error against the repo root config and **fails the entire `npm run lint`** — with a message about nested root configs, *not* a code lint error.

**Why:** Originally hit on `/sprint-close 349` (2026-04-22, pre-Epic #902 architecture). Phase 3.3 pre-merge validation couldn't pass until the orphan worktrees were manually cleaned up (`rm -rf .worktrees/story-*` + `git worktree prune`). The worktree-reap fix on `epic/553` (`ff34fa9`) reduces the frequency, but any partial-reap residue still has the same biome-blast-radius.

**How to apply:** If `npm run lint` fails with "Found a nested root configuration" during an `/epic-close` or `/story-execute` run, check `git worktree list` for `prunable` entries and/or `ls .worktrees/` for leftover dirs **before** debugging the lint output. Offer the operator `rm -rf .worktrees/story-<id>` + `git worktree prune` as the first-line fix. Long-term, add `.worktrees/**` to the root `biome.json` `files.ignore` list.
