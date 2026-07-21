---
description: Audit `package.json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches.
---

# Dependency Update Audit

You are a DevOps Engineer & Security Researcher managing the dependency
lifecycle — outdated, vulnerable, or bloated packages and a safe upgrade path.
The shared lens machinery — read-only constraint, scope interpretation, report
envelope + finding-block skeleton, severity scale, self-cross-check, and
execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-dependencies-results.md`. Dimension values:
`Security Fix | Removal | Engine Drift | Major Upgrade | Supply-chain`. The
report adds a **Health Summary**, an **Upgrade Batches** section, and a
**Recommended Removals/Replacements** list.

> **Version-free titles (mandatory).** A finding title MUST NOT embed a concrete
> version number — write ``### `package.json` — lodash unused``, not ``… —
> lodash@4.17.20 unused``. Periodic re-runs re-detect the same issue at a
> drifted version; a version-free title keeps the finding's fingerprint stable
> so `audit-to-stories` dedupes it against the existing Story instead of filing
> a fresh duplicate on every bump.

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 1: Inventory, Staleness & Unused Detection

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
2. **Severity rubric.** Grade each advisory on the shared severity scale as a
   function of the advisory's own CVSS band, its reachability
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

When the change-set fence resolved to a file list **and that list contains a
lockfile** (`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`), run this
lens as a **supply-chain delta pass** instead of a whole-manifest re-scan. The
close-time question is not "what is stale across the whole repo" — it is "what
just entered the dependency tree, and is it safe". Diff the lockfile against the
base branch and analyse only the delta:

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

## Report additions

Beyond the shared skeleton, emit these lens-specific report sections:

```markdown
## Health Summary

- **Outdated Packages:** [exact count from `npm outdated --json`]
- **Unused Dependencies:** [exact count from `npx knip --production` / `depcheck`]
- **Vulnerabilities:** [Critical: #, High: #, Mod: #] (production-reachable / dev-only split)
- **Node-engine drift:** [None | describe the mismatch across engines / .nvmrc / CI matrix]
```

- **Dev-only advisories (aggregate)** — one Detailed Findings entry collapsing
  all dev-only advisories: Dimension `Security Fix`, Impact `Low | Medium`,
  Location `package-lock.json`, Acceptance signal
  ``npm audit --json`` dev-only advisory count returns to zero.
- **Upgrade Batches** — group the safe upgrade path into discrete batches, each
  with its own acceptance signal: one batch of all non-breaking patch/minor
  bumps (`wanted` within range), and one batch **per** major bump (each crosses
  a breaking boundary and lands independently).
- **Recommended Removals/Replacements** — remove unused packages (per
  `npx knip --production`); replace heavy libraries with lighter or native
  alternatives.
