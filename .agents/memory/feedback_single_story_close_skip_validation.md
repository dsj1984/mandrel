---
name: single-story-close fails on validation with epicId=0
description: post-1957d889 validation-evidence rejects epicId=0 sentinel that single-story-close.js uses for standalone Stories; always re-run with --skip-validation
type: feedback
originSessionId: cf1e16c3-5c0b-4f11-9462-5edc9f91693a
---

# single-story-close fails on validation with epicId=0

`/single-story-execute` close path is broken on the validation gate
for standalone Stories.

**Symptom:** `single-story-close.js --story <id>` fails with
`Error: [validation-evidence] epicId must be a positive integer; got 0`
at `evidencePath` / `loadEvidence` / `shouldSkip` →
`runCloseValidation`.

**Root cause:** Commit `1957d889`
(`refactor(validation-evidence): migrate to per-Epic temp tree`) made
`epicId` a required positive integer in `validation-evidence.js`'s
path helpers. `single-story-close.js` passes `epicId: 0` as a sentinel
for standalone Stories (see the inline comment around line 141:
"useEvidence requires both storyId AND epicId; pass 0 to satisfy").
The two changes collide — the script's sentinel is rejected by the new
guard, so the validation step throws before it gets anywhere.

**Why:** Standalone Stories have no parent Epic, so there is no real
`epicId` to scope their validation evidence under. The `0` sentinel
was the workaround; the per-Epic refactor closed the loophole without
adding a `null`/`epic`-less branch.

**How to apply:** Always run
`single-story-close.js --story <id> --cwd <main-repo> --skip-validation`
for standalone Stories until the validation-evidence path supports an
epic-less branch (or single-story-close switches to its own evidence
keyspace). Verify gates separately — pre-commit / lint-staged hooks
already cover biome + maintainability + crap on staged files, and
direct `node --test` runs cover the test suite.

Pre-PR check (run before close): make sure lint-staged passed during
the commit (it does both biome write + markdownlint) AND the relevant
`tests/...` files pass via `node --test`. Those two together are
equivalent to the close-validation chain for the modules a standalone
Story touches.
