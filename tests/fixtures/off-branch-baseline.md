▶ [story-init] [ENV] worktreeIsolation=off (env-override)
▶ [story-init] [ENV] sessionId=<sessionId> (local|remote)
▶ [story-init] [INIT] Initializing Story #<id>...
▶ [story-init] [CONTEXT] Epic: #<epic>, Feature/Parent: #<parent>
▶ [story-init] [CONTEXT] PRD: #<prd>, Tech Spec: #<spec>
▶ [story-init] [BLOCKERS] Checking <n> dependency/dependencies...
▶ [story-init] [BLOCKERS] ✅ All blockers resolved
▶ [story-init] [TASKS] Found <n> child Task(s) in dependency order
▶ [story-init] [GIT] Fetching remote refs...
▶ [story-init] [GIT] Epic branch ref exists (local+remote): epic/<epic>
▶ [story-init] [GIT] ✅ Applied core.longpaths=true (repo-level, Windows)   # win32 only
▶ [story-init] [GIT] Checking out story branch: story-<id>
▶ [story-init] [GIT] ✅ On branch: story-<id>
▶ [story-init] [TICKETS] Transitioning <n> Task(s) to agent::executing...
▶ [story-init] [TICKETS]   #<task> → agent::executing ✅
▶ [story-init] [DONE] ✅ Story #<id> initialized. <n> Task(s) ready for implementation.

# ── Close-side log (story-close.js) on the off-branch ──
▶ [story-close] [INIT] Closing Story #<id>...
▶ [story-close] [TASKS] Found <n> child Task(s)
▶ [story-close] [VALIDATE] Running pre-merge gates (lint, test, format, maintainability)...
▶ [story-close] [LOCK] 🔒 Acquired epic-<epic>.merge.lock
▶ [story-close] [GIT] Checking out epic/<epic>...
▶ [story-close] [GIT] Merging story-<id> into epic/<epic> (--no-ff)...
▶ [story-close] [GIT] ✅ Merge successful
▶ [story-close] [GIT] Pushing epic/<epic>...
▶ [story-close] [LOCK] 🔓 Released epic-merge lock
▶ [story-close] [WORKTREE] ⏭️ Skipping worktree reap (worktree isolation disabled)
▶ [story-close] [CLEANUP] Deleting story branch: story-<id>
▶ [story-close] [CLEANUP] ✅ Remote branch story-<id> deleted
▶ [story-close] [TICKETS] Transitioning <n> Task(s) to agent::done...
▶ [story-close] [TICKETS]   #<task> → agent::done ✅
▶ [story-close] [TICKETS] Transitioning Story #<id> to agent::done...
▶ [story-close] [TICKETS]   #<id> → agent::done ✅
▶ [story-close] [TICKETS] Running cascade completion...
▶ [story-close] [HEALTH] ✅ Health metrics updated
▶ [story-close] [DASHBOARD] ✅ Dashboard manifest updated (temp/)
▶ [story-close] [DONE] ✅ Story #<id> merged into epic/<epic>. <n> ticket(s) closed.

# Invariants asserted by tests/story-off-branch-e2e.test.js:
#  - No log line contains "undefined" (no undefined-path warnings).
#  - No log line contains "still-registered" / "orphan-worktree" / "stillRegistered".
#  - worktreeReapPhase emits exactly:
#      [WORKTREE] ⏭️ Skipping worktree reap (worktree isolation disabled)
#  - frictionEmitter.emit is never called for the reap path.
#  - WorktreeManager.{ensure, reap, gc, sweepStaleLocks} short-circuit
#    without invoking the underlying git adapter.
