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
    - **Known false-negative signature**: a `pre-push`/`pre-commit` failure
      whose message is a _zero-match_ error (e.g. Biome's
      `No files were processed in the specified paths`) rather than a
      reported violation, combined with an agent CWD under a harness-managed
      worktree path a consumer's lint config ignores (e.g.
      `.claude/worktrees/<name>/` against a `files.includes` glob like
      `"!**/.claude"`), is a **consumer-tooling gap**, not a real lint
      failure. It does not authorize `--no-verify`. See
      [`worktree-lifecycle.md` § Harness-worktree ⇄ consumer-lint-ignore interaction](../workflows/helpers/worktree-lifecycle.md#harness-worktree-consumer-lint-ignore-interaction-story-152)
      for the recognition signature and the sanctioned consumer-side fix
      (`--no-errors-on-unmatched` or equivalent) before escalating via
      `agent::blocked`.

## Local checkout hygiene

**Invariant: the delivering flow owns tidying the local checkout — reaping its
own merged refs and fast-forwarding the base branch. `/git-cleanup` is a
recovery tool, not a routine chore.**

Every flow that lands work — `/deliver` (Epic and standalone-Story paths),
`/git-deliver` — is responsible for leaving the local checkout tidy without
operator intervention:

- **Fast-forwarding the base branch is owned by the flow.** The standalone
  multi-Story path fast-forwards `main` itself in its summary phase (via
  `git-cleanup.js --fast-forward-main --execute --yes`); the Epic path
  fast-forwards `epic/<id>` / `main` on its merge-and-reap beat. No workflow
  ends by telling the operator to "run `/git-cleanup` afterwards to catch up".
- **Reaping merged local refs is owned by the flow's next boot.** `/plan` and
  `/git-deliver` open with a **protected boot sweep**
  (`boot-sweep.js`) that fast-forwards `main`, prunes stale remote-tracking
  refs, and reaps every local branch whose PR is already merged — skipping any
  candidate with unpushed work, a dirty worktree, or a still-open parent
  ticket. A branch a flow leaves behind (e.g. a `/git-deliver` feature branch
  whose PR merges out of band) is therefore reaped automatically at the next
  workflow boot, not left for the operator to sweep by hand. `boot-sweep.js`
  defaults its `--include` glob to `story-*` — a bare invocation only sweeps
  Story branches; `/plan` and `/git-deliver` widen the scope to their own
  branch namespaces (`epic/*`, `feat/*`, `fix/*`, `chore/*`, `docs/*`,
  `refactor/*`) by passing `--include` explicitly at their boot call site.
  A branch the planner detects only via the weaker content-equivalence
  signal (`detectedBy: 'content-merged'`, Story #4395's
  `git merge-tree --write-tree` probe — content already landed in the base
  branch by another route, such as a squash-merged Epic PR, with no merged
  PR or git ancestry of its own) is **never** reaped by the boot sweep: it
  is report-only, surfaced under `contentMerged` in the result envelope and
  a routing hint in the summary line (Story #4396), so the operator can
  send it to `/git-cleanup` for a confirmed, eyeballed reap.
- **`/git-cleanup` is recovery, not routine.** Run it by hand only to recover
  an unusual state the automated hygiene does not cover — triaging stashes,
  reaping across non-standard branch namespaces, or `--remote` pruning after a
  force-push diverged a tip. It is **not** the expected way to keep `main`
  current or to clear merged branches after a normal delivery; the delivering
  flows already own that. If you find yourself reaching for `/git-cleanup`
  after every routine `/deliver` or `/git-deliver` run, that is a signal the
  owning flow's hygiene step regressed — fix the flow, do not codify the manual
  sweep.

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
