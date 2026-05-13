---
name: Concurrent story-close races epic HEAD
description: Parallel story-close.js runs against the same epic branch can return merged:true while leaving local HEAD stale, mirroring the post-merge push-hook cascade but caused by interleaving rather than hook failures
type: feedback
originSessionId: da10bb18-a23d-4323-ab52-b3250d2bb436
---

# Concurrent story-close races epic HEAD

Take a global lock at story-close.js entry (or serialize close per Epic branch) to prevent the concurrent-close `merged:true`-but-HEAD-stale failure mode.

**Why:** When two story-close runs target the same `epic/<id>` branch, one can fast-forward the remote while the other still holds a pre-merge ref. The second run sees its own merge succeed, reports `merged:true`, but the local epic HEAD on disk has already diverged — producing the same downstream symptoms as `feedback_post_merge_push_hook_cascade.md` (push hook rejection, stuck commits, MI gate re-runs) without the hook actually being the cause. Diagnosing it as a hook cascade leads to wasted retries.

**How to apply:** When implementing or reviewing story-close.js, add a per-epic-branch advisory lock (file lock under `.git/`, or a serialize-by-epic queue) at script entry, before any rebase/merge work. If you see `merged:true` paired with a stale HEAD or push-hook rejection during a session where multiple closes are in flight, suspect the race first — check for sibling close processes — before chasing the push-hook cascade. The two failure modes share a symptom but have different fixes.

**Status (2026-05-07):** Fix in flight — `withEpicMergeLock` is being added in `.agents/scripts/lib/orchestration/story-close/merge-runner.js` and wrapping the entire `runStoryClose` body in `story-close.js` (uncommitted as of this note). When that lands, the in-process race should be closed; cross-process races (multiple node invocations) still need the file-lock variant.
