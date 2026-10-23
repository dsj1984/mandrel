# API & Endpoint Conventions

This rule applies when designing, changing, or reviewing a REST or GraphQL API
surface in any project that consumes this framework. It is the **single source
of truth** for the response envelope, validation-status taxonomy, HTTP
status-code conventions, payload-naming conventions, list pagination, and the
pre-PR authoring checklist. Copy the canonical shapes from here rather than
redrafting a divergent one.

## Payload Formatting

- All JSON request and response keys MUST use `camelCase`.
- Endpoint URLs MUST use lowercase `kebab-case` (e.g., `/api/user-profiles`).
- Resource paths MUST use plural nouns and avoid verbs
  (e.g., `GET /api/tasks`, not `GET /api/getTasks`).
- Query parameter names MUST use `camelCase`
  (e.g., `?sortBy=createdAt&pageSize=20`).
- Boolean fields MUST use an `is`/`has`/`can` prefix
  (e.g., `isComplete`, `hasAttachments`).
- Enum values MUST use `UPPER_SNAKE_CASE` (e.g., `"IN_PROGRESS"`).

## Response Envelope

Every handled error response MUST follow this exact shape:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE_SNAKE_CASE",
    "message": "Human-readable explanation of why it failed.",
    "details": { }
  }
}
```

- `success` is a literal `false` boolean. Successful responses MAY omit the
  envelope and return the resource directly, but MUST NOT return
  `success: false` on a 2xx status.
- `error.code` is a machine-readable identifier in `UPPER_SNAKE_CASE`
  (e.g., `VALIDATION_ERROR`, `RESOURCE_NOT_FOUND`).
- `error.message` is a human-readable single sentence. Never include stack
  traces, internal identifiers, or implementation details.
- `error.details` is OPTIONAL and carries structured context (e.g., a Zod
  flatten output, the conflicting field name). Omit when empty.

A single endpoint MUST NOT mix error shapes (e.g., throwing on one path and
returning `{ error }` on another). Pick one and apply it across the surface.

## HTTP Status Codes

Use the canonical mapping below. Do not invent project-specific codes.

| Code | Meaning                 | When to use                                            |
| ---- | ----------------------- | ------------------------------------------------------ |
| 200  | OK                      | Successful `GET`, `PUT`, `PATCH`, idempotent `DELETE`. |
| 201  | Created                 | Successful `POST` resulting in resource creation.      |
| 400  | Bad Request             | Validation failures (Zod issues, malformed payload).   |
| 401  | Unauthorized            | Missing or invalid auth tokens.                        |
| 403  | Forbidden               | Authenticated, but lacks role permission.              |
| 404  | Not Found               | Resource does not exist.                               |
| 409  | Conflict                | Duplicate resource, version mismatch, optimistic-lock. |
| 500  | Internal Server Error   | Unhandled exceptions. Never leak internal detail.      |

## Validation Status

Validation failures — including schema parse errors and required-field checks
— MUST return **400 Bad Request** with the response envelope above and
`error.code = "VALIDATION_ERROR"`. Schema-flattened field errors MAY be
attached via `error.details`.

Authorization failures (401, 403) take precedence over validation: if the
caller is not allowed to invoke the endpoint at all, return the auth status
without running validation.

## Pagination

Every list endpoint MUST be paginated. Use `page` + `pageSize` query
parameters and return a `pagination` envelope alongside the collection — do
not invent a per-endpoint cursor shape when the offset shape suffices:

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 137,
    "totalPages": 7
  }
}
```

`page` is 1-based. A `pageSize` above the endpoint's documented maximum MUST
be clamped or rejected as `VALIDATION_ERROR` — never honoured unbounded.

## Authoring Checklist

Before opening a PR that adds or edits an API surface:

- [ ] Every endpoint has typed input and output schemas.
- [ ] Error responses follow the envelope in
      [§ Response Envelope](#response-envelope).
- [ ] Status codes match [§ HTTP Status Codes](#http-status-codes), and
      validation failures return the canonical **400** `VALIDATION_ERROR`.
- [ ] List endpoints support pagination per [§ Pagination](#pagination).
- [ ] New fields are additive and optional (backward compatible). When a
      removal is unavoidable, use expand–contract: ship the replacement,
      migrate consumers, then delete the old surface in a later release.
- [ ] Naming follows [§ Payload Formatting](#payload-formatting).
- [ ] Every public function or endpoint states its caller obligations
      (input preconditions, required call ordering, ownership) in its
      JSDoc/TSDoc or schema, and the contract tier carries a negative test
      for each obligation the surface rejects.
- [ ] API documentation or types are committed alongside the implementation.
