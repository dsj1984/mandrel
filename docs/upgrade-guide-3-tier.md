# Upgrade Guide — 3-tier hierarchy cutover (Epic #3078)

This runbook walks consumer repositories through upgrading to the Mandrel
release that adopts the **3-tier hierarchy** (Epic → Feature → Story) and
removes the Task layer. The cutover is a single hard break at the
`.agents/` submodule boundary — there is no parallel-shape support code
in the published surface and no shim layer to migrate through. Consumers
opt in by re-pinning the submodule to the new release tag.

> **Who this is for.** Operators of any repository that consumes the
> Mandrel framework via the `.agents/` submodule. If your repo pins to a
> release strictly older than the one that ships Epic #3078, read this
> document end-to-end before bumping the submodule.

---

## What changes

The published framework drops the `type::task` ticket layer and every
piece of machinery that supported it. After the upgrade:

- **Issue tree.** `/epic-plan` produces only `type::epic`,
  `type::feature`, and `type::story` issues. Acceptance criteria and
  verification steps live inline on Story bodies; there are no child
  `type::task` issues.
- **Story execution.** `/story-deliver` runs a **single
  Story-implementation phase** per Story — no per-Task sub-loop, no
  per-Task `agent::*` transitions, no `task-commit.js` invocation.
  Commits land on the `story-<storyId>` branch directly, with the
  Conventional Commit subject referencing the Story via
  `(refs #<storyId>)` instead of the 4-tier `(resolves #<taskId>)`
  suffix.
- **Dispatch manifest.** `dispatch-manifest.json` is Story-centric:
  `waves[].stories[]` with inline acceptance/verify, not
  `waves[].tasks[]` grouped by `storyManifest[]`.
- **Removed files.** `helpers/task-execute.md`,
  `lib/templates/task-body-renderer.js`, `retrofit-task-bodies.js`,
  `lib/story-grouper.js`, `story-task-progress.js`, and `task-commit.js`
  are deleted from the published surface. Any consumer script that
  imports them must be removed or rewritten against Story-level APIs.
- **Removed config flag.** `planning.hierarchy` is deleted from
  `agentrc.schema.json` and `lib/config-settings-schema.js`. The 3-tier
  shape becomes the only shape; the flag's transitional role ends with
  this release.
- **Labels.** The `type::task` label is no longer created by bootstrap
  (`agents-bootstrap-github.js` label seeding). Existing repos still
  carry the label until the cleanup utility runs (see below).

Wave-loop semantics, parallel Story execution, the Epic-merge model
(`epic/<id>` → `main` via PR), and Feature semantics are **unchanged**.

---

## Pre-flight (do this BEFORE bumping the submodule)

The upgrade is destructive at the framework layer. Any Epic that is
mid-flight under the old shape will break the first time the new
runtime tries to dispatch one of its Stories — the `type::task` children
exist on the issue tracker but the runtime no longer understands them.
Drain in-flight Epics first.

### 1. Drain in-flight 4-tier Epics

For every Epic in your repo with status `agent::executing` (or any state
that implies open Task children):

- **Preferred:** finish the Epic on the old version. Run
  `/epic-deliver <epicId>` to completion under the currently-pinned
  release and merge the Epic PR before bumping the submodule.
- **Acceptable:** operator-abandon the Epic. Close all open child
  `type::task` issues, close the parent Story / Feature / Epic issues,
  and delete any open Story branches and worktrees (`git worktree list`
  → `git worktree remove`).

Do **not** leave open `type::task` issues parented to an Epic that is
expected to keep running after the upgrade. The new runtime has no
code path to consume them.

### 2. Communicate the break to your collaborators

The Conventional Commit subject convention changes
(`(resolves #<taskId>)` → `(refs #<storyId>)`), the `type::task` label
disappears, and any local scripts or dashboards that read
`waves[].tasks[]` from `dispatch-manifest.json` will need updates.
Notify anyone in your org who depends on those shapes.

### 3. Re-pin and bump

Bump the `.agents/` submodule to the release tag that ships Epic #3078,
commit the submodule pointer, and open a PR. CI should run cleanly on
the new shape because there are no in-flight Epics to dispatch.

---

## Post-upgrade cleanup

### 1. Remove the `type::task` label from your repo

The framework no longer creates `type::task` at bootstrap, but
pre-existing label rows in your repository persist. Use the one-shot
cleanup utility shipped by Story #3115:

```bash
# Dry-run first to see what will be removed
node .agents/scripts/cleanup-type-task-label.js --dry-run

# Apply
node .agents/scripts/cleanup-type-task-label.js
```

The utility is idempotent — running it twice is safe. It removes the
label definition from the repository and de-labels any issues that still
carry it. See
[`cleanup-type-task-label.js`](../.agents/scripts/cleanup-type-task-label.js)
for the full contract.

