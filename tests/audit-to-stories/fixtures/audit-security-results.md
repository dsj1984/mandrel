# Security Audit Report

## Executive Summary

Two High-severity issues and one Medium were identified during the review.

## Detailed Findings

### Unparameterised SQL query in login handler

- **Dimension:** Injection
- **Severity:** High
- **CWE ID:** CWE-89
- **Current State:** `src/routes/auth/login.js` concatenates `req.body.email` directly into a query string passed to `db.query()`.
- **Recommendation & Rationale:** Replace the raw template with a parameterised query using the project's prepared-statement API. Add a regression contract test that asserts the handler rejects an input containing a SQL comment marker.
- **Agent Prompt:**
  `In src/routes/auth/login.js, replace the concatenated db.query call with a parameterised statement and add a contract test under tests/contract/auth-login.test.js covering SQLi-shaped inputs.`

### Session cookie missing httpOnly flag

- **Dimension:** Security Misconfiguration
- **Severity:** High
- **CWE ID:** CWE-1004
- **Current State:** `src/routes/auth/login.js` sets the session cookie via `res.cookie('sid', token, { sameSite: 'lax' })` — no `httpOnly` flag, no `secure` flag.
- **Recommendation & Rationale:** Pass `{ httpOnly: true, secure: true, sameSite: 'lax' }` to every `res.cookie('sid', ...)` invocation. Audit other cookie writes in the same file.
- **Agent Prompt:**
  `In src/routes/auth/login.js, add httpOnly and secure flags to the session cookie write and verify with a contract test under tests/contract/session-cookie.test.js.`

### Verbose error responses leak stack traces

- **Dimension:** Information Disclosure
- **Severity:** Medium
- **Current State:** `src/middleware/error-handler.js` JSON-stringifies `err.stack` into the response body in non-prod environments only, but `NODE_ENV` is unset in CI.
- **Recommendation & Rationale:** Default to the sanitised production branch when `NODE_ENV` is not exactly `development`; route stack traces to logs only.
- **Agent Prompt:**
  `In src/middleware/error-handler.js, invert the env check so the dev branch is the explicit opt-in.`

## Defensive Recommendations

- Add `Content-Security-Policy` header to the global response chain.
- Configure HSTS with a one-year max-age in `src/server.js`.
