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

> **Commit subjects.** Under the 2-tier hierarchy
> (Epic → Story), Stories have no child tickets. Commits
> land on `story-<storyId>` directly from the agent and the
> Conventional Commit subject references the parent Story via
> `(refs #<storyId>)`. See
> [`.agents/instructions.md` § 5.D](../instructions.md) for the
> full hierarchy contract.

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

## Contract Cutovers — No Shim Layer

Mandrel ships as the `mandrel` npm package, whose consumers pin an
exact lockfile version; they opt into breaks at upgrade time. Operator policy
for any contract change (config shape, baseline shape, schema, lifecycle
payload, ticket label, dispatch artifact, public API of a script) is
therefore:

1. **Hard cutovers only.** Contract changes ship as a single in-tree
   migration of every producer and consumer. There is no parallel
   old-shape support code, no read-side tolerance branch, and no
   feature flag that toggles between the two shapes.
2. **The PR diff IS the migration.** A consumer upgrading to a release
   with the change adopts the new shape by upgrading the
   `mandrel` package (`mandrel update`). The PR that lands on
   `main` already moved every internal call site; consumers move on the
   same beat by upgrading.
3. **No deprecation ledger, no version-windowed sunsets.** The framework
   does not track "to be removed in vX.Y" entries or run two shapes side
   by side for a release window. If a shape changes, the old shape is
   deleted in the same PR.

The codifying decision is **Epic #2646** (the "Hard-Cutover Cleanup Epic"),
which deleted the existing compatibility shim layer across
`config-resolver.js`, `lib/config/*.js`, `lib/baselines/`,
`wave-session.js`, `IExecutionAdapter` / `ManualDispatchAdapter`, lifecycle
emit shims, and duplicate progress/comment writers in one pass. The
per-finding closing references (audit Findings #10, #11, #13, #17) live in
the merged PRs and the Epic #2646 history; the standing forward-looking
audit lives at [`docs/roadmap.md`](../../docs/roadmap.md) (Part 1 — Model-Evolution Audit).

Practical guidance when authoring a contract change:

- If you are tempted to add a "legacy shape" branch in a parser or
  resolver, **don't** — update every call site instead, and delete the
  old shape in the same PR.
- If you cannot land every call site in a single PR (e.g. a
  cross-repository change), the contract change is too large for one
  hard cutover. Split the contract itself, not the rollout.
- Schema versions remain useful as **identifiers** (so a future consumer
  can detect "I cannot read this artifact"); they are **not** an
  invitation to keep multiple readers alive in the same release.

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
the `/plan` Phase 0 fetcher (see
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
