# Git & Version Control Conventions

This rule applies globally to all repository changes to maintain a clean git
history.

## Canonical Branching (v5 Orchestration)

### Epic Base Branch

Each Epic operates on a dedicated **Epic base branch** named `epic/[EPIC_ID]`
(e.g., `epic/98`). This branch is created from the project's base branch
(`main` by default) and serves as the integration target for all Stories
within that Epic.

### Story-Level Branching

All tasks within a Story MUST be committed to a shared **Story branch**:
`story-<storyId>` (e.g., `story-104`). The runtime owns Story branch
creation via `story-init.js`; agents commit on the active Story branch only.

## Conventional Commits

- MUST adhere to Conventional Commits format:
  `<type>(<optional scope>): <description>`
- Types allowed: `feat:`, `fix:`, `perf:`, `refactor:`, `revert:`, `docs:`,
  `style:`, `chore:`, `test:`, `build:`, `ci:`. This list mirrors the
  `changelog-sections` in `release-please-config.json`; keep the two in
  sync when adding a type.
- Description must be in the imperative mood (e.g., "add feature", not
  "adds" or "added").
- **Local enforcement**: the `commit-msg` Husky hook runs `commitlint`
  against every local commit (`.husky/commit-msg` →
  `commitlint --edit "$1"`, config in `commitlint.config.js`). A
  non-conventional subject fails the hook and no commit is created. Do not
  bypass with `--no-verify`. The hook does **not** run on squash-merge
  titles edited in the GitHub UI; author the PR title in conventional form
  so the squash commit on `main` parses cleanly for release-please.

## Push Validation & Reliability

To prevent "silent" push failures (e.g., hidden by multi-command chains or
rejected by `pre-push` hooks):

1.  **Local Validation**: Run the project's configured validation commands
    (`agentSettings.commands.validate` and `agentSettings.commands.test` in
    `.agentrc.json`, or the equivalent format-check command) locally
    _before_ attempting a `git push`.
2.  **Verify Push Output**: Do NOT assume a push succeeded unless the output
    explicitly confirms the remote ref was updated (`[new branch]`,
    `[up to date]`, or `... -> ...`).
3.  **Handle Rejections**: If a push is rejected by a `pre-push` hook, fix
    the underlying issue (usually formatting or linting) and create a NEW
    follow-up commit. Do **not** amend the rejected commit — amending makes
    diffs harder to review and can lose work if the original commit
    contained more than the linting fix.
4.  **Never bypass hooks**: Do not use `--no-verify`, `--no-gpg-sign`, or
    other hook-skipping flags unless the operator explicitly authorizes it.
    If a hook fails, investigate the underlying cause.

## Meta Labels (Retrospective Signal Routing)

Two `meta::*` labels route retrospective signals into durable substrates so
the `/epic-plan` Phase 0 fetcher (see
[`prior-feedback-fetcher.js`](../scripts/lib/feedback-loop/prior-feedback-fetcher.js))
can surface open feedback issues to the planner. Both labels live in
[`label-constants.js`](../scripts/lib/label-constants.js) under the
`META_LABELS` export — reference them by symbol from scripts rather than
hard-coding the string.

### `meta::framework-gap`

Apply this label to a GitHub issue that surfaces a defect, missing
capability, or weak ergonomic in the **framework itself** (anything under
`.agents/` or the dispatcher engine). Typical sources: a retrospective that
identifies a workflow that does not yet exist, a hook that should fire but
does not, or a script-level usability problem that should be solved
upstream rather than worked around in a consumer project.

### `meta::consumer-improvement`

Apply this label to a GitHub issue that surfaces an improvement that lives
in a **consumer project** (workflow tweaks, ergonomic asks, doc polish, or
project-local automation). The work is scoped to the consumer's
`.agents/`-driven layer or the consumer's own codebase, not to upstream
framework changes. Issues that span both axes should carry both labels —
`fetchPriorFeedback` dedupes by issue number so a dual-labeled issue
appears exactly once in the planner context.

## Pull Requests

- Never commit `.env` or hardcoded secrets.
- Always include a short description of _why_ the change was made in the PR
  body.
- **Reference Issues**: Use "Resolves #109" or "Closes #114" to link
  tickets.
