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

1. **Authenticate `gh`**:

   ```bash
   gh auth login
   ```

   Choose **GitHub.com → HTTPS → Login with a web browser**. The token is
   stored in your OS keychain (macOS Keychain, Windows Credential Manager,
   libsecret on Linux) — not in any project-local `.env` file. The default
   scopes (`repo` + `read:org`) cover everything the bootstrap touches
   except Projects V2 (see the optional section below).

   Verify the login landed:

   ```bash
   gh auth status
   ```

   The bootstrap script in step 3 will refuse to run if `gh` is missing,
   older than v2.40, or unauthenticated — so this step is the only
   credential setup most adopters will need.

2. **Verify Configuration**: Read `.agentrc.json` and confirm the
   `orchestration` block is present and valid.

3. **Run Bootstrap Script**:

   ```bash
   node .agents/scripts/agents-bootstrap-github.js
   ```

   The script preflights `gh --version` + `gh auth status` before any
   GitHub call. On failure it exits non-zero with the install / `gh auth
   login` / upgrade instructions inline — no need to grep through later
   error noise.

4. **Review Output**: The script prints a summary of created vs. skipped
   resources. Verify the counts match expectations.

5. **Verify in GitHub UI** (optional): Navigate to the repository's Labels page
   and Project board to confirm resources were created with correct colors and
   field options.

### Optional: Projects V2 GraphQL still needs a token

`gh auth login` covers the REST surface the bootstrap relies on. The
Projects V2 GraphQL operations (`resolveOrCreateProject`,
`ensureStatusField`, `ensureProjectViews`, `ensureProjectFields`) need a
token with the `project` scope, which `gh auth login` does not grant by
default. Two options, in order of preference:

1. **Re-auth `gh` with the `project` scope** (recommended — keeps the
   token in your OS keychain):

   ```bash
   gh auth refresh -s project,read:project
   ```

   The bootstrap reads the token via `gh auth token` automatically; no
   environment variable is needed.

2. **Export `GITHUB_TOKEN`** with the `project` scope as a fallback. The
   GraphQL shim reads this if `gh auth token` returns nothing. Treat it
   as a Projects-V2-only escape hatch, not the headline auth path:

   ```bash
   export GITHUB_TOKEN=<PAT with `project` scope>
   ```

If neither token resolves with the `project` scope, the bootstrap logs a
warning and skips Projects V2 setup — the rest of the run still
succeeds, so adopters who do not use Projects V2 can ignore this section
entirely.

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
`github.branchProtection.checks` suite into GitHub's branch-protection
rule on the configured `project.baseBranch` (default `main`). The
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

Set `github.branchProtection.enforceBranchProtection: false` in
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

   Override per-consumer via `github.mergeMethods` in
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
- **"gh CLI not found on PATH"** / **"gh ... is older than required
  2.40.0"**: Install or upgrade the `gh` CLI from
  <https://cli.github.com/> (or `brew upgrade gh` /
  `winget upgrade GitHub.cli`) and re-run.
- **"gh auth status failed: not logged in"**: Run `gh auth login` as in
  step 1 above.
- **"API access verification failed"** after `gh auth login` succeeded:
  Your auth scope likely lacks `repo`. Re-run
  `gh auth refresh -s repo,read:org` and try again.
- **Projects V2 scopes missing**: Re-auth with
  `gh auth refresh -s project,read:project` (or set `GITHUB_TOKEN`
  per the optional section above).
- **Rate limiting**: The script makes one API call per missing label. For large
  taxonomies, you may hit GitHub's rate limit. Re-run — it's idempotent.
