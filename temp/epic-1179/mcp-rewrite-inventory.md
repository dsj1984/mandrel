# MCP Rewrite Inventory — Epic #1179, Story #1365

Source story: #1365 "Audit and rewrite single-REST-call agent instructions to MCP"

## Inclusion rule

A site is in scope **only** if all three of the following hold:

1. The instruction is read by an **agent inside a conversation** (not by a
   Node script process and not by a GitHub Actions CI job).
2. The instruction's effect is a **single REST call** that the
   `mcp__github__*` server exposes as a one-shot tool.
3. The agent has no reason to retain the script/CLI plumbing (no JSON
   post-processing the agent itself needs, no shell-only flag like
   `--watch` / `--log-failed` that has no MCP equivalent).

## Exclusions (multi-step orchestration scripts — NOT rewritten)

The following workflow invocations remain Node script calls. Each wraps
multi-step orchestration logic with its own state file, label cascade,
provider-side validation, or worktree management; collapsing them into
`mcp__github__*` would lose semantics the script enforces.

| Script | Reason script invocation stays |
| --- | --- |
| `epic-plan.js`, `epic-plan-spec.js`, `epic-plan-decompose.js`, `epic-plan-healthcheck.js` | Multi-pass planning + ticket decomposition. Reads PRD/Tech-Spec, fans out child issue creation, writes planner-context.json. Not a single REST call. |
| `epic-deliver-prepare.js`, `epic-deliver-runner.js`, `epic-deliver-finalize.js`, `epic-deliver-cleanup.js`, `epic-deliver-automerge.js`, `epic-deliver-note-intervention.js` | Phased pipeline (push + PR open + required-checks config + auto-merge + cleanup). Each phase touches multiple endpoints + local git + ticket cascade. |
| `dispatcher.js` | Concurrency-capped fan-out across stories with adaptive rate-limit handling. |
| `story-init.js`, `story-close.js`, `story-execute-prepare.js`, `story-task-progress.js`, `task-commit.js` | Worktree create/reap, dependency-install, batch label transitions, structured-comment upsert. Each is a full sub-pipeline. |
| `ticket-decomposer.js`, `epic-planner.js`, `epic-close.js`, `epic-code-review.js`, `epic-execute-record-wave.js` | Multi-issue mutators or analyzers with cascade semantics. |
| `notify.js`, `post-structured-comment.js`, `update-ticket-state.js`, `hydrate-context.js` | Channel-fan-out (webhook + comment + label cascade) or marker-aware upsert / cache-aware label flip — not equivalent to a bare REST call. |
| `delete-epic-branches.js`, `delete-epic.js`, `drain-pending-cleanup.js`, `diagnose.js`, `diagnose-friction.js`, `analyze-execution.js`, `evidence-gate.js`, `wave-gate.js`, `validate-docs-freshness.js`, `retrofit-task-bodies.js`, `noise-study.js`, `audit-orchestrator.js`, `select-audits.js`, `run-audit-suite.js`, `handle-approval.js`, `context-hydrator.js`, `hierarchy-gate.js` | Multi-step orchestrators or local-only utilities (no GitHub call, or many GitHub calls fused with local state). |
| `agents-bootstrap-github.js`, `agents-bootstrap-project.js` | Idempotent label-taxonomy + project-field + branch-protection bootstrap; not a single REST call. |
| `git-rebase-and-resolve.js`, `git-pr-quality-gate.js`, `detect-merges.js`, `assert-branch.js`, `check-maintainability.js`, `check-crap.js`, `check-coverage-baseline.js`, `check-windows-git-perf.js`, `quality-preview.js`, `quality-watch.js`, `coverage-capture.js`, `run-coverage.js`, `update-coverage-baseline.js`, `update-crap-baseline.js`, `update-maintainability-baseline.js`, `lint-baseline.js`, `sync-claude-commands.js`, `update-self.js`, `test-wrapper.js`, `render-manifest.js` | Local git / quality / build operations — no GitHub REST at all. |

## Skill files

`grep -E 'node \.agents/scripts/[a-z-]+\.js' .agents/skills/**` matches **zero** SKILL.md files: skills delegate to workflows that delegate to scripts. There is therefore no skill-side script-invocation to rewrite.

The single `gh` usage inside any SKILL.md
(`.agents/skills/stack/qa/lighthouse-baseline/SKILL.md` line 139) is embedded inside a **CI YAML example block** running `gh pr create` from GitHub Actions, not an agent-side instruction. Out of scope.

