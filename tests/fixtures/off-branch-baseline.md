▶ [sprint-story-init] [ENV] worktreeIsolation=off (env-override)
▶ [sprint-story-init] [ENV] sessionId=<sessionId> (local|remote)
▶ [sprint-story-init] [INIT] Initializing Story #<id>...
▶ [sprint-story-init] [CONTEXT] Epic: #<epic>, Feature/Parent: #<parent>
▶ [sprint-story-init] [CONTEXT] PRD: #<prd>, Tech Spec: #<spec>
▶ [sprint-story-init] [BLOCKERS] Checking <n> dependency/dependencies...
▶ [sprint-story-init] [BLOCKERS] ✅ All blockers resolved
▶ [sprint-story-init] [TASKS] Found <n> child Task(s) in dependency order
▶ [sprint-story-init] [GIT] Fetching remote refs...
▶ [sprint-story-init] [GIT] Epic branch ref exists (local+remote): epic/<epic>
▶ [sprint-story-init] [GIT] ✅ Applied core.longpaths=true (repo-level, Windows)   # win32 only
▶ [sprint-story-init] [GIT] Checking out story branch: story-<id>
▶ [sprint-story-init] [GIT] ✅ On branch: story-<id>
▶ [sprint-story-init] [TICKETS] Transitioning <n> Task(s) to agent::executing...
▶ [sprint-story-init] [TICKETS]   #<task> → agent::executing ✅
▶ [sprint-story-init] [DONE] ✅ Story #<id> initialized. <n> Task(s) ready for implementation.

# ── Close-side log (story-close.js) on the off-branch ──
▶ [sprint-story-close] [INIT] Closing Story #<id>...
▶ [sprint-story-close] [TASKS] Found <n> child Task(s)
▶ [sprint-story-close] [VALIDATE] Running pre-merge gates (lint, test, format, maintainability)...
▶ [sprint-story-close] [LOCK] 🔒 Acquired epic-<epic>.merge.lock
▶ [sprint-story-close] [GIT] Checking out epic/<epic>...
▶ [sprint-story-close] [GIT] Merging story-<id> into epic/<epic> (--no-ff)...
▶ [sprint-story-close] [GIT] ✅ Merge successful
▶ [sprint-story-close] [GIT] Pushing epic/<epic>...
▶ [sprint-story-close] [LOCK] 🔓 Released epic-merge lock
▶ [sprint-story-close] [WORKTREE] ⏭️ Skipping worktree reap (worktree isolation disabled)
▶ [sprint-story-close] [CLEANUP] Deleting story branch: story-<id>
▶ [sprint-story-close] [CLEANUP] ✅ Remote branch story-<id> deleted
▶ [sprint-story-close] [TICKETS] Transitioning <n> Task(s) to agent::done...
▶ [sprint-story-close] [TICKETS]   #<task> → agent::done ✅
▶ [sprint-story-close] [TICKETS] Transitioning Story #<id> to agent::done...
▶ [sprint-story-close] [TICKETS]   #<id> → agent::done ✅
▶ [sprint-story-close] [TICKETS] Running cascade completion...
▶ [sprint-story-close] [HEALTH] ✅ Health metrics updated
▶ [sprint-story-close] [DASHBOARD] ✅ Dashboard manifest updated (temp/)
▶ [sprint-story-close] [DONE] ✅ Story #<id> merged into epic/<epic>. <n> ticket(s) closed.

# Invariants asserted by tests/sprint-story-off-branch-e2e.test.js:
#  - No log line contains "undefined" (no undefined-path warnings).
#  - No log line contains "still-registered" / "orphan-worktree" / "stillRegistered".
#  - worktreeReapPhase emits exactly:
#      [WORKTREE] ⏭️ Skipping worktree reap (worktree isolation disabled)
#  - frictionEmitter.emit is never called for the reap path.
#  - WorktreeManager.{ensure, reap, gc, sweepStaleLocks} short-circuit
#    without invoking the underlying git adapter.
