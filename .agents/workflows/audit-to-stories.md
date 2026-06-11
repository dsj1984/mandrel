---
description:
  Convert findings produced by the audit-* workflows into actionable
  GitHub Stories. Reads temp/audits/audit-*-results.md, groups findings
  cross-audit, deduplicates against existing Issues by fingerprint, and
  either chains into /plan --idea or opens standalone Stories.
---

# /audit-to-stories [audit-file-or-glob]

## Role

Engineering Lead

## Context

The `audit-*` workflows each produce a structured `audit-<dimension>-results.md`
report under `temp/audits/`. Every `### Finding` block in those reports
already carries the fields a Story body needs (Severity / Impact,
Dimension / Category, Current State, Recommendation, Agent Prompt).

`/audit-to-stories` closes the loop: it parses those reports, groups
related findings (including across audit dimensions), classifies each
group as eligible-to-create or already-tracked, and — at the operator's
choice — either chains into `/plan --idea` for a single planned
Epic or opens standalone Stories directly.

The audit producers themselves are **not modified** by this workflow.
They remain read-only emitters of audit reports.

## Prerequisites

1. At least one `audit-*-results.md` file under
   `temp/audits/` (or the path passed as the argument). Run a
   `/audit-<dimension>` or `/audit-fan-out` first if none are present.
2. `GITHUB_TOKEN` or `gh auth status` clean — the dedupe and create
   steps both call GitHub.
3. The `audit::<dimension>` label taxonomy bootstrapped via
   `node .agents/scripts/audit-labels-bootstrap.js` (idempotent — run
   once per repo).

## Argument

`/audit-to-stories [audit-file-or-glob]`

- No argument → scans `temp/audits/audit-*-results.md`. The roll-up
  report `audit-fan-out-results.md` is intentionally skipped.
- Single file path or glob → restricts the scan to that input.

## Phase 1 — Discover & parse

Run the CLI in `--scan` mode against the resolved glob. It parses every
`### Finding` block, normalises the fields (`Severity` / `Impact` are
both recognised; `Dimension` / `Category` likewise), and extracts file
paths mentioned in the body. It then stamps each finding with a stable
sha1 fingerprint via the shared
[`lib/findings/route-finding.js`](../scripts/lib/findings/route-finding.js)
helper (`fingerprintFinding`) — the single dedup/route implementation
shared with `qa-explore`. The workflow carries **no** separate inline
fingerprint or dedup code; identity, footer round-trip, and routing all
flow through that one module.

```bash
node .agents/scripts/audit-to-stories.js --scan \
  --glob "<resolved-glob>" \
  --out temp/audits/audit-to-stories-plan.json
```

The emitted plan envelope carries `findings`, `groups`, `edges`,
`classifications`, and `summary`. Subsequent phases consume the file
rather than re-parsing the reports.

## Phase 2 — HITL: severity gate

Read the plan envelope's `summary.tally`. Present the operator with the
severity threshold options, annotated with per-bucket counts:

> Found `<summary.totalFindings>` findings across
> `<distinct(group.dimensions)>`. Severity threshold to include?
>
> - `Critical only` (≈X findings)
> - `Critical + High` (≈Y findings) **[Recommended]**
> - `Critical + High + Medium` (≈Z findings)
> - `All severities` (≈N findings)

**STOP** until the operator picks. Re-run the scan with the chosen
threshold so the plan envelope already reflects the filter:

```bash
node .agents/scripts/audit-to-stories.js --scan \
  --glob "<resolved-glob>" \
  --severity <critical|high|medium|low> \
  --out temp/audits/audit-to-stories-plan.json
```

## Phase 3 — Grouping preview (consumes Phase 6 dedupe results)

Render a markdown table from the filtered `plan.classifications`
showing:

- one row per group (`group.title`, `group.dimensions.join(', ')`,
  `group.severity`, file count, finding count, and `action` —
  `create` / `skip-open #N` / `skip-reoccurring #N`).
- a tally line: `"M groups → K new, J already tracked, L re-occurring"`.
- an `Edges` table listing dependency edges (group → group via file).

**STOP** for operator approval. The operator can:

- Approve as-is → continue to Phase 4.
- Edit the grouping by hand → adjust the plan envelope and re-render
  the preview.
- Abort → no GitHub I/O has happened yet, so no cleanup is required.

## Phase 4 — HITL: grouping mode

Ask:

> How would you like these `<M>` Stories created?
>
> - **Single Epic via `/plan`** **[Recommended]** — opens one Epic,
>   then chains into `/plan --idea` so the standard PRD / Tech Spec
>   / WBS authoring handles decomposition. Grouped Stories become the
>   seed for Phase 7 decomposition.
> - **Individual standalone Stories** — opens one GitHub Issue per
>   group directly, no Epic wrapper.

**STOP** until the operator picks.

## Phase 5a — Single-Epic path

Build the `/plan` idea seed from the filtered plan envelope:

```bash
node .agents/scripts/audit-to-stories.js --emit-epic-seed \
  --plan temp/audits/audit-to-stories-plan.json \
  --out "temp/audits/audit-epic-seed-$(date +%Y%m%dT%H%M%S).md"
```

