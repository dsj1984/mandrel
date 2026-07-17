---
name: gates-and-baselines
description:
  Governs quality gates and the unified-baseline snapshots. Use when authoring
  a baseline refresh commit (CRAP, maintainability, dead-exports, lighthouse),
  when setting up or modifying CI quality gates, or when introducing a new gate
  that asserts on pre-existing state without turning the integration branch red.
allowed_tools:
  - Read
  - Write
  - Bash
---

# Gates and Baselines

## Policy Capsule

- **No gate may be skipped.** Failing lint means fix lint, not disable the rule; a failing test means fix the code, not `.skip` or delete the test. Gates are ordered shift-left so cheap checks fail first, and CI failure output is fed back verbatim with the directive to reproduce and fix locally before re-pushing.
- **Introducing a gate that asserts on pre-existing state** (doc-drift, lint-vocabulary, dependency-cycle, missing-coverage) MUST land green at merge: either advisory-first (report-only until the backlog is burned down) or with the populated baseline committed in the same change that turns the gate on. Never wire a gate into `requiredChecks` that lands red on latent findings nobody authored.
- **Refresh a baseline only when the change is deliberate** — a rename/move, an operator-approved complexity bump, a signed-off perf delta, an intentional API-surface change. Never refresh to paper over an unintentional regression; fix the regression instead.
- Run the kind-specific refresh (`npm run crap:update` / `npm run maintainability:update`; dead-exports and lighthouse have no npm script — regenerate the rows and edit `baselines/dead-exports*.json` / `baselines/lighthouse.json` directly) on the **Story branch**, not on `main`.
- Verify the refresh diff is scoped to the relevant `baselines/<kind>.json` (plus cosmetic `package-lock.json` churn only). If unrelated files appear, STOP — the refresh is contaminated. Stage baseline files **explicitly** (`git add baselines/<kind>.json`); never `git add -A` in a refresh commit.
- Commit-subject contract: a **Conventional-Commits** subject `chore(baselines): refresh <kind> snapshot for <reason>` — never an ad-hoc leading token like `baseline-refresh:` (commitlint and the planner validator reject it). The body is **mandatory** and non-empty: what changed, why the new floor is correct, and the Story that triggered it.
- Add the machine-readable trailer `baseline-refresh: true` (git-trailer `Key: value` style) and `Story: #<storyId>` to the body whenever observability classification matters. Never pass `--no-verify`; the `commit-msg` hook (commitlint) MUST run and pass.
- After the refresh lands, re-run `node .agents/scripts/check-baselines.js` to confirm the gate passes against the new snapshot; if it still fails, a sibling kind drifted — refresh that kind too.
- Keep credentials in GitHub Secrets (or platform equivalent) even for CI-only test databases; treat the security audit (`npm audit` or equivalent) as gating for critical/high vulnerabilities reachable in production code.

## The Quality Gate Pipeline

Automate quality gates so no change reaches production without passing tests,
lint, type checking, and build. **Shift left** — a bug caught in linting costs
minutes; the same bug caught in production costs hours — and prefer many small,
frequent releases over big-bang merges (a deploy of 3 changes is debuggable, one
of 30 is not).

```text
lint → typecheck → unit tests → build → integration → E2E (optional)
     → security audit → bundle-size
```

**No gate can be skipped.** If lint fails, fix lint. If a test fails, fix the
code. When CI fails, feed the specific error back into the agent loop with the
directive to verify locally before re-pushing.

### Introducing a gate on pre-existing state

A new gate that asserts on latent state (doc-drift, lint-vocabulary,
dependency-cycle, missing-test-coverage) lands red because of findings nobody
authored, and every downstream PR is blocked until someone hotfixes the
integration branch. Before wiring such a gate into `requiredChecks`, land it in
a shape that is green at merge — **advisory-first** (report-only until the
backlog is burned down) or by **committing the populated baseline in the same
change** that turns the gate on.

## Baseline Refresh

