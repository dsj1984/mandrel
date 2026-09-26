# Git Conventions — Reference (on-demand)

**This rule applies when** you are reasoning about a git-history mechanic that
the always-on core [`git-conventions.md`](git-conventions.md) deliberately
summarizes: authoring a **contract change** (config/schema/lifecycle/label/API
shape), triaging a **push-hook false-negative**, resolving **shared-checkout
merge contention**, satisfying the **documentation-freshness gate**, or routing
a retrospective signal via a **`meta::*` label**. The core carries the
per-commit MUSTs; this file carries the detail behind them. Nothing here
relaxes a core MUST — read it when the matching work is in play.

## Contract Cutovers — No Shim Layer

Mandrel ships as the `mandrel` npm package, whose consumers pin an
exact lockfile version; they opt into breaks at upgrade time. Operator policy
for any contract change (config shape, baseline shape, schema, lifecycle
payload, ticket label, dispatch artifact, public API of a script) is
therefore as follows. It governs Mandrel's own framework contracts; a
consumer's product API keeps the expand–contract rule in
[`api-conventions.md`](api-conventions.md).

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

### Declaring the break so consumers see it

A hard cutover is only honest if the consumer can find out about it. Prose in
a commit body does not qualify: release-please recognizes exactly two signals,
a `!` before the colon in the subject and a `BREAKING CHANGE:` footer, and
sees nothing else. Story #5004 removed `project.commands.lintBaseline` from a
schema block that is `additionalProperties: false` — a config that used to be
silently ignored now fails validation — described it in three body paragraphs,
and shipped with neither signal. It reached `main` as `docs:` and would have
been absent from the release notes entirely.

So a contract change MUST declare itself in one of two places, and close
(`normalize-pr-title.js`) propagates either to the squash subject and PR body:

1. **A commit footer** — a `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) line in
   the body of whichever commit does the breaking. This is the default; write
   it as you write the commit. The keyword is uppercase and starts its own
   line, per Conventional Commits.
2. **A Story-body declaration** — the same footer as its own line in the Story
   issue, naturally at the end of `## Spec`. Use this when the break is known
   at plan time, or when it spans several commits and no single one owns it.

Close reads both, marks the PR title `<type>!: …`, and appends the collected
note to the PR body as a footer. Consumers whose on-disk state needs changing
should also get a step in `lib/migrations/` — see that directory's README;
`2.32.0-retire-lint-baseline-command.js` is the step #5004 should have shipped.

## Push Validation — the known false-negative signature

The core rule is: **never bypass hooks** (`--no-verify`, `--no-gpg-sign`, or
other hook-skipping flags) unless the operator explicitly authorizes it, and
if a hook fails, investigate the underlying cause. One recognized exception
signature is worth naming:

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

## Local checkout hygiene — outcome contract

**Invariant (stated in the core): the delivering flow owns tidying the local
checkout — reaping its own merged refs and fast-forwarding the base branch.
`/clean-git` is a recovery tool, not a routine chore.** The outcome every
delivering flow (`/mandrel-deliver`, `/git-deliver`) guarantees, with the mechanics
owned by `boot-sweep.js` / `clean-git.js`:

- **`main` is fast-forwarded** by the flow itself in its cleanup phase, so the
  next init seeds from a current base. No workflow ends by telling the operator
  to run `/clean-git` to catch up.
- **Merged local refs are reaped** at the next workflow boot's protected sweep
  (`boot-sweep.js`) — every local branch whose PR is already merged, skipping
  any candidate with unpushed work, a dirty worktree, or a still-open parent
  ticket. `/mandrel-plan` and `/git-deliver` widen the sweep's `--include` scope beyond
  the default `story-*` to their own branch namespaces at their boot call site.
- **Content-merged branches are report-only.** A branch detected only via the
  weaker content-equivalence signal (`detectedBy: 'content-merged'` — content
  already landed in the base by another route, with no merged PR or git
  ancestry of its own) is **never** reaped by the boot sweep; it is surfaced
  under `contentMerged` for the operator to send to `/clean-git` for a
  confirmed, eyeballed reap.
- **`/clean-git` is recovery, not routine.** Run it by hand only for a state
  the automated hygiene does not cover — triaging stashes, reaping across
  non-standard namespaces, or `--remote` pruning after a force-push. Reaching
  for it after every routine delivery signals the owning flow's hygiene step
  regressed — fix the flow, do not codify the manual sweep.

### Shared-checkout contention

**One delivery per checkout is the model.** v2 has no Epic integration branch
and no merge phase that parks the shared checkout on someone else's branch:
each Story works in its own worktree (`.worktrees/story-<id>/`) and lands by
pushing `story-<id>` and opening a PR. Two guards remain, and they cover
different hazards:

- **Per-Story lease** (`lib/orchestration/single-story-lease-guard.js`). The
  standalone path has no Epic-scoped dispatch manifest to serialize two
  operators driving the **same** Story, so `single-story-init.js` takes an
  exclusive, time-bounded lease on the Story ticket (assignee-as-lease) and
  clears it at close. It **fails closed** on a foreign assignee — there is no
  heartbeat ledger to judge staleness from — so a foreign holder always blocks
  unless you pass `--steal`, which you should do only after independently
  confirming the other run is dead.

- **Wrong-tree guard** (`lib/orchestration/single-story-close/phases/wrong-tree-guard.js`,
  Stories #3364 / #4424). `cd <workCwd>` steers the Bash tool's cwd but does
  **not** scope path-based Edit/Write tools, which resolve absolute paths and
  ignore cwd. An agent whose shell is correctly inside the worktree can still
  edit the main checkout; close then gates a clean worktree and opens a
  silent empty-diff PR. The guard inspects
  `git -C <mainCheckout> status --porcelain` and intersects stray **tracked**
  paths with the Story's own diff-path set, so a concurrent session's unrelated
  dirt does not false-positive (framework-gap #4420). Untracked files are
  ignored as scratch.

- **Recognition signature**: close aborts naming stray files in the main
  checkout that intersect the Story's diff. **Resolution**: relocate those
  edits under the worktree, restore the main checkout
  (`git -C <main-repo> checkout -- <files>`), then re-run `/mandrel-deliver <storyId>`.
  Never `git reset --hard` or `git checkout --force` to clear the way.

## Meta Labels (Retrospective Signal Routing)

Three `meta::*` labels route retrospective signals into durable substrates so
the `/mandrel-plan` Phase 0 fetcher (see
[`prior-feedback-fetcher.js`](../scripts/lib/feedback-loop/prior-feedback-fetcher.js))
can surface open feedback issues to the planner. All three live in
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

### `meta::platform-gap`

Apply this label to a GitHub issue whose fault lies in a shared base
config, runner fleet, or cross-repo toolchain that neither the framework
nor the consumer owns — the `--owner platform` bucket of
[`ci-remediation.md`](ci-remediation.md).
