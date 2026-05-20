---
name: structured-output-zod
description:
  Validates external and structured data with Zod schemas. Use when accepting
  untrusted input at API boundaries, validating environment variables on
  startup, parsing third-party responses, or generating typed shapes via
  `z.infer`. Parse, don't validate.
vendor: zod
---

# Skill: Structured Output (Zod)

## Policy Capsule

- Define every external or structured data shape as a Zod schema before it is processed or stored.
- Derive TypeScript types from schemas via `z.infer`; never hand-author a parallel `type` for the same shape.
- Parse untrusted input with `z.parse()` or `z.safeParse()` — do not pass raw values past the boundary.
- Validate every incoming request body and query parameter at the application boundary.
- Validate `process.env` at startup with a Zod schema so missing or malformed config fails fast.
- Compose complex schemas with `.extend()`, `.merge()`, and `.pick()` to keep shapes DRY.
- Use `z.coerce.*` deliberately for form and query inputs; do not coerce in trusted server-to-server paths.

Guidelines for ensuring system reliability through schema validation and typed
safety.

## 1. Core Principles

- **Schema First:** Always define data shapes with Zod before processing or
  storing external data.
- **Type Safety:** Leverage Zod's `z.infer` to automatically generate TypeScript
  types from your schemas.
- **Parse, Don't Validate:** Use `z.parse()` or `z.safeParse()` to transform
  untrusted input into trusted, typed objects.

## 2. Technical Standards

- **API Validation:** Validate every incoming request body and query parameter
  at the application boundary.
- **Environment Variables:** Use Zod to validate `process.env` on startup to
  fail fast if critical config is missing.
- **Database Schemas:** In systems like Drizzle or Turso collections, use Zod
  schemas to ensure data integrity during writes.

## 3. Best Practices

- **Error Messages:** Provide user-friendly, specific error messages via Zod's
  custom error formatting.
- **Composition:** Build complex schemas using `.extend()`, `.merge()`, and
  `.pick()` to maintain DRY principles in your types.
- **Coercion:** Use Zod coercion (`z.coerce.number()`) carefully to handle
  string inputs from forms or query parameters.
