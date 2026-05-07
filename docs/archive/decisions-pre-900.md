# Decisions Archive — Pre-Epic-#900 ADRs (001 / 002 / 003)

These three ADRs predate the Epic-#900 sprint→epic terminology rework and the
four-skill execution split. They are preserved verbatim for historical
context. The active decision log is in [`../decisions.md`](../decisions.md).

---

## ADR 001: Autonomous Protocol Refinement Loop

**Status:** Reverted (Moved to manual process)  
**Date:** 2026-04-09  
**Epic:** #74

### Context
Frequent friction during agent execution (e.g., tool misuse, prompt ambiguity) requires manual protocol updates. This creates a bottleneck and prevents the system from scaling its efficiency.

### Decision
We will implement an autonomous, closed-loop system that:
1.  Ingests friction logs from completed tasks.
2.  Uses an LLM-based agent to identify patterns and propose protocol updates.
3.  Automatically creates PRs for these updates.
4.  Tracks the performance impact post-merge.

### Consequences
*   **Positive:** Reduced manual maintenance, faster protocol maturation, data-driven improvement.
*   **Negative:** Increased GitHub API usage, potential for low-quality automated PRs if prompts are weak.
*   **Mitigation:** Human-in-the-loop (HITL) requirement for merging refinement PRs.

---

## ADR 002: Real-time Sprint Health Monitoring

**Status:** Accepted  
**Date:** 2026-04-09  
**Epic:** #74

### Context
Operators lack visibility into "stalled" sprints or widespread tool failures during parallel task execution.

### Decision
Implement a single-issue "Sprint Health" dashboard in GitHub that is updated via `health-monitor.js` after every major task state transition.

### Consequences
*   **Positive:** Immediate visibility into systemic failures.
*   **Negative:** High edit frequency on a single issue might trigger GitHub rate limits.
*   **Mitigation:** Debounced updates and batching metrics.

---

## ADR 003: Worktree-per-Story Isolation for Parallel Sprint Execution

**Status:** Accepted
**Date:** 2026-04-15
**Epic:** #229
**Version shipped:** 5.7.0

### Context

Parallel sprint execution prior to v5.7.0 shared one working tree across all
story agents. On 2026-04-14, five concurrent agents under `epic/267` raced on
branch checkouts and swept a WIP file from one story into another story's
commit. v5.5.1 shipped three symptomatic fixes (tri-state Epic branch
bootstrap, pre-commit `assert-branch.js`, focus-area wave serialization). These
prevented the specific failure modes observed but did not address the root
cause: multiple agents mutating one working tree at the same time.

### Decision

Each dispatched story runs in its own `git worktree` at
`.worktrees/story-<id>/`. A single `WorktreeManager` owns the worktree
lifecycle (`ensure` / `reap` / `list` / `isSafeToRemove` / `gc`). The
dispatcher constructs a manager when
`orchestration.worktreeIsolation.enabled` is `true` and threads the worktree
path as `cwd` through the execution adapter. Single-tree mode remains a
first-class fallback via `enabled: false`.

Supporting decisions:

- **Bounded `git worktree remove --force` only after safety checks.** Dirty
  unmerged trees still refuse to delete, but a clean or already-merged
  removable worktree may use a single force retry after Windows lock/cwd
  retry exhausts.
- **`core.longpaths=true`** set per worktree on win32; a pre-flight
  path-length warning is posted on the Epic issue when the estimated deepest
  path exceeds the configured threshold.
- **`gitFetchWithRetry`** retries only on known packed-refs lock-contention
  signatures; unrelated fetch failures surface immediately. No global mutex
  — that would erase the parallelism the model is designed to enable.
- **`node_modules` strategy is explicit**: `per-worktree` (default, correct
  everywhere), `symlink` (requires `primeFromPath`; Windows opt-in via
  `allowSymlinkOnWindows`), `pnpm-store` (agent runs `pnpm install` against
  the shared store).

### Consequences

*   **Positive:**
    *   Main-checkout reflog stays quiet during parallel sprints; agent
        activity is confined to per-worktree reflogs.
    *   Defense-in-depth preserved: `assert-branch.js` and focus-area
        serialization remain in place for the fallback mode and as second-
        line guards in worktree mode.
    *   Fallback mode works with existing v5.5.1 tests unchanged.
*   **Negative:**
    *   Increased disk usage for `per-worktree` install strategy; `symlink`
        and `pnpm-store` mitigate at the cost of platform fragility.
    *   Windows long-path handling requires explicit operator attention
        when the worktree root nests deeply.
    *   Concurrent `git fetch` can collide on `.git/packed-refs.lock`;
        handled by bounded retry rather than a global lock.
*   **Mitigation:**
    *   `worktree-lifecycle.md` documents the model, Windows notes, and
        escape hatches.
    *   Real-git integration test (`tests/integration/parallel-sprint.test.js`)
        asserts AC6 (no WIP cross-contamination across five concurrent
        stories) and AC7 (main-checkout reflog quiet) on every run.

---

