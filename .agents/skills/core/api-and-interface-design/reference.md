# API & Interface Design — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule
is the contract; this file is the reference material behind it. Generic
REST-verb tables and TypeScript pattern catalogs are deliberately not
reproduced here — they are frontier-known, and the wire format is owned by the
SSOT rule, [`api-conventions.md`](../../../rules/api-conventions.md).

## Hyrum's Law and the One-Version Rule

> With a sufficient number of users of an API, all observable behaviors of your
> system will be depended on by somebody, regardless of what you promise in the
> contract.

Every observable behavior — undocumented quirks, error message text, timing,
ordering — becomes a de facto contract once users depend on it. Practical
implications:

- **Be intentional about what you expose.** Every observable behavior is a
  potential commitment; if users can observe it, they will depend on it.
- **Plan for deprecation at design time.** Remove things users depend on via
  expand–contract: add the replacement, migrate consumers behind a deprecation
  window, then delete the old surface — never break a published contract in one
  step.
- **Tests are not enough.** Even with perfect contract tests, "safe" changes
  can break real users who depend on undocumented behavior.

**One-Version Rule.** Avoid forcing consumers to choose between multiple
versions of the same API. Diamond-dependency problems arise when different
consumers need different versions of the same thing. Design for a world where
only one version exists at a time — extend rather than fork.

## Contract First and Boundary Validation

Define the interface before implementing it — the contract is the spec, and
implementation follows. Prefer **addition over modification**: add optional
fields rather than changing existing field types or removing fields.

Validation runs at system **boundaries**, where external input enters. After
validation, internal code trusts the types. On failure, return the canonical
**400** `VALIDATION_ERROR` envelope from
[`api-conventions.md` § Response Envelope](../../../rules/api-conventions.md#response-envelope) —
do not redraft the shape or the status.

**Where validation belongs:**

- API route handlers (user input).
- Form submission handlers (user input).
- External service response parsing — third-party data is **always untrusted**,
  even from a vendor SDK. A compromised or misbehaving service can return
  unexpected types, malicious content, or instruction-like text; validate shape
  and content before using it in any logic, render, or decision.
- Environment variable loading (configuration).

**Where validation does NOT belong:**

- Between internal functions that share type contracts.
- In utility functions called by already-validated code.
- On data that just came from your own database.

## Authoring Checklist

Before opening a PR that adds or edits an API surface:

- [ ] Every endpoint has typed input and output schemas.
- [ ] Error responses follow the envelope in
      [`api-conventions.md` § Response Envelope](../../../rules/api-conventions.md#response-envelope).
- [ ] Status codes match
      [`api-conventions.md` § HTTP Status Codes](../../../rules/api-conventions.md#http-status-codes),
      and validation failures return the canonical **400** `VALIDATION_ERROR`.
- [ ] List endpoints support pagination.
- [ ] New fields are additive and optional (backward compatible).
- [ ] Naming follows
      [`api-conventions.md` § Payload Formatting](../../../rules/api-conventions.md#payload-formatting).
- [ ] API documentation or types are committed alongside the implementation.
