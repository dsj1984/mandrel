---
description: >-
  Audit the decisions log as a live contract — Accepted ADRs whose claims the
  tree has outgrown, broken supersede chains, structural gaps, and directional
  changes that landed with no decision recorded. A deliberately-global lens over
  whichever decisions-log layout the consumer ships.
---

# Decisions-Log (ADR) Audit

You are a Staff Engineer & Decision Historian verifying that the consumer's
**decisions log still describes the system that exists**. An ADR is not prose
that merely rots — it is retrieved as *authority*: agents and humans read an
`Accepted` decision as the settled answer and do not re-litigate it. So an
Accepted ADR the tree has outgrown is worse than no ADR at all — it actively
teaches a wrong contract, and it keeps teaching it until someone supersedes it.
That is this lens's central target; structural tidiness is the cheap part.

The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-adrs-results.md`. Dimension values:
`Decision Drift | Supersede-Chain Integrity | Structure & Status Hygiene |
Missing Decision | Layout Conformance`; the report adds a **Decision Coverage**
table.

## Applicability & layout detection

**Mandrel ships two first-class decisions-log layouts** (the
[`core/documentation-and-adrs`](../skills/core/documentation-and-adrs/SKILL.md)
Policy Capsule is the SSOT), and this lens reads whichever one the consumer
adopted. **Both layouts keep the same entry file** — `decisions.md` under the
configured docs root — so its mere presence never identifies the layout. Detect
in this order, resolving `<docsRoot>` from `project.paths.docsRoot` in
`.agentrc.json` (default `docs`):

1. **Neither `<docsRoot>/decisions.md` nor `<docsRoot>/decisions/` exists** →
   the project keeps no decisions log. Emit the not-applicable report below and
   stop. Never invent a log, and never infer decisions from commit history.
2. **`decisions.md` only** → **single-file dated-entry layout** (the default).
   Every ADR body lives in that one file as an append-only entry.
3. **`decisions.md` + a `decisions/` directory** → read the entry file to tell
   the two apart. When it is predominantly an **index** (one row or link per
   ADR pointing into `decisions/`), this is the **index + `decisions/`
   directory** (MADR-style) layout, and each `decisions/NNNN-*.md` file is an
   ADR body. When it instead carries full ADR bodies *and* a `decisions/`
   directory holds further ADRs, the log is a hybrid — conformant **only** when
   every file under `decisions/` is reachable from the entry file by an
   index row or an in-entry pointer; otherwise it is a Layout Conformance
   finding (an unreferenced ADR body is invisible to every reader who starts,
   as they must, at the entry file).
4. **`decisions/` only, with no entry file** → a Layout Conformance finding:
   the entry file is the mandatory-read surface both layouts guarantee, and
   without it the directory's ADRs are unreachable from the docs context.

**Override.** An operator may pass `--paths <file ...>` (audit specific ADR
files) or `--dir <path>` (treat that directory as the decisions root) to point
the lens at a non-conventional location. These flags are the **only** override:
there is deliberately no `.agentrc.json` key for the decisions-log location, so
detection stays derived from the skill's two layouts rather than from
configuration a consumer must maintain.

## Whole-log scope (global lens)

Unlike the change-set-scoped lenses, this lens **always evaluates the whole
decisions log**, even when the change that triggered it touched one file.
Decision integrity is a global property: a supersede chain spans entries the
change set never names, and — the load-bearing case — a code change *elsewhere*
is exactly what invalidates an Accepted ADR's claims. Narrowing to the change
set would blind the lens to its primary finding class.

Accordingly this lens declares `"scope": "global"` in
[`audit-rules.json`](../schemas/audit-rules.json) — the single source of truth
`resolveLensTier` in
[`lib/audit-suite/selector.js`](../scripts/lib/audit-suite/selector.js) reads —
and is **exempt from the cross-epic-leak guard** that narrows every other
lens's evidence to its `changedFiles`. The exemption is scoped to this lens
only; the guard is not weakened for any other lens.

```text
{{changedFiles}}
```

- For this lens, **ignore** the `{{changedFiles}}` block above even when it is
  populated: the decisions log is evaluated whole regardless. The block is
  rendered only for envelope-shape parity with the scoped lenses. Do use it,
  when populated, as a **prioritization hint** — an Accepted ADR whose subject
  the change set touches is the first one to claim-check — never as a filter on
  what is audited or reported.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy. On a large log, the Decision Drift claim-check
(Step 2.1) is the one dimension worth fanning out per batch of entries under
parallel-tooling Rule 3 — merge under the shared self-cross-check.

## Step 1: Deterministic structure sweep first

Run the cheap exact checks before reading any ADR for meaning — they
de-duplicate the easy findings and give Step 2 its inventory. Adjust the paths
below to the detected layout (or the `--dir` / `--paths` override):

```bash
# Entry file + any ADR bodies (single-file layout yields just the entry file).
ls docs/decisions.md docs/decisions/*.md 2>/dev/null

# Status lines and their spelling — the vocabulary is Accepted / Superseded
# by … / Deprecated / Reverted (…); anything else is a Structure & Status
# Hygiene finding.
grep -rn '^\*\*Status:\*\*\|^- \*\*Status:\*\*' docs/decisions.md docs/decisions/ 2>/dev/null

# Entry headings, for the id/date/uniqueness checks in Step 1's list below.
grep -n '^## ' docs/decisions.md 2>/dev/null

# Link integrity across the docs surface, including every ADR cross-reference.
node .agents/scripts/check-doc-links.js
```

From that output, resolve deterministically — each of these is a
**Structure & Status Hygiene** finding except where noted:

1. **Canonical sections.** Every ADR carries the canonical set the skill's
   Policy Capsule names — **Status, Date, Deciders, Context, Decision,
   (Alternatives Considered), Consequences**. `Alternatives Considered` is
   optional; a missing `Status`, `Context`, `Decision`, or `Consequences` is a
   finding, and a missing `Status` is the most severe of them because every
   other dimension keys off it.
2. **Status vocabulary.** Each status reads `Accepted`, `Superseded by <ref>`,
   `Deprecated`, or `Reverted (<date>)` — a reverted decision was **undone**
   rather than replaced, so unlike a superseded one it has no successor to
   point at, and its missing `by <ref>` is correct rather than a defect. A
   free-invented status word — anything outside those four — leaves the entry
   unclassifiable by this lens and by every reader.
3. **Unique, stable ids.** No two entries share an id/anchor; MADR files use
   zero-padded sequential numbering matching their heading id.
4. **Parseable dates.** Every `Date` parses, and no entry is dated in the
   future.
5. **Link integrity.** Report what `check-doc-links.js` finds inside the
   decisions surface; leave findings outside it to `audit-documentation`.

This lens orchestrates the existing checker only — it adds no new deterministic
checker script, and the sweep above is inline shell by design.

## Step 2: Evaluation dimensions

### 2.1 Decision Drift — **`Accepted` entries only**

This is the lens's primary value. For each **Accepted** entry, extract its
load-bearing claims — the scripts, files, directories, commands, flags, config
keys, contracts, and mechanisms it names as decided — and verify each against
the current tree, exactly as a documentation claim-check would. Flag an
Accepted decision whose subject the code has moved past: a named mechanism that
no longer exists, a contract the implementation has replaced, a path or command
that resolves to nothing, a constraint the tree now routinely violates.

**Scope this claim-check to Accepted entries and no others.** A `Superseded`
or `Deprecated` entry is *supposed* to describe a world that no longer exists —
claim-checking it manufactures findings out of correctly-retired history, and
on a long log it is also where the cost would go. Superseded and Deprecated
entries get the chain checks in 2.2 and the structure checks in Step 1, and
nothing else.

**Remediation is always supersede-or-amend, never silent edit or deletion** —
the skill's lifecycle rule is that an ADR is superseded in place, never pruned
or archived. Say which in the finding: amend when the decision still holds and
only its details moved; supersede when the decision itself no longer describes
what the project does.

Severity guidance: **High** — an Accepted ADR whose central decision the code
contradicts (it will be retrieved and believed); **Medium** — an Accepted ADR
whose supporting details drifted while its decision still holds; **Low** —
cosmetic staleness (an old path in an aside, a renamed tool in an example).

### 2.2 Supersede-Chain Integrity

The chain is what keeps a retired decision honest, so audit it as a graph:

- **Every supersede reference resolves** to an ADR that exists (a heading
  anchor in the single-file layout, a file in the directory layout).
- **No cycles**, and no entry superseding itself.
- **Index ↔ entry agreement** (directory layout, and any single-file log
  carrying a summary table): the status in the index row matches the status in
  the ADR body. A row saying `Accepted` over a body saying `Superseded` is a
  finding — readers stop at the index.
- **Partial supersessions name what survives.** An entry recording that *some*
  rows or clauses are superseded while the rest stand MUST say precisely which;
  an unscoped "partly superseded" leaves every clause ambiguous.
- **No two Accepted entries contradict each other** on the same subject. When
  a later decision silently overrode an earlier one, the earlier is the finding:
  it was never marked superseded.

### 2.3 Structure & Status Hygiene

Promote the Step 1 sweep's resolved items to findings here. Keep them terse —
each names the entry and the missing or malformed element.

### 2.4 Missing Decision

The inverse gap: a directional change that landed with **no** decision
recorded. **Bound the search by date** — inspect history since the newest
entry's `Date`, not the whole history, or this dimension dominates the lens's
cost on any mature repository:

```bash
git log --since=<newest-ADR-date> --pretty='%h %s' -- . | head -50
```

Flag only **directional** changes — a mechanism retired, a contract cut over, a
dependency or platform swapped, an architectural seam moved. Routine features,
fixes, and refactors are not decisions and must not be reported here. When the
newest entry is recent and nothing directional landed since, record that as a
single `Info` observation rather than straining for a finding.

### 2.5 Layout Conformance

Report the detection outcomes named in **Applicability & layout detection**: an
unreferenced ADR body under `decisions/`, a `decisions/` directory with no
entry file, or an index whose rows and directory contents disagree about which
ADRs exist.

## Not-applicable report

When the project keeps **no decisions log** (neither the entry file nor the
directory exists, and no `--paths` / `--dir` override was supplied), emit this
explicit report instead of empty findings — and stop:

```text
# Decisions-Log (ADR) Audit Report

## Executive Summary

**Not applicable** — this project keeps no decisions log (no `decisions.md`
entry file and no `decisions/` directory under the configured docs root), so
the ADR lens has nothing to inspect and was skipped.

## Detailed Findings

_None — lens not applicable._
```

## Constraint (lens-specific carve-out)

Read-only over the decisions log and the tree it makes claims about. The single
write is the report artifact: never edit, supersede, renumber, reformat, or
delete an ADR — recording that a decision needs superseding is the deliverable,
and performing the supersession is a separate, human-owned pass. Run
`check-doc-links.js` in its default read-only mode only. Generic documentation
staleness outside the decisions surface belongs to
[`audit-documentation`](audit-documentation.md); architectural boundary
violations belong to `audit-architecture`. This lens judges whether a *recorded
decision* still matches the tree — never whether the decision was a good one.

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this lens's report carries its own title and a Decision Coverage table,
so a reader can see what was claim-checked versus what was only chain-checked:

```markdown
# Decisions-Log (ADR) Audit Report

## Decision Coverage

| ADR         | Status                                          | Checked                       |
| ----------- | ----------------------------------------------- | ----------------------------- |
| [id, title] | [Accepted · Superseded · Deprecated · Reverted] | [Claims + chain · Chain only] |
```
