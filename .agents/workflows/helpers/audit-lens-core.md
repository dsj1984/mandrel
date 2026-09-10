# Audit lens core (shared contract)

> **Single source of truth for every audit lens's shared machinery.**
> Each `audit-<lens>.md` workflow references this file instead
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

- When this lens is invoked from `/mandrel-deliver` close lenses (or a plan-run audit),
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
([below](#self-cross-check)) and, beside it, the machine-readable severity
tally ([below](#severity-tally)).

Every finding under `## Detailed Findings` uses the shared 7-field skeleton
below. A lens may **add** fields (e.g. a WCAG success criterion, a CWE ID, a
`Baseline MUST`, a `Route / Door` + `Persona(s)` pair, an `Evidence` tag) and
may **relabel** the two normalized axes — `Severity` ↔ `Impact`, `Dimension` ↔
`Category` ↔ `Type` — as its preamble declares; the parser
(`lib/audit-to-stories/parse-audit-md.js`) recognizes every variant. It never
drops or renames a shared field.

```markdown
## Executive Summary

[The lens's headline read, the self-cross-check `kept <k> / dropped <d>` line,
and the severity tally line below. A lens may mandate additional report
sections between here and the findings — its own body names them.]

Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>

## Detailed Findings

[For every finding, use the following strict structure. Lead each title with
the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [the lens-specific dimension — see the lens's own list]
- **Severity:** [Critical | High | Medium | Low | Info]
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

Every finding grades its severity (labelled `Severity` or `Impact`) on the
ordered scale below. **The code owns this vocabulary**: it is defined in
[`lib/findings/severity.js`](../../scripts/lib/findings/severity.js)
(`SEVERITIES`), and every level here — including its accepted spellings — comes
from that module. A surviving **Critical** finding halts the delivery gate
(`lib/audit-suite/findings.js#hasSurvivingCritical`).

Grade on **exactly** these five levels. A level of your own invention does not
parse: it resolves to no severity, tallies as `unknown`, and the finding is
dropped by every severity-filtered run — including the most permissive one. A
dropped finding is indistinguishable from a finding you never wrote.

- **Critical** — an active, exploitable, or data-losing defect that must be
  fixed before the change can ship (e.g. a leaked secret, an auth bypass, a
  guaranteed production outage or data-loss path).
- **High** — a serious correctness, security, or maintainability risk that
  should be fixed promptly, but does not by itself block the release.
- **Medium** — a real problem worth scheduling; contained blast radius, or a
  reasonable workaround exists.
- **Low** — minor or cosmetic; fix opportunistically.
- **Info** — the canonical floor: a real, grounded observation worth recording
  that asks for no scheduled work (a documented deviation worth noting, a
  measurement that is fine today and worth watching). Accepts `Informational`.
  Use it instead of inventing a below-`Low` word of your own; a finding that
  cannot clear the evidence bar below is **dropped**, not filed as `Info`.

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

> **Boundary with the dead-wiring mandate.** The architecture and quality lenses
> are required to report shipped seams with no live production caller (their own
> bodies carry the mandate). The exclusions above **bound** that mandate rather
> than cancelling it: a test seam, a CLI entry point, a declared `exports`
> surface, or a dynamically-reached symbol is still never a finding. What the
> mandate targets is the case none of those cover — an **internal** seam that a
> delivery shipped and nothing in production ever calls. When a candidate is
> genuinely one of the exclusions, cite the exclusion and drop it.

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

## Severity tally (mandatory, machine-readable) {#severity-tally}

The Executive Summary MUST also carry exactly one tally line, counting the
findings you kept:

```text
Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>
```

Write every bucket, zeros included, and never count `Info` — the scale already
excludes it from scheduled work. This line is the report's own checksum:
`audit-to-stories --scan` cross-checks it against the findings its parser
extracted and names any disagreement as a **report failure**
(`summary.reportFailures[]`), and `--auto` refuses to file anything from a
report whose line is missing or wrong. A parse that silently drops findings is
otherwise indistinguishable from a clean audit.

## Runtime pass scaffold {#runtime-pass}

Some lenses corroborate their static findings against a live target. Static
detection is the default and always runs; the runtime pass is **conditional** —
it runs only when a live target and the browser tooling are both available, and
its absence never blocks the static report. The steps below are shared by every
lens that has one, so a lens documents only its own probe.

1. **Resolve the target from config — never a hardcoded URL.** Resolve through
   the consumer's `qa.environments.<env>.baseUrl` (via
   [`resolveQaEnvironment`](../../scripts/lib/qa/resolve-qa-contract.js), the
   same resolver `/qa-run` uses): an `<env>` argument resolves by exact name or
   origin match; with no argument, enumerate `name → baseUrl` and let the
   operator pick.
2. **Sample routes from the navigability SSOT.** Draw the routes to exercise
   from the consumer's route/nav registry (`planning.navigation.navRegistry` /
   `routeGlobs` — the same SSOT
   [`/audit-navigability`](../audit-navigability.md) reads), sampling a
   representative set (key personas' landing routes plus any route in the
   change-set scope) rather than a single hardcoded page.
3. **Run the lens's own probe** against each sampled route. That step, and only
   that step, is the lens's to document.
4. **Median-of-3 or provisional.** Any runtime measurement is subject to
   run-to-run variance: capture a **median-of-3** (three runs per route, report
   the median) before treating a number as authoritative. A single-run value is
   reported **provisional** and never drives a Critical/High verdict on its own.
5. **Leave the environment as you found it.** Reset any emulation — viewport,
   device profile, colour scheme — before finishing, so a following lens or QA
   run does not inherit it.

**Skip reasons, and how to report them.** The pass is skipped, never faked, for
either of two reasons, and the Executive Summary says which:

| Condition | Reported as |
| --- | --- |
| No `qa.environments` target is configured | `skipped — no target configured` |
| The browser tooling is unavailable in this runtime | `skipped — browser tooling unavailable` |

The second is the one an unattended sweep meets: a scheduled run has no browser
MCP server attached, so a lens that treated "cannot drive" as "nothing found"
would report a clean runtime section it never ran. Do not invent a URL, do not
start an arbitrary dev server, and do not fall back to a static-only claim
dressed as a runtime one — name the skip and let the static findings stand on
their own.

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
> contract, and it is not covered by the No-Shim / hard-cutover rule in
> [`../../rules/git-conventions.md`](../../rules/git-conventions.md) because
> there is one report contract and only the execution strategy varies — the
> same capability-degradation pattern the protocol endorses for live-docs
> fallback. **The host owns the choice.** Mandrel ships no in-repo strategy
> selector and no force-override env var: Claude Code launches the saved
> workflow when it can, and you get path 1 or 2 above when it cannot.
> Suppress the orchestrated path with `CLAUDE_CODE_DISABLE_WORKFLOWS=1`
> or `disableWorkflows: true` in `.claude/settings.json`. On the orchestrated
> path the analysis subagents are granted only read/search tools (`Read`,
> `Grep`, `Glob`) — the single write is the final report artifact.

## Parallel tooling {#parallel-tooling}

When a lens batches independent reads/greps, runs a long shell (a scanner, a
profiler, a suite time), or fans out per-dimension, apply
[`parallel-tooling.md`](parallel-tooling.md): batch independent reads in one
turn (Rule 1), run long shells via `run_in_background` + `Monitor` (Rule 2),
and dispatch N independent units as N `Agent` calls in one turn (Rule 3).
