---
description: >-
  Final Epic closure — merge the Epic base branch to main, close the Epic issue
  via GitHub provider, clean up branches, and post the retrospective.
---

# Sprint Close

This workflow is the **terminal step** of the Epic lifecycle. It promotes the
fully integrated and reviewed `epic/<epicId>` branch into `main`, closes the
Epic GitHub issue, cleans up all sprint branches, and posts the retro.

The workflow is organised around **seven phases** — Feature Completeness,
Documentation Freshness, Code Review, Pre-Merge Validation, Merge to Main,
Retro, Finalize, Notify. Each phase is a cohesive checkpoint: skipping ahead
strands partial state on GitHub, so run them in order.

> **When to run**: As soon as all child work is closed. `/sprint-close`
> auto-invokes the mandatory pre-merge gates (the `helpers/epic-code-review.md`
> module in the Code Review phase and `helpers/epic-retro.md` in the Retro
> phase) when they have not already been completed, so operators no longer
> need to run them by hand.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

## Step 0 — Resolve Configuration

1. Resolve `[EPIC_ID]` — the GitHub Issue number of the Epic to close.
2. Resolve `[EPIC_BRANCH]` — `epic/<epicId>`.
3. Resolve `[BASE_BRANCH]` from `baseBranch` in `.agentrc.json` (default:
   `main`).
4. Resolve `[SCRIPTS_ROOT]` from `paths.scriptsRoot` in `.agentrc.json`
   (default: `.agents/scripts`).
5. Resolve `[RELEASE_CONFIG]` — the `release` object from `.agentrc.json`:
   - `release.docs` — array of file paths to verify (e.g.,
     `["README.md", "docs/CHANGELOG.md"]`). Defaults to `[]`.
   - `release.versionFile` — path to a plain-text version file (e.g.,
     `.agents/VERSION`). Defaults to `null`.
   - `release.packageJson` — boolean; if `true` the version in the root
     `package.json` is also bumped. Defaults to `true`.
   - `release.autoVersionBump` — boolean; if `true` (default) the agent
     automatically determines whether to bump the **minor** or **patch** segment
     based on the scope of changes in the Epic. If `false`, no automatic version
     bump is performed (the operator must bump manually or specify the segment
     at invocation time).
6. Resolve `[ALL_DOCS]` — the combined array of documentation files to verify:
   - All files listed in `release.docs`.
   - All files listed in `agentSettings.docsContextFiles` (prefixed with the
     path from `agentSettings.paths.docsRoot`).
7. Resolve `[RUN_RETRO]` from `agentSettings.epicClose.runRetro` in
   `.agentrc.json` (default: `true`). When `false`, the Retro phase is
   skipped entirely — no retro is required or produced. The legacy
   `agentSettings.sprintClose.runRetro` key is read as a fallback with a
   one-line `Logger.warn(...)` deprecation; remove it from your config to
   silence the warning. The shim is scheduled for removal in 5.32.0 — see
   `docs/deprecation-register.md`.

---

## Phase 1 — Feature Completeness Check

Prove every piece of planned and adjacent work is closed before running any
git operations. This phase combines two complementary gates: one over the
frozen sprint manifest, one over the live GitHub sub-issue graph. Both must
pass.

### 1.1 Wave Completeness Gate

Every Story in the Epic's frozen dispatch manifest must be closed, along with
every open recut and every parked follow-on. The manifest lives as a
`dispatch-manifest` structured comment on the Epic — `/sprint-plan` and every
subsequent dispatcher run refresh it, so it is the single source of truth for
"which Stories did the sprint actually commit to?"

```powershell
node [SCRIPTS_ROOT]/wave-gate.js --epic [EPIC_ID]
```

If the script exits non-zero: **STOP IMMEDIATELY.** The output lists every
manifest Story, recut, and parked follow-on that is still open, with its wave
and title. Close or re-dispatch the outstanding work before re-running
`/sprint-close`. Pass `--allow-parked` / `--allow-open-recuts` to waive once
the operator has deliberately deferred the follow-on work.

