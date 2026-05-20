---
name: backend-security-patterns
description:
  Combined backend protocols for authentication (Clerk JWT verification) and
  PII-safe observability. Use when handling auth on the server, verifying
  Clerk webhooks via `svix`, scoping metadata via `publicMetadata`/
  `privateMetadata`, or sanitizing logs to keep emails, tokens, and request
  bodies out of telemetry.
vendor: clerk
---

# Skill: Backend Security Patterns

## Policy Capsule

- Verify Clerk JWTs on the server or in middleware on every protected route; never trust client-asserted auth state.
- Protect sensitive routes with Clerk's middleware helper so unauthenticated requests are redirected before hitting application logic.
- Verify Clerk webhook signatures with the `svix` library before parsing payloads.
- Store user state in `publicMetadata` (client-readable) or `privateMetadata` (server-only); never invent a parallel user store.
- Never log raw request bodies, headers, or user objects that may contain PII (emails, DOB, IPs, Stripe tokens, passwords, JWTs).
- Log entities by opaque ID only — e.g. `{ event: 'user_created', userId: user.id }`.
- For Clerk-flow telemetry, log the Clerk user ID or session ID — never the email, name, or metadata payload.
- Sanitize user input before including it in error logs so payloads cannot smuggle PII through the error path.

Combined protocols for authentication (Clerk) and PII-safe observability in
backend services.

## 1. Authentication (Clerk)

### Core Principles

- **Security First:** Never trust the client. Always verify JWTs on the server
  or in middleware.
- **Zero-Boilerplate Auth:** Use Clerk's built-in components (`<SignIn>`,
  `<SignUp>`, `<UserButton>`) to maintain UI consistency and security standards.
- **Metadata Management:** Store application-specific user state in
  `publicMetadata` (read-only by client) or `privateMetadata` (server-only).

### Technical Standards

- **Middleware:** Protect sensitive routes using Clerk's middleware helper so
  non-authenticated users are redirected before hitting application logic.
- **Webhooks:** Verify Clerk webhooks using the `svix` library to ensure
  requests originate from Clerk.
- **Session Tokens:** Use short-lived sessions and handle expired tokens
  gracefully.

### Best Practices

- **OAuth Providers:** Prefer standard social logins (Google, GitHub) to reduce
  user friction.
- **Customization:** Use Clerk's theme API to align auth components with the
  project's styling system.
- **Multi-tenant:** Use Clerk Organizations for applications requiring teams or
  workspaces.

## 2. Telemetry & PII Logging

### Rules

- NEVER log raw request bodies, headers, or user objects that might contain PII
  (Emails, DOB, IP Addresses, Stripe Tokens, Passwords, JWTs).
- Log entities by opaque ID only (e.g.,
  `logger.info({ event: 'user_created', userId: user.id })`).
- For errors, log `error.message` and a safe contextual stack trace, but
  sanitize any user input that caused the error before logging.
- When instrumenting Clerk flows specifically, log the Clerk user ID or session
  ID — never the email, name, or metadata payload.
