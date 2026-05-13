---
name: post-merge-close writes phase-timings.json against framework PROJECT_ROOT
description: Test sandbox cwd is ignored by post-merge-close.js — phase-timings.json always lands under the real repo's temp/epic-<eid>/story-<sid>/
type: project
---

# post-merge-close writes phase-timings.json against framework PROJECT_ROOT

`runPostMergeClose` in [.agents/scripts/lib/orchestration/story-close/post-merge-close.js](.agents/scripts/lib/orchestration/story-close/post-merge-close.js) accepts a `projectRoot` arg, but `story-close.js` always passes the module-level `PROJECT_ROOT` constant (resolved from `import.meta.url`, never overridden by `cwd:`/.agentrc.json). The phase-timings.json file therefore writes to the **framework** repo root regardless of test sandbox.

Same issue (different mechanism) for `signals-writer.appendSignal` in [post-merge-pipeline.js:81](.agents/scripts/lib/orchestration/post-merge-pipeline.js#L81) — it never threads the resolved config through, so `signalsFile()` falls back to `tempRoot:'temp'` and resolves it relative to `process.cwd()`.

**Why:** Bit me 2026-05-11 — tests in `story-orchestration.test.js` were leaking `temp/epic-50/story-100/{signals.ndjson,phase-timings.json}` into the project tree. Workaround landed: per-test `process.chdir(sandbox)` (catches signals) + `purgeLeakedRepoTemp(eid, sid)` helper in finally (catches phase-timings). Root cause is unfixed — proper fix would thread `projectRoot`/`tempRoot` from the resolved config through both call sites.

**How to apply:** When writing tests that drive `runStoryClose`/`runPostMergeClose` with a sandbox cwd, expect leakage to `<repo>/temp/epic-<eid>/story-<sid>/` regardless of how cleanly the test scopes its config. Either match the existing `purgeLeakedRepoTemp` pattern or fix the production code to honor the config-provided tempRoot.
