---
name: Worktrees need untracked bootstrap files propagated
description: Per-story worktrees don't inherit gitignored files like .env or .mcp.json — surface this in any worktree-related work
type: feedback
originSessionId: e22534c4-b1f5-4bfa-b767-53b9d2eddfb7
---

# Worktrees need untracked bootstrap files propagated

`git worktree add` respects `.gitignore`, so files like `.env` and `.mcp.json` are NOT propagated into per-story worktrees created by `story-init`. Tests and tools that depend on them fail silently (e.g. Clerk/DATABASE_URL secrets missing → RBAC tests hit seed/clerkId collisions against the wrong database).

**Why:** the user hit this exact friction — the failure mode is invisible (tests "just fail"), the root cause (missing env in a fresh worktree) is non-obvious, and the manual workaround (`cp ../../.env .env`) is easy to forget.

**How to apply:**

- The bootstrap copy is handled by `.agents/scripts/lib/worktree/bootstrapper.js` (driven from `orchestration.worktreeIsolation.bootstrapFiles`, default `['.env', '.mcp.json']`). Verify the config is still wired when touching worktree bootstrap.
- When debugging a test that passes on main but fails in a worktree, consider env/config propagation before chasing logic bugs.
- When adding a new untracked config file that tests depend on, add it to `bootstrapFiles` (or tell the user to do so in their `.agentrc.json`).
