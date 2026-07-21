# Git & Version Control Conventions

This rule applies globally to all repository changes to maintain a clean git
history. It is the **always-on core**: branch shapes, the Conventional-Commit
subject contract, issue references, and the non-negotiable push/hygiene MUSTs.

Deeper mechanics — the hard-cutover contract policy, the push-hook
false-negative signature, shared-checkout merge contention, the
documentation-freshness gate, and the `meta::*` retrospective-routing labels —
live in the on-demand
[`git-conventions-reference.md`](git-conventions-reference.md). Read that file
**before** doing the matching work; the core below is sufficient for every
routine commit, branch, and PR.

## Canonical Branching (v2)

### Story branch → PR → main

Every Story lands on a dedicated **Story branch** named `story-<storyId>`
(e.g., `story-104`), seeded from `project.baseBranch` (`main` by default).
The runtime owns branch creation via `single-story-init.js`; agents commit
on that branch only. Close opens a PR against `main` (squash + required
checks). There is no `epic/<id>` integration branch and no `--no-ff`
wave merge.

> **Commit subjects.** Stories have no child tickets. Commits land on
> `story-<storyId>` directly from the agent and the Conventional Commit
> subject references the Story via `(refs #<storyId>)`. See
> [`.agents/instructions.md` § 5.D](../instructions.md) for the hierarchy
> contract.

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
    If a hook fails, investigate the underlying cause. One recognized
    exception — a Biome _zero-match_ failure under a harness-managed
    worktree path the consumer's lint config ignores — is a consumer-tooling
    gap, **not** authorization to skip the hook; its recognition signature
    and sanctioned fix live in
    [`git-conventions-reference.md` § Push Validation](git-conventions-reference.md).

## Local checkout hygiene

**Invariant: the delivering flow owns tidying the local checkout — reaping its
own merged refs and fast-forwarding the base branch. `/git-cleanup` is a
recovery tool, not a routine chore.**

Every flow that lands work — `/deliver` (Epic and standalone-Story paths),
`/git-deliver` — leaves the local checkout tidy without operator
intervention: it fast-forwards the base branch itself, and reaps its own
merged local refs on the next workflow boot (the `boot-sweep.js` protected
sweep). Do **not** end a workflow by telling the operator to run
`/git-cleanup` to catch up; `/git-cleanup` is for recovering an unusual state
the automated hygiene does not cover. The boot-sweep scope rules, the
content-merged report-only case, and the shared-checkout merge-contention
guard are detailed in
[`git-conventions-reference.md` § Local checkout hygiene](git-conventions-reference.md).

## Pull Requests

- Never commit `.env` or hardcoded secrets.
- Always include a short description of _why_ the change was made in the PR
  body.
- **Reference Issues**: Use "Resolves #109" or "Closes #114" to link
  tickets.