The close-validation chain enforces unified baseline snapshots
(`baselines/crap.json`, `baselines/maintainability.json`,
`baselines/dead-exports.json`, `baselines/lighthouse.json`). A refresh is **not**
a regression entry — it tells the ratchet that the new baseline key is
intentional, so the gate compares future runs against the refreshed snapshot
rather than the prior one.

**When to refresh:** a file rename/move detached an MI/CRAP key; a method rename
inside a file produced a phantom new + phantom deleted key (escomplex keys CRAP
rows on `<file>::<methodName>`); an operator-approved complexity bump or perf
delta needs to be enshrined as the new floor; a dead-export gate flagged a
signed-off API-surface change. If the underlying change is an **unintentional**
regression, do not refresh — remediate first.

### Commit-subject contract (authoritative)

```text
chore(baselines): refresh <kind> snapshot for <reason>

<non-empty body explaining the refresh — what changed, why the new
baseline is the correct floor, and any operator sign-off reference>

baseline-refresh: true
Story: #<storyId>
```

The `commit-msg` hook (`commitlint`) rejects any subject whose leading token is
not one of `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert`, and
`--no-verify` is forbidden by
[`.agents/rules/git-conventions.md`](../../../rules/git-conventions.md), so the
subject MUST conform. `release-please` consumes the subject on `main`;
`chore(baselines):` keeps the refresh out of the user-facing changelog (correct —
it is internal hygiene) while staying machine-parseable. The
`baseline-refresh: true` **body trailer** is the canonical machine-readable
marker — subject-level leading tokens are not, and must not be, used for this
purpose. (Its only reader, `baseline-refresh-rate.js`, went with the
execution-analysis surface in Story #4545; the trailer convention stands on its
own as the parseable marker for any future reader.)

### Procedure

| Kind            | Update command                   |
| --------------- | -------------------------------- |
| CRAP            | `npm run crap:update`            |
| Maintainability | `npm run maintainability:update` |
| Dead-exports    | edit `baselines/dead-exports.json` / `baselines/dead-exports-production.json` (rows are `(file, symbol)`; `check-dead-exports.js --json` prints the current rows) |
| Lighthouse      | edit `baselines/lighthouse.json`  |

1. **Run the matching update command** on the Story branch (HEAD must already be
   the Story branch, not `main`).
2. **Verify the diff is scoped** to the relevant `baselines/<kind>.json` (and
   possibly cosmetic `package-lock.json` churn). Unrelated files → STOP, the
   refresh is contaminated.
3. **Author the commit.** Stage the baseline file(s) explicitly, then commit with
   the Conventional-Commits subject + body trailer above:

   ```bash
   git add baselines/<kind>.json
   git commit -m "$(cat <<'EOF'
   chore(baselines): refresh <kind> snapshot for <reason>

   <body: what changed, why the new floor is correct, linking the Story.>

   baseline-refresh: true
   Story: #<storyId>
   EOF
   )"
   ```

   Do NOT pass `--no-verify`.
4. **Re-run the gate** — `node .agents/scripts/check-baselines.js`. If it still
   fails, a sibling kind drifted; repeat from step 1 for that kind.

## Red Flags

- CI failures ignored or silenced; tests disabled in CI to make the pipeline pass.
- A new required gate merged red on pre-existing findings, blocking every
  downstream PR.
- A legacy ad-hoc leading token (`baseline-refresh:`) as the commit subject type.
- An empty-body refresh — unreviewable, hides the operator decision.
- A refresh commit whose diff touches unrelated files (contaminated refresh).
- Refreshing to paper over an unintentional regression.
- Secrets stored in code or CI config instead of a secrets manager.

## Verification

- [ ] Every quality gate is present (lint, types, tests, build, audit) and
      failures block merge (branch protection configured).
- [ ] Any newly introduced gate is green at merge (advisory-first or
      baseline-in-same-change).
- [ ] A baseline refresh uses the Conventional-Commits subject + non-empty body
      + `baseline-refresh: true` trailer, staged explicitly, no `--no-verify`.
- [ ] `check-baselines.js` passes against the refreshed snapshot.
