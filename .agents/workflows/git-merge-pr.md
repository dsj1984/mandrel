---
description: >-
  Analyze, validate, resolve conflicts, and merge a given pull request by
  number.
---

# /git-merge-pr [#PR_LIST]

This workflow performs a full end-to-end merge of one or more pull requests: it
analyzes each PR diff, validates linting and tests, resolves any merge
conflicts, and completes the merge into the target base branch.

> **When to run**: Any time one or more PRs are ready for merge review and you
> want an automated merge with conflict resolution and quality gates enforced.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

---

## Step 0 — Resolve Context

1. Resolve one or more `[PR_NUMBER]` values from the slash-command argument
   (e.g. `/git-merge-pr 42 43 45` → `PR_LIST=[42, 43, 45]`).
2. **Sequential Loop**: Steps 1 through 7 must be performed **sequentially** for
   each PR in the `PR_LIST`. Complete the full merge and cleanup for one PR
   before starting the next.
3. For the current `[PR_NUMBER]`, fetch metadata from GitHub by calling
   `mcp__github__pull_request_read` (method `get`) with the repo's
   `owner` / `repo` and `pullNumber: [PR_NUMBER]`. From the response, read
   `number`, `title`, `headRefName`, `baseRefName`, `state`, `mergeable`,
   and `mergeStateStatus`.

4. From the output, resolve:
   - `[PR_TITLE]` — the PR title.
   - `[HEAD_BRANCH]` — the source branch (`headRefName`).
   - `[BASE_BRANCH]` — the merge target (`baseRefName`).
   - `[PR_STATE]` — must be `OPEN`. If `CLOSED` or `MERGED`, **SKIP** this PR
     and proceed to the next one in the list.
   - `[MERGEABLE]` — initial GitHub mergeability signal (`MERGEABLE`,
     `CONFLICTING`, or `UNKNOWN`).

---

## Step 1 — PR Analysis

Fetch the full diff and review the scope of changes:

```powershell
gh pr diff [PR_NUMBER]
```

> **Why `gh pr diff` and not MCP?** `mcp__github__pull_request_read`'s
> `get_diff` method returns a structured response rather than the raw
> unified diff this step renders to the operator. `gh pr diff` stays
> until MCP exposes a raw-diff equivalent.

Summarize the following to the operator before proceeding:

- **Files changed** (count and list).
- **Lines added / removed**.
- **Areas of concern** — any files that touch shared utilities, schemas,
  migrations, or critical infrastructure.
- **Initial mergeability status** from Step 0.

> This is a read-only analysis step. No files are modified yet.

---

## Step 2 — Checkout & Sync

Delegate the rebase orchestration to `git-rebase-and-resolve.js`. It fetches
`origin`, checks out the head branch, and rebases it onto the base — then
reports the outcome in structured form so this skill routes on outcome
instead of re-implementing the retry loop.

```powershell
node .agents/scripts/git-rebase-and-resolve.js --onto origin/[BASE_BRANCH] --head [HEAD_BRANCH] --json
```

Parse the JSON result. Route on `outcome`:

- `clean` → rebase landed with no conflicts. Proceed to Step 3.
- `conflict` → `conflictedFiles[]` lists the unmerged paths. Proceed to
  Step 2.5.
- `error` → git returned an error unrelated to conflicts. **STOP** and
  surface `stderr` to the operator.

### Step 2.5 — Conflict Resolution

Follow the shared conflict-resolution procedure in
[`helpers/_merge-conflict-template.md`](helpers/_merge-conflict-template.md):
read both sides
of each file in `conflictedFiles[]`, apply both when compatible (or choose a
side with an explicit rationale), never silently drop code, then stage the
resolutions.

Continue the rebase via the script — it calls `git rebase --continue` and
reports whether the rebase is now clean, still has conflicts (cascading
conflict), or hit a different error:

```powershell
node .agents/scripts/git-rebase-and-resolve.js --continue --json
```

Loop until `outcome` is `continued`. If you need to bail out entirely:

```powershell
node .agents/scripts/git-rebase-and-resolve.js --abort --json
```

Once the rebase completes cleanly, force-push the rebased branch:

```powershell
git push --force-with-lease origin [HEAD_BRANCH]
```

---

## Step 3 — Quality Gate (Lint + Format + Test)

Run the full lint / format / test suite via the gate wrapper. The wrapper
owns the command list so this skill doesn't rot when a project renames
`lint` → `lint:ci` or swaps Biome for ESLint. The default check set is
`lint`, `format:check`, `test`; override via `.agentrc.json → github.branchProtection`.

```powershell
node .agents/scripts/git-pr-quality-gate.js --json
```

The script emits a JSON result `{ ok, checks: [...], failed: [...] }`.
Exit code 0 means every check passed. On failure:

1. Read the `failed[]` entries (each has `name` and `reason`).
2. For **format** failures, run `npx biome format --write .` to auto-fix,
   then re-run the gate.
