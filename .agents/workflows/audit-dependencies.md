---
description: Audit `package.json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches.
---

# Dependency Update Audit

## Role

DevOps Engineer & Security Researcher

## Context & Objective

Manage the lifecycle of project dependencies. Your goal is to identify outdated,
vulnerable, or bloated packages and suggest a safe upgrade path that maintains
system stability.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Step 1: Inventory, Staleness & Unused Detection

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scans below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Run each probe as a concrete, machine-readable command so the Health Summary
counts are **exact** rather than eyeballed:

1. **Outdated inventory.** Run `npm outdated --json` (or the package
   manager's equivalent). Every key is a behind package with its `current`,
   `wanted`, and `latest` fields; the count of keys is the exact **Outdated
   Packages** figure — never hand-count from prose.
2. **Unused dependencies.** Run `npx knip --production` to find declared
   dependencies with no import reachable from a production entry point.
   ⚠️ **`knip --production` silent-no-op gotcha:** knip's `--production`
   mode analyses nothing **unless the project's `entry` patterns carry a
   `!` suffix** — without the bang-suffixed production entries it reports
   `{"issues":[]}` and looks green while scanning zero files. Confirm the
   consumer's knip config uses `!`-suffixed entries before trusting a clean
   result; when it does not, fall back to `npx depcheck --json` and record
   the config gap itself as a finding. Report each genuinely-unused
   dependency as a `Removal` finding.
3. **Staleness.** For each critical or outdated dependency, probe its last
   publish with `npm view <pkg> time.modified` and flag any package with no
   release in over a year as **stale** (unmaintained-supply-chain risk),
   independent of whether a newer version exists.
4. **Node-engine drift.** Compare the Node version declared across every
   source of truth and flag any mismatch between them:
   - `package.json` `engines.node`,
   - `.nvmrc`,
   - the CI matrix `node-version` entries under `.github/workflows/**`,
   - the locally observed `node --version`.
   A drift between any two (e.g. `.nvmrc` pinning `20` while the CI matrix
   still tests `18`) is a finding: the floor the code is actually tested
   against has diverged from the floor it advertises.

## Step 2: Reachability-triaged Vulnerability Scan

A vulnerability in a build-only devDependency is not the same risk as one that
ships to production. Triage every advisory by **production reachability**
before grading it — this mirrors the security baseline's "reachable in
production code" standard.

1. **Two-pass audit diff.** Run `npm audit --json` (the full tree) **and**
   `npm audit --json --omit=dev` (production-reachable only). An advisory
   present in the full run but absent from the `--omit=dev` run is
   **dev-only**; one present in both is **production-reachable**.
2. **Severity rubric.** Grade each advisory on the shared
   [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md)
   as a function of the advisory's own CVSS band, its reachability
   (production-reachable escalates; dev-only caps at Medium), and its
   dependency position (a direct dependency whose version you control is more
   actionable than a deep transitive one).
3. **Report shape — no flooding.** Emit **one finding per
   production-reachable Critical or High advisory** — these are the ones that
   gate a release. Collapse **all dev-only advisories into a single aggregate
   finding** ("N dev-only advisories, no production reachability") rather than
   one block per advisory, so dev-only noise never drowns the production
   signal.

## Step 3: Supply-chain scoped mode (lockfile-delta)

When the `## Scope` block above resolved to a change-set file list **and that
list contains a lockfile** (`package-lock.json`, `pnpm-lock.yaml`, or
`yarn.lock`), run this lens as a **supply-chain delta pass** instead of a
whole-manifest re-scan. The close-time question is not "what is stale across
the whole repo" — it is "what just entered the dependency tree, and is it
safe". Diff the lockfile against the base branch and analyse only the delta:

1. **Enumerate the delta.** Run `git diff <base>...HEAD -- <lockfile>` and
   list every **added** package and every **version-bumped** package the
   change introduces. These are the only packages in scope for this pass.
2. **Provenance.** Run `npm audit signatures` to verify the registry
   signatures / provenance attestations of the installed tree, and flag any
   added package that fails signature verification.
3. **New install scripts.** Flag any added or bumped package that declares a
   `preinstall`, `install`, or `postinstall` lifecycle script — arbitrary
   code that runs at `npm install` time is the classic supply-chain execution
   vector and warrants an explicit eyeball.
4. **Typosquat near-misses.** Compare each **added** package name against the
   existing dependency set and well-known package names for a near-miss
   (single-character edits, dropped scopes, hyphen/underscore swaps) that
   suggests a typosquat, and flag it.

## Step 4: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-dependencies-results.md`, using the exact template
below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).
>
> **Version-free titles (mandatory).** A finding title MUST NOT embed a
> concrete version number — write ``### `package.json` — lodash unused``, not
> ``… — lodash@4.17.20 unused``. Periodic re-runs of this lens re-detect the
> same issue at a drifted version; a version-free title keeps the finding's
> fingerprint stable so `audit-to-stories` dedupes it against the existing
> Story instead of filing a fresh duplicate on every bump.

```markdown
# Dependency Audit Report

## Health Summary

- **Outdated Packages:** [exact count from `npm outdated --json`]
- **Unused Dependencies:** [exact count from `npx knip --production` / `depcheck`]
- **Vulnerabilities:** [Critical: #, High: #, Mod: #] (production-reachable / dev-only split)
- **Node-engine drift:** [None | describe the mismatch across engines / .nvmrc / CI matrix]

## Detailed Findings

[For every production-reachable Critical/High advisory, unused dependency, or
Node-engine drift, use the strict structure below. Lead each title with the
manifest the dependency lives in, and keep the title version-free:]

### `path/to/package.json` — [Package name — issue, no version]

- **Dimension:** [Security Fix | Removal | Engine Drift | Major Upgrade | Supply-chain]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/package.json:line`
- **Current State:** [Current vs target, the reachability verdict (production-reachable | dev-only), and the reason for the change]
- **Recommendation & Rationale:** [How to remediate and the breaking changes to watch for]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. `npm audit --omit=dev` reporting zero for this advisory, or `npx knip --production` no longer listing the package]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this update independently (e.g., npm install package@latest)]`

### Dev-only advisories (aggregate)

- **Dimension:** Security Fix
- **Impact:** [Low | Medium]
- **Location:** `package-lock.json`
- **Current State:** [N dev-only advisories with no production reachability; not release-gating]
- **Recommendation & Rationale:** [Batch-remediate on the next dependency-maintenance pass — do not block the release on these]
- **Acceptance signal:** `npm audit --json` dev-only advisory count returns to zero.

## Upgrade Batches

Group the safe upgrade path into batches so a maintainer can act on them as
discrete units. Each batch carries its own acceptance signal:

- **Batch: patch + minor bumps** — every non-breaking `npm outdated` entry
  whose `wanted` satisfies the declared range, grouped into ONE batch.
  - **Acceptance signal:** `npm outdated` reports no remaining patch/minor
    drift and the test suite passes after the bump.
- **Batch: `<package>` major upgrade** — one batch **per** major bump (each
  crosses a breaking boundary and lands independently).
  - **Acceptance signal:** `<package>` at the new major with its migration
    notes applied and the test suite green.

## Recommended Removals/Replacements

- Remove `[unused-package]` — no production import per `npx knip --production`.
- Replace `[heavy-library]` with `[light-library]` or native `[browser-api]`.
```

## Constraint

This is a **read-only** evaluation. Do not run `npm install` or `npm update`
unless explicitly requested by the user after reviewing this report.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