### 2. Update any consumer-local scripts

Search your repo for the structural references the framework no longer
recognizes:

- `type::task` (label string)
- `TYPE_LABELS.TASK` (constant import)
- `task-execute`, `task-body-renderer`, `story-task-progress`,
  `task-commit`, `retrofit-task-bodies`, `story-grouper`,
  `computeTaskWaves`, `groupTasksByStory` (deleted modules / exports)
- `waves[].tasks[]` or `storyManifest[]` (deleted manifest shapes)
- `planning.hierarchy` (deleted config flag)

Generic prose usage of the word "task" is fine. The targets above are
the framework's structural references.

### 3. Re-run `npm run verify`

On the upgraded branch, run the full verify gate:

```bash
npm run verify
```

If anything fails, the most common causes are (a) a stale
`dispatch-manifest.json` or `epic-spec.json` artifact left over from a
half-drained Epic, and (b) a consumer-local script that still imports
one of the deleted modules. Fix the call site rather than reverting the
upgrade.

---

## Release-PR major-version step (operator action)

Per [`AGENTS.md` § Major-version policy](../AGENTS.md#major-version-policy),
release-please-config.json sets `"versioning": "always-bump-minor"`,
which caps automatic bumps at the minor axis even when commits carry
`BREAKING CHANGE:` footers. Epic #3078 carries `BREAKING CHANGE:` on
its destructive Feature 8 landing and warrants a **major** version bump.

When release-please opens the release PR for the cycle that includes
Epic #3078:

1. Confirm the PR's auto-generated `docs/CHANGELOG.md` entry includes
   the Epic #3078 removal notice (the Unreleased section authored in
   Story #3116 should roll forward into the release section).
2. Manually edit the release PR to bump the major version:
   - `package.json` → set `"version": "X.0.0"` (where `X` is the new
     major).
   - `.agents/VERSION` → set the same version string.
   - `docs/CHANGELOG.md` → move the Unreleased block under a new
     `## X.0.0 — YYYY-MM-DD` heading and re-open an empty Unreleased
     block above it.
3. Alternatively, land a one-shot commit on `main` with
   `Release-As: X.0.0` in the trailer **before** the release PR opens;
   release-please will adopt that as the proposed version on its next
   run.

The cap is intentional — it prevents an inadvertent `BREAKING CHANGE:`
footer from auto-tagging a major release without an explicit human
decision.

---

## Known follow-on

Epic #3078's destructive Feature 8 deleted the leaf Task-tier surface
(`task-execute.md`, `task-commit.js`, `retrofit-task-bodies.js`,
`story-task-progress`) but **deferred the producer-side rewrite** that
synthesises Task tickets during planning/decompose/spec-render. As a
result, two helpers still ship and three production import sites still
reference them:

- `.agents/scripts/lib/orchestration/story-grouper.js` (exports
  `groupTasksByStory`, still imported by `manifest-builder.js`).
- `.agents/scripts/lib/templates/task-body-renderer.js` (exports
  `composeTaskBody`, still imported by `epic-spec-reconciler-diff.js`
  and `providers/github/tickets.js`).
- 12 producer-side tests across 6 files are parked behind
  `describe.skip(...)` pending the rewrite.

The remaining work is tracked in **follow-on Epic #3163**. Consumers
on v6.x see the 3-tier execution path end-to-end (no `type::task`
issues are created, `/story-deliver` runs a single phase) — the
deferred work is internal cleanup that does not change the runtime
contract.

> **Resolved.** The deferred producer rewrite landed via Epic #3163's
> closing PR [#3216](https://github.com/dsj1984/mandrel/pull/3216):
> `story-grouper.js` and `task-body-renderer.js` are deleted, every
> producer/presentation/CLI import site is rewritten for the 3-tier
> hierarchy, and the parked producer-side tests are reinstated. A
> repo-wide grep for the canonical Task-tier symbols now returns zero
> structural hits outside the `cleanup-type-task-label.js` consumer
> utility and this historical note.

---

## References

- Epic #3078 — Collapse Task level: adopt 3-tier hierarchy
- Follow-on Epic #3163 — Complete Task-tier producer rewrite
- Story #3104 (this story) — CHANGELOG draft + major-version preparation
- Story 7.1 cleanup utility:
  [`cleanup-type-task-label.js`](../.agents/scripts/cleanup-type-task-label.js)
- Hard-cutover policy: [`.agents/rules/git-conventions.md` § Contract Cutovers — No Shim Layer](../.agents/rules/git-conventions.md)
- Hard-cutover precedent: Epic #2646 (Hard-Cutover Cleanup Epic)
- Major-version policy: [`AGENTS.md` § Major-version policy](../AGENTS.md#major-version-policy)
