---
name: Post-merge push-hook cascade on sprint-close
description: After merging epic→main, the pre-push hook can still fail on biome-format and MI baseline; run both checks BEFORE the merge to avoid "merge is done but cannot push"
type: feedback
originSessionId: 1aad4d52-2cb9-4dab-8125-48d091193355
---

# Post-merge push-hook cascade on sprint-close

When closing an Epic, the pre-push hook on `main` runs BOTH `biome check`
(stricter than `biome lint`, includes formatting) and the maintainability
ratchet. Either can fail AFTER the local merge commit has landed, leaving
you with a merge that succeeded locally but cannot reach the remote.

**Observed during Epic #638 close (pre-Epic #902 architecture, when the
workflow was `/sprint-close`):**

- Pre-merge `npm run lint` on epic/638 → green (biome lint only).
- Local merge of epic/638 into main succeeded.
- `git push` → blocked by pre-push hook: `biome check` flagged 4
  format-only diffs and the MI ratchet flagged 6 small drops from the
  new ctx-plumbing code.
- Recovery required two extra commits on main: `style: biome format pass`
  and `baseline-refresh: MI baseline …`.

**Why:** `npm run lint` is `biome lint`, but the pre-push hook runs
`biome check`. The two diverge whenever a file has format-only drift.
Similarly, the in-loop maintainability gate is informational; only the
pre-push hook is blocking.

**How to apply:** During `/epic-close` pre-merge validation, run BOTH the
lint and the heavier pre-push surface before the merge to surface drift
while you're still on the epic branch:

```sh
npx biome check .                    # not just `npm run lint`
node .agents/scripts/check-maintainability.js
```

If either fails on the epic branch:

- Format issues: `npx biome format --write .`, commit on the epic branch.
- MI drops on additive config-plumbing files: `npm run maintainability:update`,
  commit with a `baseline-refresh:` subject (the convention the
  baseline-refresh-guardrail expects).

This keeps the merge + push idempotent — no post-merge cleanup commits
required.
