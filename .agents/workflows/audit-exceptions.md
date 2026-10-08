---
description: Audit every exception and escape valve — inline suppressions, tool-config exemptions, dependency overrides, patches and allowlists, CI gate exemptions, test skips and code allowlists — and flag the ones that are dead, expired, orphaned, unjustified, or papering over a real fix.
---

# Exception & Override Audit

You are a Principal Engineer auditing this repository's **escape valves**.
Every gate only prevents regression, and every exception is a way around one:
an `eslint-disable`, a dependency override, a patched package, an allowlisted
advisory, a skipped test, a `KNOWN_*` list. Nothing else checks whether they
still earn their place, so they pile up unnoticed. This lens is that check,
and it is read-only. The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-exceptions-results.md`. Dimension values:
`Dead | Expired | Orphaned | Unjustified | Fix Properly`.

> **Value-free titles (mandatory).** A finding title MUST NOT embed a count,
> a version or a date — write ``### `package.json` — npm overrides no longer
> needed``, not ``… — 3 overrides redundant since 4.3.2``. Every re-run
> re-measures, so a title carrying the reading changes each pass, its
> fingerprint changes with it, and `/audit-to-stories` files a duplicate
> instead of deduping against the open Story. Numbers belong in Current State.

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

When the fence resolves to a file list (a Story or plan-run audit), this lens
reports **only newly added escape valves**: run Step 0 with
`--changed-since origin/<baseBranch>` (`project.baseBranch`, default `main`)
and keep a record only when `introduced` is `true`, its `file` is in the
fence, and it is `unjustified` or carries no `ticketRefs`. Everything older is
a codebase-wide concern; leave it to a manual run. When the fence renders
literally, run codebase-wide.

## Constraint (lens-specific carve-out)

This lens **refines** the core's read-only constraint; it never relaxes it.

- The only command it runs is the read-only engine in Step 0. With `--probe`
  the engine also runs the analysed repo's own biome, eslint, `tsc` and knip
  to read their unused-suppression reports. They run without any write or fix
  flag, and the engine never evaluates the repo's code or JS-format configs.
- It never removes, edits or re-justifies an exception, and never touches a
  lockfile or `node_modules`. **Removal is a finding, never an in-run step.**
- Gitignored local overrides (`.agentrc.local.json`,
  `.agents/instructions.local.md`) are operator-owned and out of scope; the
  engine reads tracked files only, so they never appear.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

## Step 0: Run the engine (mandatory — measure before you judge)

```bash
node .agents/scripts/audit-exceptions.js --out temp/audit-exceptions/envelope.json
```

Optional flags: `--probe` (also read each installed tool's own report of
suppressions that suppress nothing; slower, and worth it on a codebase-wide
run with large inline clusters), `--changed-since <ref>` (scoped mode, above),
`--ticket-limit`, `--blame-limit` and `--max-records` (caps; each cap that
bites is named in `degradations`). Exit 0 means evidence was assembled
**including every degraded input**; exit 1 means no envelope exists — report
that and stop.

The envelope is validated against
`.agents/schemas/audit-exceptions-envelope.schema.json` and is this lens's
sole evidence base. Cite its fields by name:

| Section | Fields you cite |
| --- | --- |
| root | `isFrameworkSource`, `options`, `degradations`, `truncated` |
| `adapters[]` / `skipped[]` | `id`, `category`, `recordCount` / `reason` |
| `delegated[]` | `surface`, `lens`, `reason` |
| `clusters[]` | `adapter`, `category`, `rule`, `count`, `byVerdict`, `files` |
| `records[]` | `file`, `line`, `surface`, `target`, `rule`, `justification`, `ticketRefs`, `expires`, `addedAt`, `introduced`, `verdict`, `verdictBasis`, `probeBasis`, `permanentHint` |

`verdict` is the engine's mechanical call, first match wins: `dead` (a probe
proved it exempts nothing), `expired` (its stated date is past), `orphaned`
(every ticket it waits on is closed), `unjustified` (no reason and no
ticket), `live`, or `unknown` (a probe could not decide). `probeBasis` keeps
what the probe found even when a higher verdict won — an `unjustified`
override whose `probeBasis` is `dependent-needs-pin` is a different finding
from an unjustified `redundant` one.

Read these **before** any finding:

- **`degradations`.** Name every degraded input in the Executive Summary. A
  missing lockfile or `dependency-manifests-unavailable` means dependency
  pins could not be proven redundant; a `gh` or `origin` degradation means
  no record could read as orphaned. Never present a degraded verdict as a
  clean one.
- **`skipped[]`.** An adapter that did not apply is not a finding. List the
  skipped adapters in one line so a reader can tell "nothing found" from
  "nothing looked".
- **`delegated[]`.** `.agentrc.json` gate `ignoreGlobs` belong to
  `/audit-baselines`. Do not file them here.
- **`truncated`.** Non-null means `records[]` was capped. `clusters[]` still
  counts every record — grade from the clusters and say so.

## Step 1: Evaluation Dimensions

The engine has already decided four of the five dimensions mechanically. Your
judgment is the fifth, plus severity and routing.

1. **Dead.** `verdict: dead`. The exception exempts nothing: its package left
   the tree (`absent-from-tree`), every dependent already asks for a range
   inside the pin (`redundant`), a patch targets a version that no longer
   resolves (`version-drift`, `patch-file-missing`), a glob matches nothing
   (`matches-nothing`), an allowlisted path is gone (`path-missing`), or the
   tool itself reports it unused (`tool`). A dead exception also silently
   exempts the next thing that happens to match it. Grade a dead dependency
   pin or audit allowlist entry **Medium**, everything else **Low**.

2. **Expired.** `verdict: expired`. Its own justification set a date that has
   passed — someone promised to revisit it. Grade an expired audit allowlist
   entry **High** (a known advisory is being waved through past its agreed
   window), anything else **Medium**.

3. **Orphaned.** `verdict: orphaned`. The tickets it says it waits on
   (`TODO(#n)`, "until #n", "tracked in #n") are all closed, so either the
   fix landed and the exception should go, or the fix was abandoned and the
   exception needs a new owner. **Medium**.

4. **Unjustified.** `verdict: unjustified`. No reason and no ticket. Read
   `probeBasis` first: when the probe proved it still needed
   (`dependent-needs-pin`, `matches-tracked`), the remediation is to write
   the reason down, not to remove it. Grade an unjustified dependency
   exception or CI gate exemption **Medium**, an unjustified inline
   suppression **Low**.

5. **Fix Properly.** Your one judgment call, over `live` records only (and
   `unknown` ones whose context makes the answer clear). The exception still
   works, but it is covering for a defect that has a real fix: a suppression
   that hides a genuine bug class, an override pinning around an upstream fix
   that has since shipped, a skipped test hiding a broken code path, a CI
   step that may fail without consequence. Open the cited file and line
   before claiming it. Grade by what the exception hides — a disabled
   security rule or a `continue-on-error` on a required gate is **High**.

**Permanent is not a finding.** A record with a `permanentHint`
(`platform-conditional`, `untracked-path`, `conventional-setting`) or a
justification that states a lasting reason is legitimately forever. Count
it in the inventory; never file it.

**`unknown` is not `dead`.** An undecided probe is never evidence of
obsolescence. List `unknown` records under Undecided (below) and file one
only when you can show the answer from the code yourself.

## Step 2: Clustering and the dropped log

**Emit one finding per `(adapter, rule)` cluster — never one per record.**
Five hundred `eslint-disable no-await-in-loop` lines are one finding with one
remediation, not five hundred Stories. **Bundle every `dead` record of one
adapter into a single finding** whose remediation is removing them all, and
list each one's `file:line` in Current State.

Cap the Detailed Findings at **12 clusters**, ranked by severity, then
`count`. The report MUST carry a **Dropped Clusters** section naming every
cluster the cap excluded with its `adapter`, `rule` and `count`; write
`_None dropped._` when the cap did not bite.

## Step 3: Boundaries with sibling lenses

> This lens owns whether an exception is **still needed, justified and
> tracked**. Whether the thing it exempts is bad belongs elsewhere:
> [`/audit-baselines`](audit-baselines.md) owns gate `ignoreGlobs` and floors;
> [`/audit-dependencies`](audit-dependencies.md) owns outdated, unused and
> upgrade-batch decisions — a pin this lens calls redundant is its input, not
> its verdict; [`/audit-security`](audit-security.md) owns whether an
> allowlisted advisory is exploitable; [`/audit-quality`](audit-quality.md)
> owns the coverage impact of a skipped test; and
> [`/audit-clean-code`](audit-clean-code.md) owns the code smell an inline
> suppression may hide.

When a Fix Properly finding's real remediation belongs to one of those
lenses, say so in the Recommendation and name the lens rather than
re-auditing its domain here.

## Step 4: Agent Prompt templates

Substitute the envelope's own values for the angle-bracketed slots:

- **Dead bundle template:**
  `Remove the <adapter> exceptions the audit-exceptions engine proved dead: <file:line list>. Each one exempts nothing (<verdictBasis>). Delete each entry, then re-run node .agents/scripts/audit-exceptions.js --out temp/audit-exceptions/envelope.json and confirm none of them reappears. For a dependency pin or patch, reinstall and confirm the lockfile resolves the same versions without it, and run the project's audit command to confirm no advisory returns.`
- **Unjustified template:**
  `Give each <rule> exception a written reason or remove it: <file:line list>. Where the exception is still needed, put the reason inline (or in the package.json // note for a dependency pin) and cite the ticket it waits on, if any. Where nobody can state a reason, remove it and fix what it was suppressing.`
- **Fix Properly template:**
  `The <rule> exception at <file:line> still works but covers a defect with a real fix: <what it hides>. Fix the underlying cause, remove the exception, and add a test or gate that would have caught the regression it was hiding.`

## Step 5: Hand off to `/audit-to-stories`

```bash
node .agents/scripts/audit-to-stories.js --scan --glob temp/audits/audit-exceptions-results.md --out temp/audits/audit-to-stories-plan.json
```

Report the plan path and the group count; the converter owns everything
downstream, including whether a finding becomes a Story at all.

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this report carries its own title, an Exception Inventory, the
Undecided list and the Dropped Clusters budget log:

```markdown
# Exception & Override Audit Report

## Exception Inventory

| Category | Records | Dead | Expired | Orphaned | Unjustified | Live | Unknown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [inline / config / dependency / gate / test / allowlist] | [n] | [n] | [n] | [n] | [n] | [n] | [n] |

Skipped adapters: [ids, or "none"]. Degraded inputs: [inputs, or "none"].

## Undecided

| File:line | Adapter | Target | Probe basis |
| --- | --- | --- | --- |
| [file:line] | [adapter] | [target] | [probeBasis] |

## Dropped Clusters

| Adapter | Rule | Count |
| --- | --- | --- |
| [adapter] | [rule] | [count] |
```
