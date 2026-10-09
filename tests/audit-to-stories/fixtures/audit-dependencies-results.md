# Dependency Audit Report

## Executive Summary

Severity tally: Critical 0 / High 1 / Medium 1 / Low 0

## Health Summary

- **Outdated Packages:** 8
- **Vulnerabilities:** [Critical: 0, High: 1, Mod: 2]

## Detailed Findings

### Upgrade `lodash` to 4.17.21

- **Dimension:** Security Fix
- **Impact:** High
- **Current State:** `package.json` pins `lodash@4.17.15`, vulnerable to CVE-2021-23337 (command injection via template).
- **Recommendation & Rationale:** Bump to `lodash@4.17.21`. No breaking changes in the patch range; CI lockfile diff is the only artifact.
- **Acceptance signal:** `npm ls lodash` resolves 4.17.21 in the root workspace.

### Replace `moment` with `date-fns`

- **Dimension:** Major Upgrade
- **Impact:** Medium
- **Current State:** `moment@2.29.x` is in maintenance mode and ships ~280 KB to the client bundle via `src/utils/format-date.js`.
- **Recommendation & Rationale:** Migrate format-date.js to `date-fns` — tree-shakeable and ~6 KB after gzip. Provide a wrapper to keep call sites stable.
- **Acceptance signal:** `grep -rn moment src/utils/format-date.js` returns nothing and `package.json` no longer lists `moment`.

## Recommended Removals/Replacements

- Replace `request` (deprecated) with `undici` or native `fetch`.
