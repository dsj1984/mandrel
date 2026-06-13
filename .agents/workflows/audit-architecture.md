---
description: Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity.
---

# Architecture & Clean Code Audit

## Role

Staff Software Engineer & Architecture Reviewer

## Context & Objective

You are performing a comprehensive, read-only architectural and clean-code
review of this codebase. Your goal is to identify areas of unnecessary
abstraction, premature optimization, high cognitive load, and over-engineering.
You must prioritize maintainability and readability without altering any
existing external APIs or business logic.

## Execution strategy (dual-path)

This lens runs along one of two execution paths. Both emit the **identical**
report contract (Step 3); downstream consumers (`/deliver` Phase 4
epic-audit, `audit-to-stories`) are agnostic to which path produced it.

- **Orchestrated (dynamic-workflow) path.** When Claude Code's
  [dynamic workflows](https://code.claude.com/docs/en/workflows) are
  available, the saved project workflow
  `.claude/workflows/audit-architecture.workflow.js` fans the dimensions below
  out as parallel read-only subagents, runs an **adversarial cross-check**
  stage (an independent agent reviews each dimension's findings and drops
  false positives before they enter the report), then synthesises the Step 3
  report. The orchestrator derives its per-dimension prompts from *this*
  markdown at run time — the lens stays the single source of truth; the
  script does not fork a second copy of the spec.
- **Sequential (single-pass) path.** When dynamic workflows are unavailable,
  follow Steps 1–3 below turn-by-turn exactly as before. This is the default
  fallback and changes nothing about the existing behaviour.

**Strategy selection** is computed by
[`lib/dynamic-workflow/capability.js`](../scripts/lib/dynamic-workflow/capability.js)
(`selectAuditStrategy`). The orchestrated path is chosen only when the runtime
is Claude Code, `disableWorkflows` is not set (settings.json **or**
`CLAUDE_CODE_DISABLE_WORKFLOWS`), and the Claude Code version meets the
research-preview floor (`>= 2.1.154`). Any other runtime, a disabled setting,
or an older version degrades gracefully to the sequential path.

> **Capability degradation, not a contract shim.** This dual path is **not**
> covered by the No-Shim / hard-cutover rule in
> [`git-conventions.md`](../rules/git-conventions.md). That rule forbids
> running two shapes of the *same contract* side by side. Here there is **one**
> report contract; only the *execution strategy* is selected from a runtime
> capability — the same pattern the protocol already endorses for live-docs
> fallback in [`instructions.md` §1.C/§1.D](../instructions.md). The full
> capability-degradation rationale lives in the
> [`capability.js`](../scripts/lib/dynamic-workflow/capability.js) module
> docstring; the orchestrated-run evidence and per-lens cost/precision gate
> verdicts live in [`docs/roadmap.md`](../../docs/roadmap.md) (Part 3 —
> Dynamic-Workflow Orchestration).

**Forcing a path (for testing).** Set `MANDREL_AUDIT_STRATEGY=sequential` to
verify the fallback path with the feature notionally disabled, or
`MANDREL_AUDIT_STRATEGY=orchestrated` to pin the dynamic path. To exercise the
real disable signals instead, set `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env) or
`disableWorkflows: true` in `.claude/settings.json` and re-run the lens — both
degrade to the sequential path.

> **Read-only on both paths.** The lens is read-only (see Constraint). The
> orchestrated subagents run in `acceptEdits` and inherit the session tool
> allowlist, but the workflow script grants the analysis agents only
> read/search tools (`Read`, `Grep`, `Glob`) — no write/edit/shell-mutation
> tools. The single write in an orchestrated run is the final report artifact.

## Scope (Epic mode)

When this lens is invoked from `/deliver` Phase 4 (epic-audit), the
following block is populated with the Epic's change-set file list.
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

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

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

Evaluate the gathered context against the following clean code dimensions:

1. **Over-Engineering & Abstractions:** Identify "dry-run" complexity, premature
   optimizations, or interfaces/classes that add boilerplate without clear value
   (e.g., interfaces with only one implementation).
2. **Cognitive Load & Nesting:** Pinpoint deeply nested logic (arrow code),
   massive functions violating the Single Responsibility Principle (SRP), or
   excessive cyclomatic complexity.
3. **Dead Code & Redundancy:** Locate unused exports, redundant utility
   functions that duplicate standard library features, or obsolete commented-out
   code blocks.
4. **Naming & Self-Documentation:** Find poorly named variables/functions,
   inconsistent naming conventions, or areas that rely heavily on comments to
   explain *what* the code does rather than *why*.
5. **Coupling & Cohesion:** Spot tight coupling between modules that should be
   independent or god-objects handling too many concerns.
6. **Testable Surface (Humble-Object Boundary):** Flag modules that interleave
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
7. **Automated Architecture Guardrails:** Assess whether the project encodes
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

   **Scope-mode behavior.** When this lens is invoked in Epic mode (the
   `{{changedFiles}}` block above is populated with a file list), the
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

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-architecture-results.md`, using the exact template
below.

```markdown
# Architecture & Clean Code Review

## Executive Summary

[Provide a brief overview of the codebase's health, highlighting the primary
architectural pain points and areas for simplification.]

## Triage Summary

### Quick Wins (Low Effort, High Impact)

- [List 2–3 immediate, safe refactors — e.g., deleting dead code, renaming
  variables, extracting simple utilities.]

### Structural Changes (Medium/High Effort, Architectural Impact)

- [List 2–3 larger refactors — e.g., decoupling services, flattening complex
  module hierarchies, removing unnecessary design patterns.]

## Architecture Guardrail Coverage

[Codebase-wide mode: complete this section using the maturity rubric in
Step 2. Epic-mode / scoped run: set `Current Maturity` to
`Not Assessed — scoped run` and leave the remaining fields empty or
marked `n/a`.]

- **Current Maturity:** [Strong | Partial | Missing | Not Applicable | Not Assessed — scoped run]
- **Documented Boundaries:** [Files / sections that name the architecture
  boundaries — e.g., `docs/architecture.md § Layering`, ADR-0007. State
  `none found` if absent.]
- **Automated Checks Found:** [Tooling and config paths — e.g.,
  `dependency-cruiser` at `.dependency-cruiser.cjs`,
  `eslint-plugin-boundaries` rules in `eslint.config.js`,
  `tsconfig.json` `references`. State `none found` if absent.]
- **CI Enforcement:** [Whether a CI job runs the checks and fails the
  build on violation — name the workflow file and job. State `not
  enforced in CI` if the check runs only locally, or `n/a` if no check
  exists.]
- **Axes Covered:** [Tick the axes from Step 2 that have at least one
  automated check — layer direction, feature/module boundaries,
  server/client separation, workspace package boundaries, public
  entrypoints, circular dependencies, forbidden deep imports. Mark
  axes that don't apply to this codebase's shape as `n/a`.]
- **Recommended Next Step:** [The single lightest fitting project-local
  improvement — e.g., "add `dependency-cruiser` with a
  `no-circular` rule and wire `npm run check:arch` into the existing
  CI lint job". Advisory only; the consumer project owns adoption. Do
  not propose Mandrel-owned harness changes.]

## Detailed Findings

[For every gap identified, use the following strict structure:]

### [Short Title of the Issue]

- **Impact:** [High | Medium | Low]
- **Category:** [Quick Win | Structural Change]
- **Dimension:** [e.g., Cognitive Load & Nesting | Testable Surface (Humble-Object Boundary) | Automated Architecture Guardrails]
- **Current State:** [The specific file/function and why it is problematic]
- **Recommendation & Rationale:** [The specific refactor strategy and how it
  improves readability or maintainability]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this refactor independently. Must explicitly state NOT to change external APIs.]`
```

---

## Constraint

Do NOT execute any code modifications, edit files, create branches, or implement
changes. This is strictly a read-only analysis. Ensure all recommendations
preserve existing functionality and external APIs. Output the report and stop.
