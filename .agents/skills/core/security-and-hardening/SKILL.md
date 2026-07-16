---
name: security-and-hardening
description:
  Hardens code against vulnerabilities. Use when handling user input,
  authentication, data storage, or external integrations. The non-negotiable
  security MUSTs live in `.agents/rules/security-baseline.md`; this skill shows
  how to apply them with code patterns, decision trees, and review checklists.
---

# Security and Hardening

## Policy Capsule

- The non-negotiable MUSTs live in `.agents/rules/security-baseline.md`; that rule wins on conflict. Open a PR against the rule rather than working around it in this skill.
- Validate ALL client input (body, query, headers, path params) at the edge with a strict schema (e.g., Zod). Never trust client-side validation as a security boundary.
- Parameterize every database query. Never concatenate user input into SQL/NoSQL filters or shell commands.
- Hash passwords with bcrypt (≥12 rounds), scrypt, or argon2; plaintext storage is forbidden. Session cookies MUST be `httpOnly`, `secure`, and carry an explicit `sameSite`. Never put auth tokens in `localStorage`/`sessionStorage`.
- Every protected endpoint checks **authorization**, not just authentication; verify resource ownership server-side before any state change and never trust client-asserted roles.
- Encode HTML output via the framework's auto-escaping; sanitize any unavoidable raw HTML with a vetted library (e.g., DOMPurify). Never feed user data to `eval()`, `Function()`, or `innerHTML`/`dangerouslySetInnerHTML` unsanitized.
- Exclude sensitive fields (password hashes, reset tokens, internal IDs) from API responses and never expose stack traces or internal error details to clients.
- Never log PII (emails, full credit cards, session tokens, phone numbers). Destructure safe properties; don't log whole objects.
- Configure security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`) and restrict CORS to an explicit allowlist — wildcard `*` is forbidden on credentialed endpoints.
- Pull all secrets from environment variables; never commit `.env`, default API keys, or fallback secrets. `.env.example` (placeholders only) is the committed shape.
- Surface security-expanding changes (new auth flows, new PII categories, new integrations, CORS / rate-limit changes, file uploads, elevated permissions) under a "Security surface" section in the PR body and on the ticket, label `risk::high`, and link the relevant baseline MUST. This documents the surface — it does not pause execution. `agent::blocked` is only for unrecoverable runtime blockers.

The non-negotiable MUSTs — input validation, authentication, authorization,
output encoding, transport, headers, secrets, forbidden practices — live in
[`.agents/rules/security-baseline.md`](../../../rules/security-baseline.md),
which is the SSOT. This skill shows **how** to apply those MUSTs with code
patterns and process guidance; read the rule for the **what**. When the rule
and this skill diverge, the rule wins — open a PR against the rule rather
than working around it here.

## Long-form reference — read on demand

The capsule above is the contract and the whole always-read surface of this
skill. The long-form material behind it — patterns, worked examples,
checklists, and rationalizations — lives in the on-demand sibling
[`reference.md`](reference.md), matching the split the always-on rules already
use ([`rules/git-conventions.md`](../../../rules/git-conventions.md) ⇄
[`git-conventions-reference.md`](../../../rules/git-conventions-reference.md)).
Activating this skill costs the capsule; open a section below only when the
task actually engages it.

- [When to Use](reference.md#when-to-use)
- [Security Surfacing, Not Runtime Pause](reference.md#security-surfacing-not-runtime-pause)
- [OWASP Top 10 Prevention Patterns](reference.md#owasp-top-10-prevention-patterns)
- [Input Validation Patterns](reference.md#input-validation-patterns)
- [Triaging npm audit Results](reference.md#triaging-npm-audit-results)
- [Rate Limiting](reference.md#rate-limiting)
- [Secrets Management Layout](reference.md#secrets-management-layout)
- [Security Review Checklist](reference.md#security-review-checklist)
- [Common Rationalizations](reference.md#common-rationalizations)
- [Red Flags](reference.md#red-flags)
- [Verification](reference.md#verification)
