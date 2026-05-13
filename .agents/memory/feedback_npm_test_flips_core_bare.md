---
name: npm test flips core.bare on the main checkout
description: Test suite leaves the main repo's core.bare=true, breaking Git Graph, `git checkout`, and story-close — all with "must be run in a work tree"
type: feedback
originSessionId: e6e2095c-d11b-4bd1-8091-53816d2f755f
---

# npm test flips core.bare on the main checkout

Running `npm test` in the mandrel main checkout flips `core.bare`
in `.git/config` from `false` to `true` (test pollution). The repro is
deterministic: reset `core.bare false`, run `npm test`, re-read — it's
`true`.

**Symptoms (all same root cause — flipped `core.bare`):**

- VSCode **Git Graph** extension: `Error: Unable to load Commits — fatal: this operation must be run in a work tree`
- `story-close.js` aborts at "Checking out epic/<id>..." with the same fatal
- Plain `git checkout <branch>` from the repo root fails identically
- `git rev-parse --is-bare-repository` reports `true` while
  `git rev-parse --is-inside-work-tree` reports `false`

**One-line fix (any symptom):**

```powershell
git -C C:\Users\dsj19\Projects\mandrel config core.bare false
```

Reload Git Graph (or just re-run the failing git command) and it works
again.

Why this matters: `story-close.js` runs validation (which calls
`npm test`), then attempts `gitSync(cwd, 'checkout', epicBranch)` against
the main checkout. With `core.bare=true`, that checkout fails with
`fatal: this operation must be run in a work tree`, after the rebase has
already succeeded — leaving the story branch rebased but the merge un-run.

**Why:** Two integration tests (`tests/push-epic-retry.test.js` running
`git init --bare` in a tmpdir; `tests/lib/worktree-manager.test.js`
running `git init`) inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
from the husky pre-push hook env. Those env vars override
`execFileSync`'s explicit `cwd:`, so the bare-init wrote to the **parent**
`.git/config` instead of the tmpdir. Story #780 patched the root cause
in `.agents/scripts/lib/git-utils.js` (`cleanGitEnv()` strips every
`GIT_*` before threading `process.env` through `gitSpawn`/`gitSync`) —
that helper is on main now. If pollution recurs, regression-check
`cleanGitEnv` is still wired through both test fixtures.

**How to apply:** When `story-close.js` aborts at "Checking out
epic/<id>... must be run in a work tree", restore the flag and re-run
with `--skip-validation` (validation already passed):

```bash
git -C <main-repo> config core.bare false
node <main-repo>/.agents/scripts/story-close.js --story <id> --cwd <main-repo> --skip-validation
```

`--skip-validation` is safe in this scenario because the prior run
finished close-validation green; only the post-validation steps need to
run on the second pass.