3. For **lint** failures, apply the minimal manual fix.
4. For **test** failures, classify before fixing:
   - **Pre-existing failures** (unrelated to this PR's diff): alert the
     operator and ask whether to proceed or block.
   - **Regression introduced by this PR**: apply the fix.
5. Commit the fixes and re-push:

   ```powershell
   git add .
   # justification: post-CI remediation; CI lint+test gate ran upstream and produced the failure being fixed here. Local hook would re-run the same gate.
   git commit --no-verify -m "fix(ci): resolve quality-gate failures on [HEAD_BRANCH] for PR #[PR_NUMBER]"
   git push origin [HEAD_BRANCH]
   ```

6. Re-run the gate until it exits 0 before continuing to Step 3.5.

> If a failure cannot be resolved after exhausting reasonable remediation
> attempts, **STOP** and escalate to the operator with a detailed summary.

---

## Step 3.5 — Unified Baselines Gate (`check-baselines`)

`check-baselines.js` is the single canonical floor + tolerance + schema
gate for every baseline kind (coverage, crap, maintainability, mutation).
It owns absolute-floor enforcement, schema validation, and kernel-mismatch
surfacing. The per-kind regression CLIs that previously layered on top of
this gate were removed in Epic #1943 — `check-baselines.js` is now the
sole source of truth for baseline regressions at merge time.

```powershell
node .agents/scripts/check-baselines.js --format text
```

Exit codes:

- `0` — every enabled gate's floors are met and no schema errors.
- `1` — any floor breach. Inspect the JSON output
  (`--format json`, the default) to see which kind / component / axis
  fell below floor.
- `2` — any baseline failed schema validation. Regenerate the offending
  baseline through its per-kind update script.
- `3` — config resolution error (typically a malformed `.agentrc.json`).

Treat any non-zero exit as a hard merge block before proceeding to Step 4.

---

## Step 4 — Final Mergeability Check

Re-query GitHub to confirm the PR is now clean and ready to merge by
calling `mcp__github__pull_request_read` (method `get`) with the repo's
`owner` / `repo` and `pullNumber: [PR_NUMBER]`. Read `mergeable`,
`mergeStateStatus`, `reviewDecision`, and `statusCheckRollup` from the
response (the same fields the prior `gh pr view --json` shape exposed).

Verify:

- `mergeable` is `MERGEABLE`.
- `mergeStateStatus` is `CLEAN` or `HAS_HOOKS`.
- Required CI checks (if any) are passing (`statusCheckRollup` → all `SUCCESS`
  or `NEUTRAL`).

If any blocking condition remains, resolve it before proceeding to the merge
step.

---

## Step 5 — Merge

Merge the PR as a squash commit and delete the head branch. Call
`mcp__github__merge_pull_request` with the repo's `owner` / `repo`,
`pullNumber: [PR_NUMBER]`, `merge_method: "squash"`, and
`delete_branch: true`.

> **MCP coverage gap — auto-merge queueing.** `mcp__github__merge_pull_request`
> performs an **immediate** merge; it does not enable GitHub's native
> auto-merge queue. When the workflow needs to queue the merge behind
> required-check completion (the default `--auto` posture), fall back to
> the shell form `gh pr merge [PR_NUMBER] --auto --squash --delete-branch`.
> Use the MCP call when CI is already green and the merge can fire
> synchronously (the common case after a clean Step 4 verdict).
>
> **Merge strategy guidance** (override with operator instruction):
>
> - `mcp__github__merge_pull_request` with `merge_method: "squash"` — the
>   default for an already-green PR; clean history, single squash commit.
> - `gh pr merge [PR_NUMBER] --auto --squash --delete-branch` — auto-merge
>   queueing fallback when required checks are still pending. Requires
>   `allow_auto_merge=true` on the repo (Story #1239 turns this on).
> - `gh pr merge [PR_NUMBER] --squash` (no `--auto`) — synchronous merge;
>   use only when bypassing auto-merge is intentional (e.g. CI is broken
>   and a hotfix is going in under admin override).
> - `--merge` — preserves the full commit history from `[HEAD_BRANCH]` (use for
>   Epic branches with meaningful commit granularity); pass `merge_method:
>   "merge"` to the MCP call or `--merge` to `gh pr merge`.
> - `--rebase` — linear history; ideal for small, atomic PRs; pass
>   `merge_method: "rebase"` to the MCP call or `--rebase` to `gh pr merge`.

After the merge command returns, perform a conflict marker scan to confirm no
stray markers entered the base branch. Delegate to `detect-merges.js` — it
owns the scan logic and is the same script used by `/deliver` Phase 5.3.

```powershell
git checkout [BASE_BRANCH]
git pull origin [BASE_BRANCH]
node .agents/scripts/detect-merges.js
```

If the script exits non-zero: **STOP**, alert the operator immediately, and
do not proceed until the conflict markers are resolved.

---

## Step 6 — Post-Merge Verification & Cleanup

Confirm the merge landed correctly on the base branch:

```powershell
git log origin/[BASE_BRANCH] -5 --oneline
```

Verify that the top commit corresponds to the merged PR.

Explicitly delete the remote head branch. This is **mandatory** and must always
succeed — even if the Husky pre-push hook blocks `git push origin --delete`. Use
the **two-stage** approach below:

**Stage 1 — git push (fast path):**

```powershell
# Attempt standard deletion first (fast, uses existing auth)
git push origin --delete [HEAD_BRANCH] 2>$null
$gitDeleteOk = $LASTEXITCODE -eq 0
```

**Stage 2 — REST API fallback (always run if Stage 1 failed):**

If Stage 1 fails (exit code ≠ 0, e.g., due to Husky hook blocking the push),
fall back to the GitHub REST API using the token from the git credential store:

```powershell
if (-not $gitDeleteOk) {
  # Retrieve token from git's native credential manager
  $creds = "protocol=https`nhost=github.com`n" | git credential fill 2>$null
  $token = ($creds | Select-String 'password=(.+)').Matches[0].Groups[1].Value

  if ($token) {
    $url = "https://api.github.com/repos/[OWNER]/[REPO]/git/refs/heads/[HEAD_BRANCH]"
    $headers = @{ Authorization = "token $token"; Accept = "application/vnd.github.v3+json" }
    try {
      Invoke-RestMethod -Method DELETE -Uri $url -Headers $headers -ErrorAction Stop
      Write-Host "Remote branch deleted via REST API: [HEAD_BRANCH]"
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 422 -or $status -eq 404) {
        Write-Host "Branch already gone (HTTP $status) — skipping."
      } else {
        Write-Warning "Failed to delete remote branch via API (HTTP $status): [HEAD_BRANCH]"
      }
    }
  } else {
    Write-Warning "No GitHub token found in credential store — remote branch may not be deleted."
  }
}
```

Prune stale remote-tracking refs and delete the local branch:

```powershell
git fetch --prune
git branch -D [HEAD_BRANCH] 2>$null
```

> **Note:** `git branch -D` is safe to ignore if the local branch does not
> exist. `git fetch --prune` must always run to keep the local ref list clean.

Explicitly close the GitHub PR object. Because this workflow squash-merges
directly into the base branch (bypassing GitHub's native merge flow), GitHub
**will not** auto-close the PR — it must be closed explicitly.

Call `mcp__github__update_pull_request` with the repo's `owner` / `repo`,
`pullNumber: [PR_NUMBER]`, and `state: "closed"`.

> **Note:** This is a hard requirement — leaving the PR open after merging
> pollutes the repository's open PR list and causes confusion for reviewers.

Optionally, run the test suite one final time on the base branch to confirm no
regressions were introduced by the merge:

```powershell
npm test
```

---

## Step 7 — Summary Report

Post a structured summary comment to the PR (now closed) for traceability.
Call `mcp__github__add_issue_comment` with the repo's `owner` / `repo`,
`issue_number: [PR_NUMBER]` (PR comments use the issues comments endpoint),
and `body` set to:

```markdown
✅ **Merged by agent** via `/git-merge-pr`

- **Branch**: `[HEAD_BRANCH]` → `[BASE_BRANCH]`
- **Conflicts resolved**: [YES/NO — list files if YES]
- **Lint fixes applied**: [YES/NO]
- **Test fixes applied**: [YES/NO]
- **Merge strategy**: squash
```

---

## Constraint

- **Never** merge a PR that has unresolved lint errors or failing tests. Running
  a passing quality gate is mandatory before the merge commit.
- **Never** silently drop code when resolving merge conflicts. When in doubt,
  ask the operator.
- **Never** bypass required GitHub branch protection checks (required reviewers,
  required status checks). If these are blocking, surface them to the operator
  rather than attempting to force-merge.
- **Always** explicitly delete the remote head branch in Step 6 with
  `git push origin --delete [HEAD_BRANCH]`. Do **not** rely solely on the
  Step 5 merge call's `delete_branch` flag (whether passed via
  `mcp__github__merge_pull_request` or `gh pr merge --delete-branch`) — that
  flag is silently skipped when a PR auto-closes without a normal merge
  commit (e.g., duplicate rebase scenarios).
- **Always** treat a "remote ref not found" error from the delete command as a
  non-fatal, idempotent success — the branch is already gone.
- **Always** use `--force-with-lease` (never bare `--force`) when pushing
  rebased branches to avoid overwriting concurrent pushes.
- **Always** explicitly close the GitHub PR via
  `mcp__github__update_pull_request` with `state: "closed"` in Step 6 after
  branch cleanup. Because this workflow pushes directly to the base branch,
  GitHub will **never** auto-close the PR — it must be closed manually
  every time.
- **Always** post a Step 7 summary comment for auditability, even if no fixes
  were required.
