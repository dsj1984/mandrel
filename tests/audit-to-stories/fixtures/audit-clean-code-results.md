# Clean Code Audit

## Executive Summary

One High-impact maintainability issue and one Low.

Severity tally: Critical 0 / High 1 / Medium 0 / Low 1

## Detailed Findings

### Cyclomatic complexity hotspot in login handler

- **Category:** Maintainability
- **Impact:** High
- **Current State:** `src/routes/auth/login.js` exports a single 240-line function with seven nested branches; CRAP and maintainability axes both regressed in the latest baseline snapshot.
- **Recommendation & Rationale:** Extract the credential-validation, rate-limit-check, and session-issue branches into named helpers; cover each with a unit test.
- **Acceptance signal:** `src/routes/auth/login.js` reports cyclomatic complexity under 10 and the three extracted helpers each have a unit test.

### Dead import in error-handler

- **Category:** Hygiene
- **Impact:** Low
- **Current State:** `src/middleware/error-handler.js` imports `serializeError` but never references it.
- **Recommendation & Rationale:** Remove the unused import; lint already warns on this in CI but the warning is being ignored.
- **Acceptance signal:** `grep -n serializeError src/middleware/error-handler.js` returns nothing.
