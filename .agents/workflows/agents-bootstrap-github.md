---
description: Initialize GitHub repo with v5 label taxonomy and project fields
---

# /agents-bootstrap-github

## Purpose

Idempotent setup of the v5 Epic-centric orchestration infrastructure on the
target GitHub repository. Creates the required label taxonomy and project board
custom fields.

## Constraint

- **Persona**: `engineer`
- **Read-Only Context**: `.agentrc.json` orchestration block
- **Idempotent**: Safe to run multiple times — skips resources that exist
- **Destructive Actions**: None — only creates, never deletes or modifies
  existing labels or fields

## Steps

1. **Verify Configuration**: Read `.agentrc.json` and confirm the
   `orchestration` block is present and valid.

2. **Run Bootstrap Script**:

   ```bash
   node .agents/scripts/agents-bootstrap-github.js
   ```

3. **Review Output**: The script prints a summary of created vs. skipped
   resources. Verify the counts match expectations.

4. **Verify in GitHub UI** (optional): Navigate to the repository's Labels page
   and Project board to confirm resources were created with correct colors and
   field options.

## What Gets Created

### Labels

| Category    | Labels                                                                                   | Color  |
| ----------- | ---------------------------------------------------------------------------------------- | ------ |
| Type        | `type::epic`, `type::feature`, `type::story`, `type::task`                               | Purple |
| Agent State | `agent::review-spec`, `agent::ready`, `agent::executing`, `agent::done`, `agent::blocked` | Green  |
| Status      | `status::blocked`                                                                        | Red    |
| Persona     | `persona::<name>` — one per file in `.agents/personas/`                                  | Blue   |
| Context     | `context::prd`, `context::tech-spec`                                                     | Purple |

> **`status::blocked` vs `agent::blocked`** — these are not duplicates.
> `status::blocked` is **planning metadata** placed on a Task by retro / sprint
> heuristics when a hotfix was needed mid-sprint; it is consumed by
> `retro-heuristics.js` and never gates dispatch. `agent::blocked` is the
> **runtime HITL pause** flipped by the runner when a wave halts and waits
> for operator input.

### Project Board Fields (if `projectNumber` is configured)

- **Sprint** (Iteration)
- **Execution** (Single Select): `sequential`, `concurrent`

### Branch protection on `main` (Epic #1142 Story #1157)

After labels and project setup, the bootstrap script writes the
`agentSettings.quality.prGate.checks` suite into GitHub's branch-protection
rule on the configured `agentSettings.baseBranch` (default `main`). The
behaviour is deliberately additive:

- **No existing rule** — a fresh protection rule is created carrying just
  the `prGate.checks` names as required status-check contexts. Strict
  status checks are enabled; PR-review and admin-enforcement knobs are
  left unset so operators can tune them by hand.
- **Existing rule** — every existing required-check context is preserved.
  Only the missing `prGate.checks` names are appended. Other rule fields
  (PR review counts, signed commits, restrictions) are read back and
  written through unchanged so re-running the bootstrap never clobbers
  operator-tuned settings.

Set `agentSettings.quality.prGate.enforceBranchProtection: false` in
`.agentrc.json` to skip the step entirely — useful when branch protection
is managed out-of-band (Terraform, manual UI, an org-level ruleset). The
flag defaults to `true` so the framework's promoted prGate suite is
load-bearing without per-repo opt-in.

When the GitHub token lacks the permissions needed to write protection
rules, the failure is logged and the bootstrap continues — the rest of
the setup still succeeds.

### Repo settings (CI-gates-only stance)

After branch protection, the bootstrap promotes the framework's
CI-gates-only stance onto the consumer repo. Two steps run in sequence:

1. **Branch protection (extended).** On top of the additive merge of
   `prGate.checks` (above), the writer stamps `enforce_admins: true`
   and `required_pull_request_reviews.required_approving_review_count: 0`
   onto the rule. Admins cannot bypass the CI suite; the approval-count
   is zero so a green CI verdict is the only gate between the PR and
   the merge button. The operator drives the PR to green via
   `/epic-deliver`'s Phase 7 watch loop.

   If the consumer's existing rule diverges on either of those fields,
   the bootstrap routes the proposed payload through the HITL confirm
   gate before applying it.

2. **Merge methods.** GitHub repo settings are PATCHed to match the
   framework defaults:

   | Field | Default | Why |
   | --- | --- | --- |
   | `allow_squash_merge` | `true` | One commit per PR; clean history. |
   | `allow_rebase_merge` | `false` | Rebase-merge would need status checks re-run per commit. |
   | `allow_merge_commit` | `false` | No merge commits cluttering `main`. |
   | `allow_auto_merge` | `true` | Lets the operator queue a PR with `gh pr merge --auto --squash`. |
   | `delete_branch_on_merge` | `true` | Head branches are throwaway. |

   Override per-consumer via `agentSettings.quality.mergeMethods` in
   `.agentrc.json`. Any drift between config + live repo routes through
   HITL before a PATCH lands.

#### Non-interactive contract

Every behavior-shifting step calls `bootstrap/hitl-confirm.js`. When
stdout is not a TTY (CI, sub-agents, redirected pipes), the gate logs
`[bootstrap] aborting: no TTY available for HITL confirm (set --assume-yes to bypass)`
to stderr and returns false — the step is then a no-op rather than a
silent apply. CI callers that *do* want to apply automatically pass
`--assume-yes`. Pure-additive changes (label creation, project field
appends, status-check name appends) are non-interactive as before; only
the behavior-shifting steps route through the gate.

## Troubleshooting

- **"No orchestration block"**: Add the `orchestration` object to your
  `.agentrc.json`. Copy from `.agents/default-agentrc.json`.
- **"API access verification failed"**: Check your `GITHUB_TOKEN` has `repo` and
  `project` scopes, or run `gh auth login`.
- **Rate limiting**: The script makes one API call per missing label. For large
  taxonomies, you may hit GitHub's rate limit. Re-run — it's idempotent.
