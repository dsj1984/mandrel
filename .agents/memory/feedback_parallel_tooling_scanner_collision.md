---
name: parallel-tooling.md trips story-init-not-backgrounded
description: helpers/parallel-tooling.md documents Rule 2 (run_in_background) and the story-init.js anti-pattern within a 20-line window; the scanner's basename exclusion list was extended in commit 5a42ff9d so the helper no longer false-positives, but any future helper that documents both shapes will collide again.
type: feedback
originSessionId: ed0b86f1-b44e-4a7d-b741-b98d72014a85
---

# parallel-tooling.md trips story-init-not-backgrounded

The `story-init-not-backgrounded` scanner (`.agents/scripts/lib/checks/story-init-not-backgrounded.js`) flags any file mentioning `story-init.js` within ±20 lines of a backgrounding token (`run_in_background: true`, `detached: true`, `story-init.js &`). The exclusion list now covers `story-init.js`, `story-init-not-backgrounded.{js,test.js}`, and (as of Epic #1185, commit 5a42ff9d) `parallel-tooling.md`.

**Why:** during Epic #1185 wave 2, the scanner blocked every story-close on `epic/1185` because the parallel-tooling helper documents both Rule 2 (run_in_background) and the story-init anti-pattern as adjacent bullets — the prose collided with the scanner's 20-line window even though there is no real invocation.

**How to apply:** when authoring a new `helpers/*.md` doc that explains both backgrounding patterns and the story-init anti-pattern in the same file, either (a) add the file's basename to the scanner's exclusion list, or (b) keep the two mentions more than 20 lines apart. The scanner is `refuse-and-print`, so the failure mode is "every story-close on the affected epic branch refuses preflight" — easy to misdiagnose as a per-Story issue.
