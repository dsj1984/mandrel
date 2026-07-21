# Audit lens core (shared contract)

> **Single source of truth for every audit lens's shared machinery
> (Story #4665).** Each `audit-<lens>.md` workflow references this file instead
> of re-stating the blocks below. A lens carries only its own frontmatter, a
> short preamble, its `{{changedFiles}}` fence, and its genuinely lens-specific
> dimensions / detection batteries / applicability gates / boundary
> demarcations. Everything a lens shares with every other lens — the read-only
> constraint, scope interpretation, the report envelope and finding-block
> skeleton, the severity scale, the self-cross-check, and the execution
> strategy — lives here.
>
> This file absorbs the three retired helpers `audit-severity-scale.md`,
> `audit-self-check.md`, and `audit-dual-path.md`.

## Read-only constraint {#read-only}

Every audit lens is a **read-only** analysis. Do **not** modify application
code, styles, configuration, dependencies, branches, or labels. Surfacing the
findings is the deliverable; fixing them is a separate pass. The **only** write
a lens performs is its report artifact (plus, where a lens explicitly declares
it, a single measurement/baseline artifact named in that lens's own
Constraint). A lens that names a stricter or looser read-only carve-out in its
own body (e.g. performance's non-mutating measurements, quality's permitted
committed-baseline reads, data-model's no-database rule) refines this shared
constraint for that lens only.

## Scope interpretation (Story / plan-run mode) {#scope-interpretation}

Each lens carries its own `{{changedFiles}}` fence — the substitution anchor
consumed by `.agents/scripts/lib/audit-suite/` — and reads it as follows:

- When this lens is invoked from `/deliver` close lenses (or a plan-run audit),
  the fence is populated with the Story (or plan-run) change-set file list.
  **Restrict analysis to those files** (and their direct dependencies when the
  lens explicitly calls for cross-file reasoning).
- Otherwise — for any manual `/audit-<lens>` invocation — the fence renders the
  literal string `{{changedFiles}}`. Treat that as **no scope filter — run the
  lens codebase-wide** exactly as if the block were absent.

A handful of lenses deliberately deviate (documentation intersects the fence
with its config-driven target set; navigability always evaluates the whole
route tree regardless of the fence). Those lenses state their deviation in
their own Scope section; every other lens follows the rule above verbatim.

## Report envelope & finding-block skeleton {#report-envelope}

Each lens writes exactly one structured Markdown report to
`{{auditOutputDir}}/audit-<lens>-results.md` (the lens preamble names its own
path). The report MUST include every section its lens template mandates — write
`_No findings._` rather than omitting a section — and always an
`## Executive Summary` and a `## Detailed Findings` section. The Executive
Summary carries the self-cross-check `kept <k> / dropped <d>` line
([below](#self-cross-check)).

Every finding under `## Detailed Findings` uses the shared 7-field skeleton
below. A lens may **add** fields (e.g. a WCAG success criterion, a CWE ID, a
`Baseline MUST`, a `Route / Door` + `Persona(s)` pair, an `Evidence` tag) and
may **relabel** the two normalized axes — `Severity` ↔ `Impact`, `Dimension` ↔
`Category` ↔ `Type` — as its preamble declares; the parser
(`lib/audit-to-stories/parse-audit-md.js`) recognizes every variant. It never
drops or renames a shared field.

```markdown
## Executive Summary

[The lens's headline read plus the self-cross-check `kept <k> / dropped <d>`
line. A lens may mandate additional report sections between here and the
findings — its own body names them.]

## Detailed Findings

[For every finding, use the following strict structure. Lead each title with
the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [the lens-specific dimension — see the lens's own list]
- **Severity:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [the specific file/line/module and why it is problematic]
- **Recommendation & Rationale:** [how to remediate and why it matters]
- **Acceptance signal:** [the command or observable that proves this finding is
  remediated — e.g. a grep that now returns empty, an added regression test, or
  a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this remediation independently]`
```

## Severity scale {#severity-scale}

Every finding grades its severity (labelled `Severity` or `Impact`) on this
ordered scale. `parse-audit-md.js` recognizes every level, and a surviving
**Critical** finding halts the delivery gate
(`lib/audit-suite/findings.js#hasSurvivingCritical`).

- **Critical** — an active, exploitable, or data-losing defect that must be
  fixed before the change can ship (e.g. a leaked secret, an auth bypass, a
  guaranteed production outage or data-loss path).
- **High** — a serious correctness, security, or maintainability risk that
  should be fixed promptly, but does not by itself block the release.
- **Medium** — a real problem worth scheduling; contained blast radius, or a
  reasonable workaround exists.
- **Low** — minor or cosmetic; fix opportunistically.

## Self-cross-check (mandatory — filter false positives before you finalize) {#self-cross-check}

You are your own adversarial reviewer. After you have drafted the Detailed
Findings but **before** you write the report artifact, re-open every finding
and hold it to the bar below. This pass is **read-only** — it filters and
tightens the findings you already have; it never invents new ones. It gives the
sequential single-pass path the same false-positive filter the orchestrated
path's independent adversarial reviewer applies.

### Per-finding evidence bar (keep or drop)

Keep a finding only when **all** of the following hold. Drop it otherwise.

- **Grounded location** — it names a concrete `path:line` (or a concrete
  symbol / config key) that you have actually read, not a hypothetical or a
  "somewhere in the codebase" claim.
- **Reproducible evidence** — the problem is backed by an observable: a tool
  reading (a baseline row, a complexity/MI/duplication number, a failing
  command), a quoted code snippet, or a specific standard it violates. A
  finding whose entire basis is "this looks wrong" does not clear the bar.
- **In-scope** — when a change-set scope filter was supplied (the fence
  resolved to a file list), the finding lives in that scope or a direct
  dependency the lens explicitly reasons across. A finding outside the scope
  filter is dropped, not reported.
- **Actionable** — the recommendation is specific enough to execute. Drop
  vague exhortations ("improve error handling generally") that carry no
  concrete change.

### Exclusion list (never a finding)

Treat the following as **out of scope by construction** and drop any finding
that rests on one of them:

- **Sanctioned test seams** — exports consumed only by tests, and other
  patterns the `test-seams` rule blesses. Never a production defect.
- **Entry points & public API surface** — CLI mains, `bin/` scripts, declared
  `exports` / `bin` / `main`, and barrel contracts consumed out-of-tree. A
  zero in-repo consumer count is not death.
- **Dynamic / framework reachability** — symbols reached via `import()`,
  string-keyed dispatch, decorators, lifecycle listeners, or convention-loaded
  plugin directories. Invisible to static analysis, not dead.
- **Intentional, documented deviations** — a pattern an in-tree comment, ADR,
  or config explicitly sanctions. Cite it and drop the finding.
- **Style-only nits already enforced by a formatter/linter** — do not
  re-litigate what the committed tooling already governs.

### Final re-open-and-drop pass (mandatory)

1. Walk your Detailed Findings once more, applying the bar and the exclusion
   list above. Remove every finding that fails.
2. Count what you kept (`k`) and what you dropped (`d`).
3. Record the outcome in the report's **Executive Summary** as a single line:

   ```text
   Self-cross-check: kept <k> / dropped <d>.
   ```

   When `d > 0`, name the dropped findings (title + the bar/exclusion reason)
   in one short list under that line, so the filtering is auditable and never
   silent.

A lens that keeps every finding still records `dropped 0` — the line's absence
is itself a defect (it means the pass did not run).

## Execution strategy {#execution-strategy}

A lens is a self-contained, read-only unit of work — exactly the shape a
role-scoped subagent is for. Run it along the first path below that is
available; every path emits the **identical** report contract (the finding-block
skeleton above), so downstream consumers (`audit-to-stories`) are agnostic to
which path produced it.

1. **Subagent dispatch (first-class).** Dispatch the lens as a single
   `subagent_type: auditor` call — the standalone boot context in
   [`../../agents/auditor.md`](../../agents/auditor.md) carries the read-only
   MUSTs, the finding-block skeleton, the severity scale, and the
   self-cross-check bar, so the child needs only the lens's own dimensions to
   run. The subagent returns the **report path plus the Executive Summary**
   (including the self-cross-check line); the parent never needs the full
   findings inline. This is the default: the auditor boots without the full
   project closure, so the spawn is cheap relative to running the lens inline
   in the parent's context.

   - **Per-dimension fan-out (heavyweight lenses).** `audit-architecture`,
     `audit-performance`, and `audit-documentation` carry enough independent
     dimensions to be worth fanning out: dispatch one `subagent_type: auditor`
     call **per dimension** in a single turn via
     [`parallel-tooling.md`](parallel-tooling.md) Rule 3, then **merge** the
     per-dimension findings under this file's self-cross-check (the merge is
     where cross-dimension duplicates and false positives are dropped). Respect
     the nesting-depth budget and the concurrency cap that Rule 3 documents.

2. **Sequential inline execution (documented fallback).** When subagent
   dispatch is unavailable, run the lens's steps turn-by-turn in the current
   context exactly as written, ending with the self-cross-check. This changes
   nothing about the report contract.

> **Orchestrated dynamic-workflow path (optimization note).** Six lenses ship a
> saved project workflow at `.claude/workflows/audit-<lens>.workflow.js` that,
> **when Claude Code dynamic workflows are available** (runtime is Claude Code,
> `disableWorkflows` unset, version `>= 2.1.154`), fans the dimensions out as
> parallel read-only subagents and runs an independent adversarial cross-check
> stage before synthesising the report. It derives its per-dimension prompts
> from the *lens* markdown at run time — the lens stays the single source of
> truth. This is a performance optimization over path 1, **not** a separate
> contract: strategy selection lives in
> [`../../scripts/lib/dynamic-workflow/capability.js`](../../scripts/lib/dynamic-workflow/capability.js)
> (`selectAuditStrategy`), and it is not covered by the No-Shim / hard-cutover
> rule in [`../../rules/git-conventions.md`](../../rules/git-conventions.md)
> because there is one report contract and only the execution strategy varies —
> the same capability-degradation pattern the protocol endorses for live-docs
> fallback. Force a path for testing with `MANDREL_AUDIT_STRATEGY=sequential`
> or `MANDREL_AUDIT_STRATEGY=orchestrated`; exercise the real disable signals
> with `CLAUDE_CODE_DISABLE_WORKFLOWS=1` or `disableWorkflows: true` in
> `.claude/settings.json`. On the orchestrated path the analysis subagents are
> granted only read/search tools (`Read`, `Grep`, `Glob`) — the single write is
> the final report artifact.

## Parallel tooling {#parallel-tooling}

When a lens batches independent reads/greps, runs a long shell (a scanner, a
profiler, a suite time), or fans out per-dimension, apply
[`parallel-tooling.md`](parallel-tooling.md): batch independent reads in one
turn (Rule 1), run long shells via `run_in_background` + `Monitor` (Rule 2),
and dispatch N independent units as N `Agent` calls in one turn (Rule 3).