The seed renders the canonical one-pager sections — Problem Statement,
Recommended Direction, Key Assumptions (with links to every source
report), MVP Scope (the M proposed Stories), Key Files (so `/plan`
Phase 7 decompose has concrete anchors), Not Doing.

Chain into the existing planning entrypoint:

```text
/plan --idea "<path-to-seed>"
```

`/plan` then runs ideation → duplicate-search → render Epic body
→ open Epic → Phase 7 / 8 decompose, as documented in its workflow.
Each Story it spawns from the seed carries `context::audit:
<reportLink>` and `audit-fingerprint: <sha>` in its body so future
Phase 6 idempotency works on the next run.

## Phase 5b — Standalone-Stories path

Render the per-group `{ title, body, labels }` payloads:

```bash
node .agents/scripts/audit-to-stories.js --emit-stories \
  --plan temp/audits/audit-to-stories-plan.json \
  --json \
  --out temp/audits/audit-to-stories-stories.json
```

For each entry whose plan classification is `create`, open a GitHub
Issue. Use the GitHub MCP tool when available (`issue_write` with
method `create`), or fall back to `gh issue create`. The body carries
the canonical sections (Summary, Acceptance Criteria, Agent Prompts,
Context) plus the machine-readable fingerprint footer rendered by the
shared helper's `fingerprintFooter(sha)`
(`<!-- audit-fingerprints: sha1,sha1,... -->`) that Phase 6 relies on.

Labels applied:

- `type::story`
- `agent::ready`
- `audit::<dimension>` — one per dimension represented in the merge
  (cross-audit groups carry multiple).
- `risk::high` — added when any finding in the group is Critical.

## Phase 6 — Idempotency (folded into Phase 1 scan)

The `--scan` step routes each group's findings through the shared
[`lib/findings/route-finding.js`](../scripts/lib/findings/route-finding.js)
helper (`routeFinding`) — the same dedup/route entrypoint `qa-explore`
consumes — and maps its `decision` onto the group's action verdict in
the `classifications` array:

- **`create`** ← `routeFinding` returned `new`: no existing Issue's
  fingerprint footer references any of this group's finding shas.
  Eligible.
- **`skip-open`** ← `routeFinding` returned `update-existing` (or
  `duplicate`): an open Issue already tracks at least one of the
  group's findings. The decision surfaces the matched Issue number; the
  operator decides whether to comment "Re-detected on <date>" via
  `--update` semantics (manual for now).
- **`skip-reoccurring`** ← `routeFinding` returned
  `regression-of-closed`: every match is in a closed Issue. The group
  is skipped by default; flag in the Phase 7 summary so the operator
  can decide whether to reopen.

`routeFinding` is handed a `searchIssues` port adapted from the
project's existing GitHub provider — the actual search runs against the
repo's open + closed issues for each sha in the group, and the helper's
footer-confirmation step filters out false-positive search hits whose
body mentions the sha in prose without the canonical marker. The
workflow owns **no** parallel dedup or footer-parsing code: the
fingerprint, footer round-trip, and routing all live in that one shared
module.

When no provider is available (e.g. air-gapped dev environment), pass
`--no-provider` to the `--scan` step — every group is classified
`create` and the operator is informed that dedupe was skipped.

## Phase 7 — Summary & cleanup

Persist `temp/audits/audit-to-stories-$(date +%Y%m%dT%H%M%S).md`
summarising the run:

- Per-group breakdown: which findings merged, fingerprints, dependency
  edges, created/skipped Issue link (or new Epic link).
- The severity threshold and grouping mode the operator chose.
- Final tally: `"<M> groups planned · <K> created · <J> skipped (open)
  · <L> skipped (re-occurring)"`.

When the Single-Epic path ran, link the Epic the chained `/plan`
opened. When the Standalone-Stories path ran, list every Issue URL.

## Constraints

- **Never** modify any `audit-*` producer workflow. Audit producers
  stay read-only.
- **Never** open a duplicate Issue. The shared
  [`route-finding.js`](../scripts/lib/findings/route-finding.js) helper's
  fingerprint marker and footer-confirmation step gate every create.
- **Never** reimplement fingerprinting or dedup inline. Route every
  finding through the shared `route-finding.js` helper — it is the single
  dedup/route implementation, shared with `qa-explore`.
- **Always** stamp the fingerprint footer (via the helper's
  `fingerprintFooter`) in the body of every created Story. Without it,
  the next run cannot dedupe.
- **Always** present the Phase 2, 3, and 4 HITL gates. Do not bypass —
  even when "obvious" — because the severity / grouping / mode picks
  are operator decisions that the workflow's UX contract relies on.
- **MCP fallback**: prefer `mcp__github__issue_write` for Issue
  creation; fall back to `gh issue create` when the MCP tool is
  unavailable.

## See also

- [`/plan`](helpers/plan-epic.md) — the planning pipeline `/audit-to-stories`
  chains into for the Single-Epic grouping mode.
- [`lib/findings/route-finding.js`](../scripts/lib/findings/route-finding.js) —
  the shared fingerprint/dedup/route helper this workflow and `qa-explore`
  both consume. There is no second dedup implementation.