> If `temp/dispatch-manifest-<epicId>.{md,json}` has drifted or was lost,
> regenerate it from the structured comment (the SSOT) via:
>
> ```powershell
> node [SCRIPTS_ROOT]/render-manifest.js --epic [EPIC_ID]
> ```

### 1.2 Hierarchy Completeness Gate

Every descendant under the Epic in GitHub's sub-issue graph must be closed.
Where the wave gate looks at the manifest (planned work), the hierarchy gate
looks at the live graph (planned **plus** orphan / mid-sprint / context
tickets). Both checks are intentionally distinct — the manifest can omit a
ticket the Epic still owns, and the graph can omit a parked Story that lives
outside the Epic.

```powershell
node [SCRIPTS_ROOT]/hierarchy-gate.js --epic [EPIC_ID]
```

The gate enforces:

1. **Tasks** — closed AND carry `agent::done`.
2. **Stories** — closed.
3. **Features** — closed.

Auxiliary tickets (`context::prd`, `context::tech-spec`, `type::health`)
are intentionally **deferred** here — Phase 7 (`epic-close.js`) closes
them automatically as part of the same workflow run, so failing the gate
on them would block every Epic.

If ANY planned descendant is still open, the script exits non-zero and
lists every open id. **STOP IMMEDIATELY** and resolve the open work
before re-running `/sprint-close`.

---

## Phase 2 — Documentation Freshness Check

Every doc in `[ALL_DOCS]` must reference the Epic. A file passes when
**either** a commit touching it mentions `#[EPIC_ID]` in its message, **or**
the file's current body mentions `#[EPIC_ID]`. A pure-whitespace or unrelated
diff does not satisfy the gate.

```powershell
node [SCRIPTS_ROOT]/validate-docs-freshness.js --epic [EPIC_ID]
```

Add `--json` to receive a structured `{ ok, epicId, results: [...] }` payload
on stdout — useful when the LLM wants to enumerate failing files
programmatically rather than parse the log output.

```powershell
node [SCRIPTS_ROOT]/validate-docs-freshness.js --epic [EPIC_ID] --json
```

For every failing file, open it, review the Epic's completed tickets
(title + description), and add or update the relevant sections to reflect the
shipped changes. Then stage and commit with a message that cites the Epic:

```powershell
git add [DOC_PATH]
git commit -m "docs([DOC_PATH]): update for Epic #[EPIC_ID]"
```

Re-run the gate until it exits 0.

> **CHANGELOG style contract.** When updating `docs/CHANGELOG.md` (or the
> project-equivalent) follow
> [`.agents/rules/changelog-style.md`](../rules/changelog-style.md): 1–3
> sentence theme paragraph, bullets of user-visible changes only, no internal
> file paths or symbol names, mandatory prominence for breaking changes and
> config/CLI shape changes, soft ceiling of ≤60 lines per non-major release
> (≤150 for major). The rule includes a before/after worked example.
>
> **Guidance for consuming projects:** Add every file your release process
> requires to `release.docs` or `agentSettings.docsContextFiles` in
> `.agentrc.json`. Common examples: `README.md`, `docs/CHANGELOG.md`,
> `MIGRATION.md`, `API.md`.

---

## Phase 3 — Code Review

Establish the post-hoc code-review record on the Epic. The Code Review phase
runs the [`helpers/epic-code-review.md`](helpers/epic-code-review.md)
module, which performs the static analysis **and** persists its findings as a
`code-review` structured comment on the Epic (via `upsertStructuredComment`).
That comment is the durable audit trail — subsequent retros, incident
reviews, and compliance checks read back from it.

### 3.1 Auto-invoke the code-review helper

1. Follow the procedure in
   [`helpers/epic-code-review.md`](helpers/epic-code-review.md) inline for
   `[EPIC_ID]` (read-only audit mode — no remediation).
2. Inspect the resulting findings:
   - **Any 🔴 Critical Blocker** — STOP. Relay the blockers to the operator
     and do not proceed to Phase 4. The operator decides whether to fix on
     the Epic branch and re-run `/sprint-close`, or to override explicitly.
   - **Only 🟠/🟡/🟢 findings** — log them as "non-blocking review findings"
     and continue. The full report is already persisted on the Epic.
