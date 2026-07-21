# Security and Hardening — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule
is the contract; this file is the reference material behind it. Nothing here
relaxes a capsule MUST, and the generic *how* of each MUST (parameterize
queries, hash passwords, encode output, verify ownership, set headers,
restrict CORS, validate at the boundary) is stated once in the SSOT rule,
[`security-baseline.md`](../../../rules/security-baseline.md) — not duplicated
here.

## Security Surfacing, Not Runtime Pause

Some changes are not unsafe by themselves but expand the security surface
enough that the change must be **explicitly documented** in the PR
description and on the originating ticket so a reviewer can sign off in
band. Documenting them is the gate — they do **not** pause execution:

- Adding new authentication flows or changing auth logic
- Storing new categories of sensitive data (PII, payment info)
- Adding new external service integrations
- Changing CORS configuration
- Adding file upload handlers
- Modifying rate limiting or throttling
- Granting elevated permissions or roles

For each item that applies, call it out under a "Security surface" section
in the PR body and on the parent ticket, label the change `risk::high`,
and link the relevant `security-baseline.md` MUST. Reviewers gate the
merge; the agent keeps moving.

`agent::blocked` remains the **only** runtime pause label. Use it for
unrecoverable blockers (missing prerequisite, ambiguous spec a sub-agent
cannot resolve), not for "this change is sensitive." Sensitive changes
ship through the documentation path above.

## Validation-Error Responses

The status code and response envelope for a failed input validation are owned
by the wire-format SSOT, not by this skill: validation failures MUST return
**400 Bad Request** with `error.code = "VALIDATION_ERROR"` in the canonical
envelope. See
[`api-conventions.md` § Validation Status](../../../rules/api-conventions.md#validation-status)
and [§ Response Envelope](../../../rules/api-conventions.md#response-envelope).
Do not hand-roll a divergent status (e.g. 422) or envelope shape in
security-relevant handlers — cite the rule and reuse its shape, keeping the
security skill and the api skill in agreement.

## Triaging npm audit Results

The MUST is in [security-baseline § Dependency Hygiene](../../../rules/security-baseline.md#dependency-hygiene).
This decision tree shows how to prioritize:

```text
npm audit reports a vulnerability
├── Severity: critical or high
│   ├── Is the vulnerable code reachable in your app?
│   │   ├── YES --> Fix immediately (update, patch, or replace the dependency)
│   │   └── NO (dev-only dep, unused code path) --> Fix soon, but not a blocker
│   └── Is a fix available?
│       ├── YES --> Update to the patched version
│       └── NO --> Check for workarounds, consider replacing the dependency, or add to allowlist with a review date
├── Severity: moderate
│   ├── Reachable in production? --> Fix in the next release cycle
│   └── Dev-only? --> Fix when convenient, track in backlog
└── Severity: low
    └── Track and fix during regular dependency updates
```

**Key questions:**

- Is the vulnerable function actually called in your code path?
- Is the dependency a runtime dependency or dev-only?
- Is the vulnerability exploitable given your deployment context (e.g., a
  server-side vulnerability in a client-only app)?

When you defer a fix, document the reason and set a review date.

## Security Review Checklist

Use this when reviewing your own change before requesting human review. Each
item maps to a section in
[`security-baseline.md`](../../../rules/security-baseline.md).

```markdown
### Authentication

- [ ] Passwords hashed with bcrypt/scrypt/argon2 (salt rounds ≥ 12)
- [ ] Session tokens are httpOnly, secure, sameSite
- [ ] Login has rate limiting
- [ ] Password reset tokens expire

### Authorization

- [ ] Every endpoint checks user permissions
- [ ] Users can only access their own resources
- [ ] Admin actions require admin role verification

### Input

- [ ] All user input validated at the boundary
- [ ] SQL queries are parameterized
- [ ] HTML output is encoded/escaped

### Data

- [ ] No secrets in code or version control
- [ ] Sensitive fields excluded from API responses
- [ ] PII encrypted at rest (if applicable)

### Infrastructure

- [ ] Security headers configured (CSP, HSTS, etc.)
- [ ] CORS restricted to known origins
- [ ] Dependencies audited for vulnerabilities
- [ ] Error messages don't expose internals
```
