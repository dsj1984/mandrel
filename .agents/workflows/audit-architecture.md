---
description: Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity.
---

# Architecture & Clean Code Audit

You are a Staff Software Engineer & Architecture Reviewer performing a read-only
review that prioritizes maintainability and readability without altering
external APIs or business logic. The shared lens machinery — read-only
constraint, scope interpretation, report envelope + finding-block skeleton,
severity scale, self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-architecture-results.md`. Each finding carries an
**Impact:** and a **Category:** (`Quick Win | Structural Change`); the report
adds a **Triage Summary** (Quick Wins / Structural Changes) and an
**Architecture Guardrail Coverage** section.

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

This is a **heavyweight lens**: dispatch it as a single `subagent_type: auditor`
call, or fan its dimensions out per-dimension across parallel `auditor`
subagents (parallel-tooling Rule 3) and merge under the self-cross-check.
Sequential inline execution is the fallback (see the core's Execution strategy).

## Step 0: Tool-first detection (mandatory — run before any LLM dimension)

Ground every structural finding in a measured instrument this repo already
ships rather than free-associating over the source. Run the shipped checkers
**first** and treat their output as the spine of the report; the LLM
dimensions in Step 2 only *interpret, rank, and phrase* what the tools
surface. Skipping this step and reasoning about boundaries from prose alone is
the failure mode this lens exists to prevent.

1. **Cycle detection.** Run the shipped circular-dependency checker:

   ```bash
   node .agents/scripts/check-arch-cycles.js
   ```

   Each reported cycle is a grounded finding under the **Automated
   Architecture Guardrails** dimension. When the shipped checker is
   unavailable in the consumer project, fall back to
   `npx madge --circular <srcDir>` or
   `npx depcruise --validate <config> <srcDir>` (dependency-cruiser).

2. **Dead-export detection.** Run the shipped dead-export checker:

   ```bash
   node .agents/scripts/check-dead-exports.js
   ```

   Each unreferenced export is a grounded candidate. **Cede it** to
   audit-clean-code's Dead Code dimension rather than re-deriving it here (see
   the deferral in Step 2). When the shipped checker is unavailable, fall back
   to `npx knip --production` — and heed the `!`-suffix entry-pattern caveat
   that [`audit-clean-code`](audit-clean-code.md) documents, since
   `knip --production` is a silent no-op without it.

3. **Hotspot ranking.** Rank the modules the checkers implicate by
   **fan-in / fan-out** (how many modules import a file versus how many it
   imports) and by **churn** (e.g.
   `git log --format= --name-only -n 200 | sort | uniq -c | sort -rn`). A file
   that is both heavily depended upon and frequently churned is the
   highest-priority structural hotspot; lead the Triage Summary with it.

4. **LLM triage on top.** Only after the tools have run do you apply the Step 2
   dimensions to interpret, rank, and phrase the findings. A structural claim
   that no tool grounds and no Step 2 dimension covers does not belong in this
   report — route it to the ceded clean-code dimensions instead.

When a shipped checker exits non-zero or is genuinely absent, record that as an
**Automated Architecture Guardrails** finding (the guardrail is missing or
broken) rather than skipping the step silently.

## Step 1: Context Gathering (Read-Only Scan)

Before generating the report, silently scan the core application logic. Pay
special attention to:

- Domain/Business logic layers (e.g., services, use cases, managers).
- Utility and shared folders (e.g., `utils/`, `helpers/`, `shared/`).
- Data access patterns and component hierarchies.
- Complex or heavily modified files (look for large file sizes or deeply nested
  directory structures).

Additionally, gather signal for the **Automated Architecture Guardrails**
dimension below by looking for:

- **Documented architecture boundaries** — `docs/architecture.md`, ADRs
  (`docs/adr/**`, `docs/decisions/**`), per-package `README.md` files,
  module-level docs, or equivalent project documentation that names
  layers, feature boundaries, public entrypoints, or forbidden import
  paths.
- **Automated boundary checks** — `package.json` scripts, CI workflow
  files (`.github/workflows/**`, `.gitlab-ci.yml`, etc.), test suites
  asserting on module shape, lint configs
  (`.eslintrc*`, `eslint.config.*`) with `eslint-plugin-boundaries`,
  `eslint-plugin-import` (`no-restricted-paths`, `no-internal-modules`),
  or `@nx/enforce-module-boundaries`, `dependency-cruiser`
  (`.dependency-cruiser.*`) configs, `madge` configs or scripts,
  TypeScript project references (`tsconfig.*.json` `references`),
  workspace/package `exports` / `main` / `types` declarations restricting
  the public surface, and custom architecture-check scripts in
  `scripts/`, `tools/`, or equivalent.

Treat absence of evidence as a signal, not a failure — many codebases
legitimately have no layered architecture to guard.

## Step 2: Analysis Dimensions

For every finding you surface, grade **Impact** on a High / Medium / Low axis
reflecting the severity of the architectural risk (how much correctness,
maintainability, or testability the gap erodes), independent of the
**Category** effort axis — a Quick Win can still be High Impact, and a
Structural Change can be Medium. As a loose default, Quick Wins typically land
High (cheap to fix, real payoff) and Structural Changes Medium/High, but grade
Impact on the risk itself rather than deriving it mechanically from Category.

> **Boundary with `audit-clean-code`.** The clean-code-overlapping smells
> (over-engineering & abstractions, cognitive load & nesting, dead code &
> redundancy, naming & self-documentation, coupling & cohesion) are owned by
> [`audit-clean-code`](audit-clean-code.md); the Step 0 dead-export candidates
> flow into its Dead Code dimension. Do **not** duplicate them here. This lens
> keeps only the two structural dimensions no other lens owns — the
> testable-surface boundary and the automated-guardrail maturity.

Evaluate the gathered context against the following architecture dimensions:

1. **Testable Surface (Humble-Object Boundary):** Flag modules that interleave
   hard-to-test I/O — filesystem (`fs`), process spawning (`child_process`,
   `exec`, `spawn`), network calls, database access, or GUI/terminal
   rendering — directly with business logic. The humble-object /
   ports-and-adapters discipline says the environmentally-unsuitable shell
   (the part bound to the OS, the network, or a device) should stay thin and
   nearly logic-free, while the decision-making logic it wraps is extracted
   into a pure, separately-testable module. Identify functions where a
   branch, a calculation, or a validation rule can only be exercised by
   standing up a real file, a child process, or a socket, and recommend
   pulling that logic out behind a seam so it can be unit-tested in isolation
   with the I/O mocked at the boundary (per the unit-tier mocking rule in
   [`rules/testing-standards.md`](../rules/testing-standards.md)). Treat the
   ratio of testable logic to unsuitable shell as the property under review:
   maximize the former, minimize the latter. Severity grades by how much
   logic is trapped behind the boundary:
   - **High** — a substantial decision surface (multiple branches, a
     non-trivial algorithm, or a validation/parsing rule) is entangled with
     I/O such that it can only be reached through the live environment,
     leaving it effectively untested or covered only by slow,
     environment-dependent integration tests.
   - **Medium** — moderate logic is mixed with I/O; a seam is feasible and
     would meaningfully raise the unit-testable surface, but the current
     entanglement is contained to one module.
   - **Low** — thin or incidental coupling (e.g. a one-line transform beside
     a read) where extraction is optional polish rather than a testability
     win.

   For each finding, name the module/function, identify the trapped logic and
   the I/O it is bound to, and propose the concrete seam (the pure function or
   port to extract, and where the I/O adapter should call into it). This repo
   already practices a related seam discipline at the error-handling boundary:
   [`rules/orchestration-error-handling.md`](../rules/orchestration-error-handling.md)
   requires orchestration scripts to `throw` rather than `Logger.fatal` so the
   thin `runAsCli` shell — not the logic — owns the `process.exit` side effect,
   keeping the wrapped logic exercisable under a stubbed `process.exit`. Cite
   that precedent where it applies rather than restating it.
2. **Automated Architecture Guardrails:** Assess whether the project encodes
   its architectural boundaries as **deterministic, automated checks** rather
   than relying on convention or reviewer memory. When relevant to the
   consumer project's shape, evaluate enforcement for:
   - Layer direction (e.g., UI → application → domain → infrastructure;
     no upward imports).
   - Feature / module boundaries (sibling features cannot import each
     other's internals).
   - Server/client separation (server-only modules must not be imported
     from client bundles, and vice versa).
   - Workspace package boundaries (workspace packages only depend on
     declared workspace siblings; no cross-package deep imports into
     `src/`).
   - Public entrypoints (consumers import only from the package's
     declared `exports` / barrel, not from internal paths).
   - Circular dependencies (cycles between modules or packages).
   - Forbidden deep imports (e.g., reaching past `index.ts`, importing
     from `dist/`, or importing private `_internal` paths).

   Recommendations under this dimension MUST prefer **project-local,
   lightweight tooling** (an added ESLint rule, a `dependency-cruiser`
   config, a `npm run check:boundaries` script, a CI step) over
   Mandrel-owned harness changes. The audit is advisory: it surfaces the
   maturity gap and proposes the lightest fitting next step, but the
   consumer project owns adoption. Do not propose new Mandrel quality
   gates, baseline kinds, close-validation steps, dependencies, or
   harness subsystems under this dimension.

   **Scope-mode behavior.** When this lens is invoked in Story scope (the
   `{{changedFiles}}` fence is populated with a file list), the
   maturity assessment for this dimension is a repo-wide property that
   cannot be represented by a small changeset. In that case, render the
   `Architecture Guardrail Coverage` report section with maturity
   `Not Assessed — scoped run` and skip the per-axis evaluation. The
   full maturity assessment runs only in codebase-wide mode (when
   `{{changedFiles}}` renders as the literal substitution token).

### Maturity Rubric

Use these definitions to classify the project's `Architecture Guardrail
Coverage`. The rubric is a single axis; pick the highest level the
evidence supports.

| Level              | Definition                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strong**         | Documented boundaries **and** at least one automated check **and** CI enforcement (the check fails the build on violation).                                           |
| **Partial**        | Documented boundaries **or** at least one automated check exists, but the pair is incomplete or CI does not fail the build on violation.                              |
| **Missing**        | Neither documented boundaries nor automated checks exist for a codebase whose shape (layered, multi-package, server/client split, feature-sliced) would benefit from them. |
| **Not Applicable** | The codebase has no meaningful architectural layering to guard (e.g., a single-package utility repo, a one-file script, a flat content repo).                          |

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this lens's report carries its own title and two lens-specific sections:

```markdown
# Architecture & Clean Code Review

## Triage Summary

### Quick Wins (Low Effort, High Impact)

- [List 2–3 immediate, safe refactors.]

### Structural Changes (Medium/High Effort, Architectural Impact)

- [List 2–3 larger refactors.]

## Architecture Guardrail Coverage

- **Current Maturity:** [Strong | Partial | Missing | Not Applicable | Not Assessed — scoped run]
- **Documented Boundaries / Automated Checks Found / CI Enforcement / Axes Covered / Recommended Next Step:** [per the Maturity Rubric — a single lightest project-local improvement, advisory only, no Mandrel-owned harness changes]
```

In a Story-scoped run set `Current Maturity` to `Not Assessed — scoped run` and
mark the remaining fields `n/a`; the full maturity assessment runs only in
codebase-wide mode.
