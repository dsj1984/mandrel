# Security Audit Report

## Executive Summary

Two High-severity issues and one Medium were identified during the review.

Severity tally: Critical 0 / High 2 / Medium 1 / Low 0

## Detailed Findings

### Unparameterised SQL query in login handler

- **Dimension:** Injection
- **Severity:** High
- **CWE ID:** CWE-89
- **Current State:** `src/routes/auth/login.js` concatenates `req.body.email` directly into a query string passed to `db.query()`.
- **Recommendation & Rationale:** Replace the raw template with a parameterised query using the project's prepared-statement API. Add a regression contract test that asserts the handler rejects an input containing a SQL comment marker.
- **Acceptance signal:** A contract test asserts the login handler rejects an input containing a SQL comment marker.

### Session cookie missing httpOnly flag

- **Dimension:** Security Misconfiguration
- **Severity:** High
- **CWE ID:** CWE-1004
- **Current State:** `src/routes/auth/login.js` sets the session cookie via `res.cookie('sid', token, { sameSite: 'lax' })` — no `httpOnly` flag, no `secure` flag.
- **Recommendation & Rationale:** Pass `{ httpOnly: true, secure: true, sameSite: 'lax' }` to every `res.cookie('sid', ...)` invocation. Audit other cookie writes in the same file.
- **Acceptance signal:** A contract test asserts the `sid` cookie is written with `httpOnly` and `secure`.

### Verbose error responses leak stack traces

- **Dimension:** Information Disclosure
- **Severity:** Medium
- **Current State:** `src/middleware/error-handler.js` JSON-stringifies `err.stack` into the response body in non-prod environments only, but `NODE_ENV` is unset in CI.
- **Recommendation & Rationale:** Default to the sanitised production branch when `NODE_ENV` is not exactly `development`; route stack traces to logs only.
- **Acceptance signal:** With `NODE_ENV` unset, an error response body carries no stack trace.

## Defensive Recommendations

- Add `Content-Security-Policy` header to the global response chain.
- Configure HSTS with a one-year max-age in `src/server.js`.