## In-scope rewrites

Every row's "Current instruction" is an agent-issued `gh` shell command in a workflow markdown file. The "MCP equivalent" is the `mcp__github__*` tool the agent should call instead. "Justification" cites the single-REST-call rule.

| Workflow path | Current instruction | MCP equivalent | Justification |
| --- | --- | --- | --- |
| `.agents/workflows/git-merge-pr.md` line 31 (Step 0.3) | `gh pr view [PR_NUMBER] --json number,title,headRefName,baseRefName,state,mergeable,mergeStateStatus` | `mcp__github__pull_request_read` (method: `get`) — request the same fields and pull `headRefName`, `baseRefName`, `state`, `mergeable`, `mergeStateStatus` from the response | Single `GET /repos/{owner}/{repo}/pulls/{pull_number}` — agent is the natural caller; no shell post-processing needed. |
| `.agents/workflows/git-merge-pr.md` line 158 (Step 4) | `gh pr view [PR_NUMBER] --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup` | `mcp__github__pull_request_read` (method: `get`) — read `mergeable`, `mergeStateStatus`, `reviewDecision`, `statusCheckRollup` from the response (`get_status_checks` sub-method exists if a focused rollup is wanted, but `get` returns the same fields) | Single `GET /repos/{owner}/{repo}/pulls/{pull_number}`; same as Step 0.3 — second read after the rebase. |
| `.agents/workflows/git-merge-pr.md` line 181 (Step 5) | `gh pr merge [PR_NUMBER] --auto --squash --delete-branch` | `mcp__github__merge_pull_request` (method: `merge`, `merge_method: "squash"`, `delete_branch: true`) | Single `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` — agent is the caller. Note: MCP does not currently expose `auto_merge` enablement; downgrade to immediate squash when calling via MCP — the upstream effect (`squash --delete-branch`) is preserved. If auto-merge queueing is required, fall back to `gh pr merge --auto --squash --delete-branch`. |
| `.agents/workflows/git-merge-pr.md` lines 278-288 (Step 6, "Close PR" JS pseudo-call) | Malformed pseudo-call `mcp_github-mcp-server_update_pull_request({...})` | `mcp__github__update_pull_request` with `state: "closed"` | Already an MCP intent; the typo / namespacing is fixed to the actual tool name. Single `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` — agent is the caller. |
| `.agents/workflows/git-merge-pr.md` line 307 (Step 7) | `gh pr comment [PR_NUMBER] --body "..."` | `mcp__github__add_issue_comment` (PR comments use the issues comments endpoint; pass the PR number as the `issue_number`) | Single `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` — agent is the caller. |
| `.agents/workflows/git-merge-pr.md` lines 233-262 (Step 6 fallback) | PowerShell `Invoke-RestMethod -Method DELETE` against `/git/refs/heads/[HEAD_BRANCH]` | **Stay as-is** — MCP github surface does **not** expose `DELETE /git/refs/{ref}`; `mcp__github__delete_file` deletes files, not refs. Wrap-around remains the only path until MCP coverage exists. | Rule (3) — no MCP equivalent. Documented here so the apply-task does not attempt a rewrite. |
| `.agents/workflows/git-merge-pr.md` line 50 (Step 1) | `gh pr diff [PR_NUMBER]` | **Stay as-is** — MCP does not expose a raw-unified-diff endpoint (`mcp__github__pull_request_read` `get_diff` returns the diff but as a structured response rather than the raw shell text the workflow surface assumes). | Edge case: keep the shell call so the agent can read the diff as plain text. Documented here as a deliberate non-rewrite. |

## Files touched by the apply task (#1385)

- `.agents/workflows/git-merge-pr.md` — five rewrites (Step 0.3, Step 4, Step 5, Step 6 update_pull_request, Step 7); two deliberate non-rewrites (Step 1 `gh pr diff`, Step 6 PowerShell branch-delete fallback) annotated in-line.

No other workflow file requires changes for this Story. The other `gh`
references in workflows are either:

- references **inside narrative prose** describing what the orchestrator
  script does (e.g., `epic-deliver.md` line 394 explains that
  `epic-deliver-finalize.js` calls `gh pr merge ... --auto`), not
  instructions the agent runs;
- shell-only watch / log commands with no MCP equivalent (`gh pr checks
  --watch`, `gh run view --log-failed` in `epic-deliver.md` Phase 7); or
- inside CI YAML examples (`lighthouse-baseline` SKILL.md).
