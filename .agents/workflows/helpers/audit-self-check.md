# Audit finding self-cross-check (shared)

> **Single source of truth for the sequential-path false-positive guard
> (Story #4627).** Every non-retired audit lens references this file and runs
> this pass over its Detailed Findings before finalizing its report. The
> orchestrated dynamic-workflow path already fans out an independent
> adversarial reviewer; this pass gives the **sequential single-pass** path —
> the one consumer runs take, where the npm payload ships no per-lens
> `*.workflow.js` — the same false-positive filter, so a lens cannot report an
> unverified finding just because it ran single-pass.

You are your own adversarial reviewer. After you have drafted the Detailed
Findings but **before** you write the report artifact, re-open every finding
and hold it to the bar below. This pass is **read-only** — it filters and
tightens the findings you already have; it never invents new ones.

## Per-finding evidence bar (keep or drop)

Keep a finding only when **all** of the following hold. Drop it otherwise.

- **Grounded location** — it names a concrete `path:line` (or a concrete
  symbol / config key) that you have actually read, not a hypothetical or a
  "somewhere in the codebase" claim.
- **Reproducible evidence** — the problem is backed by an observable: a tool
  reading (a baseline row, a complexity/MI/duplication number, a failing
  command), a quoted code snippet, or a specific standard it violates. A
  finding whose entire basis is "this looks wrong" does not clear the bar.
- **In-scope** — when a change-set scope filter was supplied (the `Scope`
  block resolved to a file list), the finding lives in that scope or a direct
  dependency the lens explicitly reasons across. A finding outside the scope
  filter is dropped, not reported.
- **Actionable** — the recommendation is specific enough to execute. Drop
  vague exhortations ("improve error handling generally") that carry no
  concrete change.

## Exclusion list (never a finding)

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

## Final re-open-and-drop pass (mandatory)

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
