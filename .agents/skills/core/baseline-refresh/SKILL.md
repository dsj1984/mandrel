---
name: baseline-refresh
description: >-
  Author a refresh commit for any of the unified-baseline snapshots (CRAP,
  maintainability, dead-exports, lighthouse). Use whenever an intentional
  code change resets a baseline key (rename, deliberate complexity bump,
  perf regression with operator sign-off) and the close-validation chain
  needs the refreshed snapshot to land on the same Story branch as the
  triggering edit.
allowed_tools:
  - Read
  - Write
  - Bash
---

# baseline-refresh

## Policy Capsule

- Refresh only when the change is **deliberate** (rename, approved complexity bump, signed-off perf delta, intentional API surface change). Never refresh to paper over an unintentional regression — fix the regression instead.
- Run the kind-specific update command (`npm run crap:update` / `maintainability:update` / `dead-exports:update` / `lighthouse:update`) on the **Story branch**, not on `main`.
- Verify the resulting diff is scoped to the relevant `baselines/<kind>.json` (plus cosmetic `package-lock.json` churn only). If unrelated files appear, STOP — the refresh is contaminated.
- Stage baseline files **explicitly** (`git add baselines/<kind>.json`). Never `git add -A` in a refresh commit.
- Commit-subject contract: a **Conventional-Commits** subject of the form `chore(baselines): refresh <kind> snapshot for <reason>` — never an ad-hoc leading token like `baseline-refresh:` (commitlint and the planner validator reject it).
- The commit body is **mandatory** and non-empty: explain what changed, why the new floor is correct, and link the Story/Epic that triggered the refresh.
- Add the machine-readable trailer `baseline-refresh: true` (one per line, `Key: value` git-trailer style) to the body whenever observability classification matters.
- Include `Epic: #<epic-id>` as a body trailer.
- Never pass `--no-verify`. The `commit-msg` hook (commitlint) MUST run and pass.
- After the refresh lands, re-run `node .agents/scripts/check-baselines.js` to confirm the gate passes against the new snapshot; if it still fails, a sibling kind drifted — refresh that kind too.

## Role

Senior engineer authoring a deliberate, observable refresh of one of the
unified baseline snapshots that the close-validation chain enforces
(`baselines/crap.json`, `baselines/maintainability.json`,
`baselines/dead-exports.json`, `baselines/lighthouse.json`).

A refresh is **not** a regression entry — it tells the ratchet that the
new baseline key is intentional, so the gate compares future runs against
the refreshed snapshot rather than the prior one.

## When to use

- A file rename or move detached an MI/CRAP key from its prior baseline.
- A method rename inside a file produced a phantom new key + phantom
  deleted key under escomplex's `<file>::<methodName>` keying.
- An operator-approved complexity bump or perf delta needs to be
  enshrined as the new floor.
- A dead-export gate flagged a deliberate API surface change that has
  been signed off.

If the underlying change is an **unintentional** regression, do not refresh
— remediate the regression first.

## Commit-subject contract (authoritative)

Refresh commits MUST use a **Conventional-Commits subject** and MUST NOT
use a legacy ad-hoc prefix as the leading token. The canonical shape is:

```text
chore(baselines): refresh <kind> snapshot for <reason>

<non-empty body explaining the refresh — what changed, why the new
baseline is the correct floor, and any operator sign-off reference>

baseline-refresh: true
Epic: #<epic-id>
```

### Why a Conventional-Commits subject

1. The local `commit-msg` hook (`.husky/commit-msg` → `commitlint`) rejects
   any subject whose leading token is not one of
   `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert`. Legacy
   ad-hoc leading tokens fail this hook. `--no-verify` is forbidden by
   [`.agents/rules/git-conventions.md`](../../../rules/git-conventions.md),
   so the subject must conform.
