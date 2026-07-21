---
name: api-and-interface-design
description:
  Designs stable, well-documented APIs and module interfaces. Use when
  creating REST/GraphQL endpoints, defining contracts between modules, or
  changing public interfaces. The wire-format SSOT — response envelope, HTTP
  status codes, validation taxonomy, payload naming — lives in
  `.agents/rules/api-conventions.md`; this skill shows authors how to apply
  it.
---

# Skill: api-and-interface-design

## Policy Capsule

- The wire-format SSOT lives in [`.agents/rules/api-conventions.md`](../../../rules/api-conventions.md) (envelope shape, HTTP status mapping, validation taxonomy, payload casing). Copy the canonical envelope and status codes from the rule rather than redrafting or hand-rolling a divergent shape. Validation failures return **400** `VALIDATION_ERROR` per [§ Validation Status](../../../rules/api-conventions.md#validation-status).
- Be intentional about exposure (Hyrum's Law): every observable behaviour — undocumented quirks, error message text, ordering, timing — becomes a de facto contract once consumers depend on it. Don't leak implementation details.
- Adopt the **One-Version Rule**: never force consumers to choose between simultaneous versions of the same API. Extend rather than fork.
- Define the contract before implementing — interfaces are the spec; implementation follows.
- Validate at system **boundaries** (API routes, form handlers, env-var loaders, third-party responses) using a strict schema. After validation, internal code trusts the types; do not re-validate between internal functions.
- Treat third-party API responses as untrusted data — validate shape and content before using them in any decision, render, or logic path.
- Prefer **addition over modification**: extend interfaces with optional fields rather than changing existing types or removing fields. When removal is unavoidable, use an expand–contract migration — ship the replacement, migrate consumers, then remove the old surface in a later release.
- Follow REST resource conventions (`GET/POST/PATCH/DELETE /resource`, sub-resources at `/resource/:id/child`) and paginate every list endpoint with `page` + `pageSize` query params and a `pagination` envelope.
- Security input-validation and test-tier MUSTs come from [`security-baseline.md`](../../../rules/security-baseline.md) and [`testing-standards.md`](../../../rules/testing-standards.md) respectively — apply both, and never put DB/wire-shape assertions outside the contract tier.

## When to Use

- Designing new API endpoints, module boundaries, or component prop interfaces.
- Establishing a database schema that informs API shape.
- Changing existing public interfaces.

## Wire format — defer to the rule

The response envelope, HTTP status-code mapping, validation-status taxonomy,
and payload-naming conventions are non-negotiable and live in the rule. When
designing a new endpoint, **copy the canonical envelope from the rule** — do
not redraft it, and do not invent a project-specific validation status:

- Envelope shape: [`api-conventions.md` § Response Envelope](../../../rules/api-conventions.md#response-envelope).
- Status table (200/201/400/401/403/404/409/500): [`§ HTTP Status Codes`](../../../rules/api-conventions.md#http-status-codes).
- Validation status (**400** `VALIDATION_ERROR`): [`§ Validation Status`](../../../rules/api-conventions.md#validation-status).
- Casing conventions: [`§ Payload Formatting`](../../../rules/api-conventions.md#payload-formatting).

## Long-form reference — read on demand

The elaboration behind the capsule — Hyrum's-Law implications, the
contract-first stance, and where boundary validation does and does not belong,
plus the pre-PR authoring checklist — lives in the on-demand sibling
[`reference.md`](reference.md). Generic REST-catalog and TypeScript-idiom
snippets are intentionally omitted (frontier-known; the rule owns the wire
format). Open a section only when the task engages it.

- [Hyrum's Law and the One-Version Rule](reference.md#hyrums-law-and-the-one-version-rule)
- [Contract First and Boundary Validation](reference.md#contract-first-and-boundary-validation)
- [Authoring Checklist](reference.md#authoring-checklist)