3. If the operator passes `--skip-code-review` at invocation time, skip this
   step and log `code review skipped by operator override`.

> **Why auto-invoke:** The prior gate assumed the code review had been run
> out-of-band and stopped when it couldn't detect evidence. Because the
> review now upserts a structured comment, the gate detects prior runs
> reliably — but keeping the auto-invoke collapses the round-trip when the
> review has not yet been written.

---

## Phase 4 — Pre-Merge Validation

Run the full lint + test suite on the Epic branch before any merge to
`[BASE_BRANCH]`. This is the only build gate this workflow runs before push.
Pre-push hooks may enforce additional ratcheted gates (lint baselines,
complexity baselines, design-token audits, etc.) that this phase does not
run — see 4.1.

Use the **evidence-aware gate wrapper** so identical re-runs against an
already-validated tree are skipped. Each successful run is recorded under
`temp/validation-evidence-[EPIC_ID].json` (gitignored); the next caller
skips when `git rev-parse HEAD` and the resolved command-config still match.

```powershell
node .agents/scripts/evidence-gate.js --scope-id [EPIC_ID] --gate lint -- npm run lint
node .agents/scripts/evidence-gate.js --scope-id [EPIC_ID] --gate test -- npm test
```

Append `--no-evidence` to either invocation to force a re-run regardless of
recorded state (e.g., when iterating on a flaky test). If either command
fails: **STOP**. Fix the regressions on a hotfix branch and merge back into
the Epic branch before restarting this workflow.

> **Operator reminder.** Phase 4 is now load-bearing on the SHA-keyed
> evidence wrapper — if a phase upstream (story-close, sprint-code-review)
> has already validated the current `HEAD`, this phase skips in
> milliseconds. When a flaky test slipped past upstream and you need a
> forced re-run, `--no-evidence` is the explicit override. Pre-push hooks
> and CI never read the evidence file, so independent verification is
> never bypassed by setting (or clearing) the local evidence record.

### 4.1 Refresh ratcheted baselines before push

**Principle.** Any baseline or audit ratchet enforced by the project's
pre-push hook MUST be refreshed on the Epic branch *before* Phase 5.4
push. The evidence-aware gate above runs `npm run lint` + `npm test`
only — it does not invoke project-extended ratchets. If a ratchet drifts
and is not refreshed here, the push at 5.4 fails *after* the merge into
`[BASE_BRANCH]` has already landed locally, and the operator is forced
to land the fix as a follow-on commit on `[BASE_BRANCH]` rather than on
the Epic branch where it belongs.

**Common ratchet categories** (consuming projects map their concrete
commands onto these):

- **Lint baselines** — ratchets that fail the push when warning/error
  counts exceed a persisted snapshot.
- **Complexity / maintainability baselines** — e.g., maintainability
  index, cyclomatic complexity, CRAP score thresholds.
- **Design-token / brand-token audits** — checks that source files use
  approved tokens rather than raw values.
- **Dependency audits** — `npm audit`-style gates with a pinned
  severity threshold.
- **Custom build-output size budgets** — bundle / asset size ceilings
  enforced at push time.