2. `release-please` consumes Conventional-Commits subjects on `main` to
   generate `docs/CHANGELOG.md` and bump `package.json`. A
   non-conventional subject parses as "no changelog entry" and the
   refresh disappears from the release record.
3. `chore(baselines):` keeps the refresh out of the user-facing changelog
   (which is correct — a baseline refresh is internal hygiene, not a
   feature or fix) while still being machine-parseable.

### Body trailer for machine-readable classification

When telemetry, the friction analyzer, or the baseline-refresh-rate
observability surface needs to detect a refresh commit, add the trailer
`baseline-refresh: true` to the commit **body** (one trailer per line,
following the `Key: value` git-trailer convention). The trailer is the
canonical machine-readable marker. Subject-level leading tokens are not
— and must not be — used for this purpose.

The trailer form is also what
[`.agents/scripts/lib/observability/baseline-refresh-rate.js`](../../../scripts/lib/observability/baseline-refresh-rate.js)
should classify against going forward; until that classifier is updated,
the historical subject-prefix detection remains in place as a
backwards-compatibility fallback but is not the prescribed shape for new
commits.

## Procedure

### Step 1 — Run the matching update command

Each baseline kind has a dedicated update script:

| Kind            | Update command                  |
| --------------- | ------------------------------- |
| CRAP            | `npm run crap:update`           |
| Maintainability | `npm run maintainability:update`|
| Dead-exports    | `npm run dead-exports:update`   |
| Lighthouse      | `npm run lighthouse:update`     |

Run the command on the Story branch that triggered the refresh — the
worktree's HEAD must already be the Story branch, not `main`.

### Step 2 — Verify the diff is scoped to the baseline file

`git status` should show only the relevant `baselines/<kind>.json` (or
sibling per-kind files) and possibly `package-lock.json` cosmetic churn.
If unrelated files appear in the diff, **STOP** — the update script
picked up an unintentional regression and the refresh is contaminated.

### Step 3 — Author the commit

Stage the baseline file(s) explicitly (do not `git add -A`), then commit
with the Conventional-Commits subject + body trailer:

```bash
git add baselines/<kind>.json
git commit -m "$(cat <<'EOF'
chore(baselines): refresh <kind> snapshot for <reason>

<body explaining what changed, why the new floor is correct, and
linking the upstream Story/Epic that triggered the refresh.>

baseline-refresh: true
Epic: #<epic-id>
EOF
)"
```

Do NOT pass `--no-verify`. The `commit-msg` hook (commitlint) MUST run
and MUST pass.

### Step 4 — Re-run the gate

After the refresh commit lands on the Story branch, re-run
`node .agents/scripts/check-baselines.js` to confirm the gate now passes
against the refreshed snapshot. If it still fails, the refresh was
incomplete (a sibling kind also drifted) — repeat from Step 1 for the
remaining kind.

## Constraints

- **Never** use a legacy ad-hoc token as the leading Conventional-Commits
  type in the commit subject. The allowed leading types are
  `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert` — this
  is enforced by commitlint locally and by the planning-time validator
  (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) at
  decompose time.
- **Always** include a non-empty body. Empty-body refreshes are
  unreviewable and hide the operator decision behind a one-line subject.
- **Always** include the `baseline-refresh: true` trailer when telemetry
  / observability classification matters. The trailer is the
  machine-readable marker going forward.
- **Always** stage the baseline file(s) explicitly. A refresh commit
  whose diff also touches unrelated files is a contaminated refresh and
  the gate's "this floor is correct" semantics no longer hold.
- **Never** refresh to paper over an unintentional regression. Refresh
  is "this is the new correct floor"; if the change isn't a deliberate
  one, fix the regression instead.

## Rationale anchor

Epic #2501 retired the legacy `baseline-refresh` ad-hoc leading-token
prescription in favor of the Conventional-Commits subject +
`baseline-refresh: true` body-trailer shape documented above. See that
Epic for the full migration history and the friction signals that
motivated the change.
