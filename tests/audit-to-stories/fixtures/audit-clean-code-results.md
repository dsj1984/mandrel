# Clean Code Audit

## Executive Summary

One High-impact maintainability issue and one Low.

## Detailed Findings

### Cyclomatic complexity hotspot in login handler

- **Category:** Maintainability
- **Impact:** High
- **Current State:** `src/routes/auth/login.js` exports a single 240-line function with seven nested branches; CRAP and maintainability axes both regressed in the latest baseline snapshot.
- **Recommendation & Rationale:** Extract the credential-validation, rate-limit-check, and session-issue branches into named helpers; cover each with a unit test.
- **Agent Prompt:**
  `In src/routes/auth/login.js, split the default export into three named helpers (validateCredentials, checkRateLimit, issueSession) and add tests/unit/auth-login.test.js.`

### Dead import in error-handler

- **Category:** Hygiene
- **Impact:** Low
- **Current State:** `src/middleware/error-handler.js` imports `serializeError` but never references it.
- **Recommendation & Rationale:** Remove the unused import; lint already warns on this in CI but the warning is being ignored.
- **Agent Prompt:**
  `Remove the unused serializeError import from src/middleware/error-handler.js.`
