---
description: Audit the persistence layer as a first-class artifact — model↔migration↔seed drift, constraint completeness, migration hygiene, type fidelity, and access-pattern fit; gated by a persistence-layer applicability probe so DB-less repos skip cleanly.
---

# Data Model & Persistence Audit

## Role

Data Modeler & Database Reliability Engineer

## Context & Objective

Analyze the project's persistence layer — its ORM model definitions, the schema
migrations those definitions are supposed to produce, and the seed data that
populates them — as a first-class artifact. Your goal is to find where the
model, the migrations, and the runtime schema silently disagree, where an
invariant the application assumes is not actually enforced by a constraint, and
where a migration is unsafe to run against a live database.

This lens is **only applicable to a project that has a persistence layer.** A
repository with no ORM dependency, no migrations directory, and no tracked
`.prisma` / `.sql` schema files has nothing for this lens to read: resolve
**not applicable** and emit the explicit not-applicable report (below) rather
than empty findings. The applicability probe (`hasPersistenceLayer` in
[`lib/audit-suite/selector.js`](../scripts/lib/audit-suite/selector.js), gated
by `target: "data-model"` in
[`schemas/audit-rules.json`](../schemas/audit-rules.json)) makes this decision
automatically in `/deliver` and plan-run modes; in a manual invocation you MUST
make the same determination yourself before reading anything else.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Execution strategy (dual-path)

This lens runs along one of two execution paths (orchestrated dynamic-workflow
or sequential single-pass). Both emit the **identical** Step 3 report contract;
downstream consumers (`audit-to-stories`) are agnostic to which path produced
it. See [`helpers/audit-dual-path.md`](helpers/audit-dual-path.md) for strategy
selection, the forcing flags, and the read-only guarantee — read `audit-<lens>`
there as this lens's name.

In scoped mode, restrict analysis to the changed models and migrations plus
their **direct dependents** — a model related to a changed model, a migration
ordered after a changed one. A Story that adds a destructive migration is the
canonical routed case: the change set names the migration and the models it
rewrites, and this lens inspects exactly that surface.

## Step 1: Applicability & Persistence-Surface Discovery

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

First confirm the project **has a persistence layer** (see Context above). If it
does not, stop and emit the not-applicable report. If it does, discover the
persistence surface, preferring **tool-first** detection over hand-reading where
the consumer ships the tooling:

- **ORM drift tooling (preferred):** When the consumer ships an ORM CLI, run its
  read-only drift/status command and treat its output as primary evidence —
  `prisma migrate diff` / `prisma migrate status`, `drizzle-kit check`, or
  `typeorm schema:log`. These report exactly where the model definitions and the
  migration history disagree without a live database.
- **Read-only file fallback:** When no ORM CLI is present (or it needs a live
  database this audit must not touch), fall back to reading the model
  definitions, the migration files, and the seed scripts directly. This
  fallback is always available and never mutates state.
- **Model & schema inventory:** Enumerate the ORM model/entity definitions and
  the schema files (`schema.prisma`, `*.sql`, entity classes) they map to.
- **Migration history:** Enumerate the ordered migration files and note which
  are applied, pending, or manually edited after generation.
- **Seed & fixture data:** Locate seed scripts and fixtures that assume a
  particular shape, so drift against them surfaces too.

## Step 2: Evaluation Dimensions

Evaluate the persistence layer along these five dimensions:

1. **Model↔migration↔seed drift:** Do the ORM model definitions match the schema
   the migrations actually produce, and do the seeds/fixtures match both? Flag a
   column, index, enum, or relation present in the model but never migrated (or
   migrated but dropped from the model), and seed data that would violate the
   current schema.
2. **Constraint completeness:** Is every invariant the application code silently
   assumes actually enforced by a constraint? Flag missing foreign-key, unique,
   not-null, and check constraints; stringly-typed columns that should be a
   database enum; orphanable relations with no FK or cascade rule; and
   cascade-delete behavior that is either missing (orphans) or too aggressive
   (unintended wide deletes).
3. **Migration hygiene:** Is each migration safe to run against a live database?
   Flag irreversible/destructive steps (a `DROP` / data-losing change with no
   documented rollback), non-null columns added without a default or a backfill,
   **expand-contract** violations (a single migration that both adds and removes
   in a way that breaks a rolling deploy), and ordering/idempotency hazards that
   make a migration unsafe to re-run or apply out of order.
4. **Type fidelity:** Do column types match the domain? Flag money stored as a
   float (rounding loss), timezone-less timestamps, bare-string IDs where a
   typed/UUID column belongs, and over-wide or under-wide numeric types.
5. **Access-pattern fit:** Does the schema fit how the code queries it? Flag
   unindexed foreign keys and unindexed frequent filter columns, relations that
   force N+1 access, and soft-delete rows that leak through default queries
   because no default scope excludes them.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-data-model-results.md`, using the exact template
below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

When the project **has a persistence layer**, use the findings template:

```markdown
# Data Model & Persistence Audit Report

## Executive Summary

[Overview of the persistence layer's health, plus the `kept <k> / dropped <d>`
self-cross-check counts from the mandatory step below.]

## Detailed Findings

[For every issue identified, use the following strict structure. Lead each
title with the primary file the issue lives in:]

### `path/to/migration-or-model.ext` — [Short title of the issue]

- **Dimension:** [e.g., Drift | Constraint Completeness | Migration Hygiene | Type Fidelity | Access-Pattern Fit]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/migration-or-model.ext:line`
- **Current State:** [Technical explanation of the drift, missing constraint,
  or unsafe migration step — cite the model definition and the migration it
  disagrees with]
- **Recommendation & Rationale:** [The specific corrective migration or
  constraint, and the failure it prevents]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. `prisma migrate status` clean, a constraint present in the schema, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`

## Low-Hanging Fruit

- [List up to 3 low-risk schema/constraint fixes that provide immediate safety gains.]
```

When the project has **no persistence layer**, emit the explicit
not-applicable report instead — never empty findings — and stop:

```text
# Data Model & Persistence Audit Report

## Executive Summary

**Not applicable** — this project has no persistence layer (no ORM dependency,
no migrations directory, and no tracked `.prisma` / `.sql` schema files), so the
data-model lens has nothing to inspect and was skipped.

## Detailed Findings

_None — lens not applicable._
```

## Constraint

This is a **read-only** audit over repo-observable state only — schema files,
migrations, ORM config, and read-only ORM drift/status commands. It MUST NOT
connect to, read from, or mutate a production database; it MUST NOT run a
migration or a destructive ORM command. API-contract/serialization coverage is
out of scope (deferred `audit-contract-compat` territory), and runtime query
profiling belongs to `audit-performance`, which owns measured behavior.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
