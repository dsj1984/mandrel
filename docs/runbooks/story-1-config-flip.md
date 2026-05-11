# Story 1 — Config flip (s1-config-flip)

> Runbook for Epic #1235 / Story #1239. Operator-driven `gh api` calls that
> flip this repo's merge methods and ruleset gating into the "CI-gated
> auto-merge" target state. The in-tree artifacts (`.agents/workflows/git-merge-pr.md`,
> `.github/ruleset.json`) are committed by sibling tasks; this file captures
> the **live-state** mutations a human operator must run against GitHub.

## Why this is a runbook, not a script

GitHub repo settings and rulesets are persistent server-side state, not source.
Committing the `gh api` invocation in-tree means anyone can replay the flip
deterministically without re-deriving the payload from a screenshot or
half-remembered PR. The `manual:` prefix on each Task's `## Verify` line is
load-bearing: it tells `/story-execute` that the read-back is operator work,
not a check the close-validation chain runs.

---

## Task #1244 — Apply repo merge-method settings

**One-shot command** (run from any clone with `gh auth` against the repo):

```bash
gh api -X PATCH repos/:owner/:repo \
  -F allow_rebase_merge=false \
  -F allow_auto_merge=true
```

This flips four merge-method flags into the target state:

| Flag                  | Before | After  | Why                                                                            |
| --------------------- | ------ | ------ | ------------------------------------------------------------------------------ |
| `allow_squash_merge`  | true   | true   | Squash is the only merge method `/git-merge-pr` and auto-merge will exercise.  |
| `allow_merge_commit`  | false  | false  | Already off; reasserted by the absence of the flag in the PATCH body.          |
| `allow_rebase_merge`  | true   | false  | Removes the rebase button so an operator cannot accidentally bypass squash.    |
| `allow_auto_merge`    | false  | true   | Required for `gh pr merge --auto` (the `/git-merge-pr` default after Story 1). |

`gh api` only mutates fields you pass with `-F`. The two flags above are
sufficient — the squash-on / merge-commit-off pair is already correct on this
repo at the audit snapshot of 2026-05-10.

### Expected post-state

```bash
gh api repos/:owner/:repo \
  --jq '{auto:.allow_auto_merge,squash:.allow_squash_merge,merge:.allow_merge_commit,rebase:.allow_rebase_merge}'
```

Should print:

```json
{ "auto": true, "squash": true, "merge": false, "rebase": false }
```

If any field disagrees, re-run the PATCH with the missing flags appended as
additional `-F key=value` pairs and re-read.

---

## Task #1246 — Re-PUT ruleset 14286998

**One-shot command** (run from the repo root after `.github/ruleset.json`
has been written by the in-tree commit for this task):

```bash
gh api -X PUT repos/:owner/:repo/rulesets/14286998 \
  --input .github/ruleset.json
```

`--input` reads the desired payload from disk. The committed
`.github/ruleset.json` is the source of truth for the rules array; the PUT
mirrors it onto the server so the live ruleset matches the artifact.

The target payload encodes four rules:

- `deletion` — blocks anyone from deleting the default branch.
- `non_fast_forward` — blocks force-pushes to the default branch.
- `required_linear_history` — keeps `main` linear (squash-only history).
- `required_status_checks` — both OS contexts (`Validate and Test (ubuntu-latest, node 22)`
  and `Validate and Test (windows-latest, node 22)`) must report success
  before merge; `strict_required_status_checks_policy: true` requires the PR
  branch to be up-to-date with the base before merge.

`bypass_actors: []` is the load-bearing change versus the audit-snapshot
state: admin-bypass is removed so a green CI run is the **only** path to
merge. The previously-configured `pull_request` rule (1 approval, dismiss
stale reviews) is intentionally absent — the bot-approver workflow from a
later Story is what supplies the approval click; until then this repo
relies on the CI gate alone.

### Expected post-state

```bash
gh api repos/:owner/:repo/rulesets/14286998 --jq '[.rules[].type] | sort'
# → ["deletion","non_fast_forward","required_linear_history","required_status_checks"]

gh api repos/:owner/:repo/rulesets/14286998 --jq '.bypass_actors | length'
# → 0
```

A deliberately-failing PR (e.g. a one-line lint break) should show both OS
contexts as required and the green Merge button as blocked.

---

## Task #1249 — Regenerate the in-tree artifact

After the PUT lands, the live ruleset can drift from the committed payload
(e.g. if GitHub adds new fields to the response shape). Re-dump it back into
the artifact so the diff stays reviewable:

```bash
gh api repos/:owner/:repo/rulesets/14286998 > .github/ruleset.json
```

Then re-commit `.github/ruleset.json` if `git diff --stat` reports any
change. The first-write commit for Task #1249 in this Story captures the
initial post-PUT state; subsequent drift is normal maintenance.

---

## Rollback

If the flip causes immediate breakage (e.g. CI starts failing on a healthy
PR because of a context-name typo), restore the audit-snapshot state:

```bash
# Re-allow rebase + admin-bypass merge during incident response only:
gh api -X PATCH repos/:owner/:repo -F allow_rebase_merge=true

# Detach the ruleset until the issue is understood:
gh api -X PATCH repos/:owner/:repo/rulesets/14286998 -F enforcement=disabled
```

Re-enable both once the underlying issue is fixed. Do **not** edit
`bypass_actors` back to allow admin override without a paper trail —
re-PUT the corrected `.github/ruleset.json` instead so the in-tree
artifact stays the source of truth.
