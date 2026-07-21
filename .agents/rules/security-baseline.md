# Application Security Baseline

Non-negotiable security MUSTs (the SSOT for security taxonomy and constraints)
that apply to every piece of code generated; the companion skill
[`core/security-and-hardening`](../skills/core/security-and-hardening/SKILL.md)
shows **how** to apply them. These MUSTs are inviolable per
[`.agents/instructions.md` § 1.K](../instructions.md).

## Input Validation

- ALL input received from the client (body, query params, headers, path params)
  MUST be validated at the edge using a strict schema (e.g., Zod). Validation
  runs at the system boundary — never trust client-side validation as a
  security control.
- Never trust client-provided IDs without verifying ownership recursively.
- File uploads MUST validate type (mimetype, optionally magic bytes) and size
  before persisting or processing.

## Authentication

- Passwords MUST be hashed with `bcrypt`, `scrypt`, or `argon2`. Salt rounds
  for bcrypt MUST be ≥ 12. Plaintext password storage is forbidden.
- Session tokens MUST be stored in cookies that are `httpOnly`, `secure`, and
  carry an explicit `sameSite` policy (`lax` or `strict`). Auth tokens MUST
  NOT be placed in client-accessible storage (e.g., `localStorage`,
  `sessionStorage`).
- Authentication endpoints MUST be rate-limited.

## Authorization

- Every protected endpoint MUST check user permissions, not just authentication.
  "Logged in" is not "allowed".
- Users MUST only be able to access or modify resources they own; ownership
  checks MUST run server-side before any state change.
- Inbound webhooks and server-to-server callbacks MUST verify the sender's
  signature before parsing the payload; never act on an unverified webhook.
- Admin or elevated actions MUST verify the role server-side; never trust a
  client-asserted role claim.

## Output & Rendering

- Database queries MUST be parameterized. Never concatenate user input into
  SQL, NoSQL filters, or shell commands.
- HTML output MUST be encoded via the framework's auto-escaping. If raw HTML
  rendering is unavoidable, sanitize with a vetted library (e.g., DOMPurify)
  first.
- `eval()`, `Function()`, and `innerHTML` (or framework equivalents like
  `dangerouslySetInnerHTML`) MUST NOT receive user-provided data without
  sanitization.
- API responses MUST exclude sensitive fields (password hashes, reset tokens,
  internal IDs not intended for clients). Stack traces and internal error
  details MUST NOT be exposed to users.

## Data Leakage & Logging

- NEVER log Personal Identifiable Information (PII) such as emails, passwords,
  full credit card numbers, session tokens, or phone numbers.
- Avoid logging complete objects directly; destructure out safe properties.
  Prefer logging entities by opaque ID (e.g. `userId`), and sanitize user input
  before it reaches an error log so a payload cannot smuggle PII through the
  error path.

## Transport & Headers

- All external communication MUST use HTTPS.
- Security headers MUST be configured: `Content-Security-Policy`,
  `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`.
- CORS MUST be restricted to a known origin allowlist. Wildcard (`*`) origins
  are forbidden on endpoints that accept credentials.

## Secrets Management

- Keys, passwords, and tokens MUST be pulled from environment variables.
  Fallback or placeholder secrets MUST NOT be committed in code.
- `.env` files containing real secrets MUST be gitignored. Only `.env.example`
  (placeholder values) is committed.

## Dependency Hygiene

- `npm audit` (or the project equivalent) MUST run before every release.
  Critical and high-severity vulnerabilities reachable in production code MUST
  be remediated before shipping; deferred findings MUST be documented with a
  review date.

## Forbidden Practices

The MUSTs above are the contract; two rationalizations recur often enough to
name explicitly (both violate a MUST above):

- Committing secrets to version control.
- Disabling security headers for convenience.