**Procedure.** Open `package.json` and inspect the scripts referenced
from `.husky/pre-push` (or the project's equivalent push hook). Run
each ratcheted script against the Epic branch. If any ratchet drifts,
refresh the baseline file on the Epic branch and commit it as:

```powershell
git commit -m "chore(baselines): refresh <name> for Epic #[EPIC_ID]"
```

so the merge into `[BASE_BRANCH]` passes the pre-push hook on first
push at Phase 5.4.

---

## Phase 5 — Merge to Main

Bump the version (if configured), merge the Epic branch into `[BASE_BRANCH]`,
scan the merge for conflict markers, and push.

### 5.1 Version Bump

If `release.autoVersionBump` is `false`, **skip this step entirely** and
proceed to 5.2.

If `release.autoVersionBump` is `true` (default) **and** at least one of
`release.versionFile` or `release.packageJson` is configured, increment the
project version **before** the merge to `[BASE_BRANCH]`. The version file is
read at runtime by context hydration (`{{PROTOCOL_VERSION}}`), so it must
land with the Epic.

1. **Read** the current version string from `[RELEASE_CONFIG].versionFile` (if
   set) or `package.json#version`.
2. **Determine the bump segment** by inspecting the Epic's completed tickets:
   - **minor** — new user-facing features, new workflows, new CLI commands,
     new API surfaces, or significant behavioural changes.
   - **patch** — bug fixes, documentation updates, refactors, dependency
     bumps, or internal tooling changes with no user-facing feature
     additions.
   - The operator may override at invocation time (e.g., "use major").
3. **Calculate** the next version by incrementing the chosen segment
   (`major.minor.patch`).
4. **Write** the new version:

```powershell
# If release.versionFile is set:
# Write the new version string to that file (overwrite contents).

# If release.packageJson is true (default):
npm version [BUMP_SEGMENT] --no-git-tag-version
```

1. **Commit** the version bump:

```powershell
# Guard: confirm we're on the Epic branch before committing the bump.
node .agents/scripts/assert-branch.js --expected epic/[EPIC_ID]

# Stage only the version-bump artefacts (never `git add .`).
git add package.json package-lock.json [release.versionFile]
git commit -m "chore(release): bump version to [NEW_VERSION] for Epic #[EPIC_ID]"
```

> **Note:** No git tag is created. Release tagging (if needed for an external
> consumer) is opt-in and lives outside this workflow.

### 5.2 Merge Epic Branch to Base

```powershell
git checkout [BASE_BRANCH]
git pull origin [BASE_BRANCH]
git merge --no-ff epic/[EPIC_ID] -m "chore(release): merge epic/[EPIC_ID] into [BASE_BRANCH]"
```

### 5.3 Conflict Marker Scan

```powershell
node [SCRIPTS_ROOT]/detect-merges.js
```

If markers are found: resolve them following the canonical procedure in
[`helpers/_merge-conflict-template.md`](helpers/_merge-conflict-template.md),
stage with `git add`, and amend the merge commit before proceeding.

### 5.4 Push Base

```powershell
git push origin [BASE_BRANCH]
```

---

## Phase 6 — Retro

**Skip this phase entirely when `[RUN_RETRO]` is `false` or the operator
passed `--skip-retro`.** Log the override and proceed to Finalize.

When `[RUN_RETRO]` is `true` (default), verify a retrospective comment is
present on the Epic. Retros are stored as comments on the Epic — there is no
local retro file.

Detection strategy:

1. **Preferred**: fetch `provider.getComments(epicId)` (or
   `provider.getTicketComments(epicId)`) and filter for a comment whose
   `type === "retro"` metadata is present.
2. **Fallback**: grep the raw comment bodies for the
   `<!-- retro-complete: ... -->` HTML marker written at the end of the retro
   body.

```powershell
# Fallback grep — matches the retro-complete HTML marker.
gh api "repos/{owner}/{repo}/issues/[EPIC_ID]/comments" \
  --jq '.[] | select(.body | test("retro-complete:"))'
```

If no matching comment is found, **auto-invoke** the
[`helpers/epic-retro.md`](helpers/epic-retro.md) procedure inline for
`[EPIC_ID]`. After it completes, re-run the check above to confirm the
comment is now present. If the retro helper failed to produce a comment,
STOP and relay the failure to the operator.

> **Why retro runs after merge but before finalize:** The retro reads
> friction signals from the Epic's descendants. Phase 7 closes the Epic
> ticket itself, but the descendants are already closed by the time Phase 1
> passes — so retro can compose immediately after the merge lands. Running
> retro here (rather than after Finalize) keeps the Notify banner at the
> very end of the workflow.
>
> **`--skip-retro` parity:** the flag behaves like `--skip-code-review` —
> both log the override and continue. Use sparingly; the retro is how the
> organisation learns from each Epic.
>
> **`--full-retro` override:** if the operator passed `--full-retro`,
> propagate it into the retro helper invocation so the compact-path
> heuristic in `helpers/epic-retro.md` Step 0.5 is bypassed and the full
> six-section retro is composed regardless of the dispatch manifest's
> cleanliness. Without the flag, the helper chooses the compact or full
> path based on the `isCleanManifest` predicate. `--skip-retro` takes
> precedence over `--full-retro` (skipping means no retro composes at all,
> so the shape is moot).

---

## Phase 7 — Finalize

Close the planning, strategy, and Epic tickets, then clean up branches.

```powershell
node [SCRIPTS_ROOT]/epic-close.js --epic [EPIC_ID]
```

The script performs three phase-internal functions:

1. **Close auxiliary tickets** — `context::prd`, `context::tech-spec`, and
   `type::health` (Sprint Health dashboard) tickets are transitioned to
   `agent::done` and closed. These tickets hold no planned work; leaving them
   open after the Epic closes produces orphan children that pollute future
   project views.
2. **Close the Epic** — posts a shipping notification comment, then closes
   the issue with `state_reason=completed`.
3. **Branch cleanup** — reaps stale worktrees, prunes stale worktree
   registrations, and batch-deletes every local + remote branch associated
   with the Epic (can be disabled with `--no-cleanup`).

Windows/PowerShell resilience: remote branch deletions are individually
wrapped in error handling. A "branch not found" error on any single remote
ref is logged as a warning but **does not** abort the cleanup pass — every
remaining branch is still attempted.

Manually verify in the GitHub UI that the Epic and all context tickets are
closed. Check the notification structured comment on the Epic for the final
shipping announcement.

---

## Phase 8 — Notify

```powershell
node [SCRIPTS_ROOT]/notify.js --ticket [EPIC_ID] "Epic #[EPIC_ID] closed. Merged to [BASE_BRANCH] and branches cleaned up." --action
```

---

## Constraint

- **Never** merge to `[BASE_BRANCH]` if any child ticket (Task, Story,
  Feature) is still open — the Hierarchy Completeness Gate (Phase 1.2) is
  mandatory.
- **Never** skip the Documentation Freshness Gate (Phase 2). Every file in
  `[ALL_DOCS]` **must** reference `#[EPIC_ID]` in a commit message or body
  before the merge proceeds.
- **Never** skip the pre-merge validation (lint + test) in Phase 4. A
  broken `[BASE_BRANCH]` blocks all future Epics.
- **Always** refresh project-specific pre-push ratchets on the Epic
  branch before Phase 5.4 push. The evidence-aware Phase 4 gate runs
  lint + test only; it does not invoke project-extended baselines or
  audits. Drift caught after merge has to be fixed on `[BASE_BRANCH]`,
  not on the Epic branch where it belongs.
- **Always** auto-invoke the code-review helper (Phase 3) and the retro
  helper (Phase 6) when they have not already produced their artefacts. Do
  not halt and ask the operator to run them separately — that round-trip is
  what the auto-invoke replaced.
- **Always** persist the code-review output as a `code-review` structured
  comment on the Epic — `epic-code-review.js` already does this via
  `upsertStructuredComment`; do not bypass it.
- **Always** bump the version (Phase 5.1) before merging when
  `release.autoVersionBump` is `true`. Use **minor** for new features,
  **patch** for fixes and refactors. No git tag is created.
- **Always** run `epic-close.js` (Phase 7) to ensure PRD and Tech Spec
  tickets are formally closed — they are excluded from auto-closure during
  execution.
- **Always** delete all Epic, Task, and Story branches after merge to
  prevent branch bloat. Individual remote deletion failures MUST be
  tolerated — log them as warnings and continue.
- **`--full-retro` is opt-in.** The compact three-section retro is the
  default for clean-manifest Epics (zero friction, zero parked, zero
  recuts, zero hotfixes, zero HITL). Pass `--full-retro` to force the
  six-section retro regardless of manifest cleanliness. `--skip-retro`
  still wins over `--full-retro` — skipping means no retro composes at
  all. Neither flag affects the code-review gate.
