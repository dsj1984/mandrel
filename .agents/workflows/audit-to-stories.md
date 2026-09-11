---
description:
  Convert findings produced by the audit-* workflows into actionable
  GitHub Stories. Reads temp/audits/audit-*-results.md, groups findings
  cross-audit, deduplicates against existing Issues by fingerprint, and
  either chains into /mandrel-plan --seed-file or opens standalone Stories.
---

# /audit-to-stories [audit-file-or-glob]

## Role

Engineering Lead

## Context

The `audit-*` workflows each produce a structured `audit-<dimension>-results.md`
report under `temp/audits/`. Every `### Finding` block in those reports
already carries the fields a Story body needs (Severity / Impact,
Dimension / Category, Current State, Recommendation, Agent Prompt).

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
finding block, normalises the fields (`Severity` / `Impact` are
both recognised; `Dimension` / `Category` likewise), and extracts file
paths mentioned in the body. A `###` heading that carries no severity axis and
holds `####` blocks is read as a **grouping header**: its `####` children are
the findings, and the header itself never becomes one. It then stamps each
finding with a stable sha1 fingerprint via the shared
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

**The tally cross-check is automatic.** Every report declares
`Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>` in its
Executive Summary; the scan compares that line with what it parsed and carries
each disagreement on `summary.reportFailures[]` as
`{ sourceReport, kind, reported, parsed }`. The kinds are `missing-tally` (no
line), `tally-mismatch` (line and parse disagree), and `unresolved-severity` (a
finding whose severity did not resolve — dropped from grouping, never filed as
an `unknown` group). They print to stderr before `--scan` returns its plan, so
a mis-parsed report is never read as a clean audit: re-run the lens rather than
file from it. Over older reports predating the mandate,
`--scan --allow-missing-tally` downgrades **only** `missing-tally` to a
warning.

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
> - **Single plan via `/mandrel-plan`** **[Recommended]** — chains into
>   `/mandrel-plan --seed-file <emitted.md>` so the standard Story authoring
>   handles the seed. Prefer one Story; split only under the
>   default-single policy.
> - **Individual standalone Stories** — opens one GitHub Issue per
>   group directly (no plan ceremony).
>
> Either way, if the sweep proposes **more than 2** Stories they are grouped
> under a **container Epic** by default — a title, a one-paragraph goal and a
> child checklist, carrying nothing a child does not already carry. Say so if
> you would rather file them flat.

**STOP** until the operator picks.

## Phase 5a — Single-plan path

Build the `/mandrel-plan` seed from the filtered plan envelope:

```bash
node .agents/scripts/audit-to-stories.js --emit-plan-seed \
  --plan temp/audits/audit-to-stories-plan.json \
  --out "temp/audits/audit-plan-seed-$(date +%Y%m%dT%H%M%S).md"
```

The seed renders the canonical one-pager sections — Problem Statement,
Recommended Direction, Key Assumptions (with links to every source
report), MVP Scope (the M proposed Stories), Key Files (so `/mandrel-plan`'s
authoring step has concrete anchors), Grouping, Not Doing.

**Grouping is the container-Epic directive.** Above 2 proposed Stories the
seed instructs `/mandrel-plan` to group them under one Epic — a sweep is the
clearest case for a container, since every Story shares a provenance and an
operator usually delivers them together. It is a directive in the text, not an
automatic write: Phase 4 above is where an operator declines it. Below the
threshold the section says so and asks for nothing.

Chain into the existing planning entrypoint:

```text
/mandrel-plan --seed-file <path-to-seed>
```

(`/mandrel-plan --seed "$(cat <path>)"` also works for small seeds). `/mandrel-plan`
then runs its author → persist path, as documented in its workflow.

**Dedup provenance is carried mechanically — do not hand-copy it.** The seed's
MVP Scope bullets carry each group's `audit-fingerprints` and
`audit-semantic-keys` footers as HTML comments (invisible in the rendered
one-pager). `plan-persist` harvests them out of the seed on the
`plan-context.json` envelope and appends them to **every** Story body it
persists, via `carryProvenanceFooters`
([`lib/findings/route-finding.js`](../scripts/lib/findings/route-finding.js)).
The carry is additive, union-preserving and idempotent, so a resumed persist
cannot stack footers and a hand-authored fingerprint is never dropped.

This is deliberately not an authoring step. It used to be: the footers reached
the seed and stopped there, leaving the authoring agent to notice HTML comments
in a one-pager and copy them forward — a remembered step, which is to say no
step at all. Stories filed on the recommended path were therefore invisible to
the next sweep's Phase 6 dedup, which re-filed work it had already planned. If
you find yourself copying a footer by hand, the carry is broken — fix it there
rather than papering over it in the body.

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
- `audit::<dimension>` — one per dimension represented in the merge
  (cross-audit groups carry multiple).
- `risk::high` — added when any finding in the group is Critical.

**No `agent::` state label, deliberately.** The filer used to emit
`agent::ready`, which is exactly what `/mandrel-deliver` reads as "available
for pickup" — and these bodies are audit prose, not a delivery-ready Spec. A
Story with no `agent::` label is a legal initial state; `/mandrel-plan` stamps
`agent::ready` as its terminal flip once the finding has become a scoped
capability slice. Do not re-add it here or apply it by hand at create time.

### Phase 5c — Wire the cohort's declared ordering (**required**)

Creating the Issues is only the first pass. `groupFindings` detects `edges[]`
between groups, but at emit time no group has an issue number, so each body
ships with an empty `depends_on` and the cohort has **no declared ordering
at all**. Replay the numbers you just opened:

```bash
node .agents/scripts/audit-to-stories.js --wire-edges \
  --plan temp/audits/audit-to-stories-plan.json \
  --ids '{"<groupKey>": <issueNumber>, ...}' \
  --out temp/audits/audit-to-stories-wired.json
```

Each entry in the emitted `--json` payload carries its own `groupKey` and
`dependsOn`, so the map is a lookup, not a reconstruction. The pass re-renders
every Story that has a resolvable blocker with a canonical
`---` / `blocked by #N` footer **and** mirrors the same edges as native
GitHub `blocked_by` relations. An edge whose target was never opened (deduped,
ledger-suppressed) drops rather than becoming a `blocked by #undefined`.

**This pass also records the ledger.** The `--ids` map is the only artifact
carrying the numbers just opened, so `--wire-edges` folds in the cross-run
record: each mapped group's findings are written `filed` against its Issue
(`--ledger <path>`, default `baselines/audit-ledger.json`; `--dry-run`
suppresses the write). The record runs **before** the provider loads, so a host
with no `gh` still remembers what it filed. Without it nothing ever writes
`filed` and the ledger suppresses nothing (Story #5305).

**Do not skip this.** `/mandrel-deliver` has no other source for this cohort's order:
its footprint guard ignores the shared provenance footers, so an unwired cohort
is genuinely unordered and `/mandrel-deliver` will co-dispatch Stories the edges say
must follow one another.

**Preconditions.** The pass writes through the configured provider, so it needs
`github.owner` **and** `github.repo` in `.agentrc.json` plus working `gh` auth
(`GH_TOKEN`/`gh auth status`) — the same two things Phase 1's dedup needs. When
either is missing the command refuses and names which one; fix that and re-run
the exact command above. Do not transcribe the footers by hand: `/mandrel-deliver`
reads them, but the native `blocked_by` relations only exist if this pass wrote
them.

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

`routeFinding` reads open + closed issues through two ports, which **both run
and union their pools** — the exact `searchIssues` lookup, and the meaning-first
`searchCandidates` pass wired to
[`lib/findings/semantic-issue-search.js`](../scripts/lib/findings/semantic-issue-search.js).
Confirmation then filters that union by footer, dropping hits whose body
mentions a sha in prose without the canonical marker. A finding reworded but
unmoved still confirms, because the filers stamp a location-based
`audit-semantic-keys` footer
beside `audit-fingerprints`; so do
[`retro-proposals-graduator`](../scripts/lib/feedback-loop/retro-proposals-graduator.js)
filings, which a sweep therefore never re-files.

Where the corpus is pre-fetched — either off the list endpoint or from
`--issues-file` — the exact lookup is answered from that local index and the
search API is spent only on findings with no exact hit. The workflow owns **no**
parallel dedup or footer-parsing code: fingerprint, footer round-trip, and
routing all live in that one shared module.

### When there is no `gh` CLI

**No GitHub access** (air-gapped): pass `--no-provider` to `--scan`. Every
group is classified `create` and the operator is told dedupe was skipped — a
re-run opens duplicates.

**Reachable, but not through `gh`** (a cloud sandbox: no `gh`, no direct API,
MCP fine): fetch the corpus yourself. List every issue labelled `audit::*` at
state `all` — `mcp__github__list_issues` or any other path — write the raw
result as a JSON array, and pass it:

```bash
node .agents/scripts/audit-to-stories.js --scan --no-provider \
  --issues-file temp/audits/issues.json --glob "temp/audits/audit-*-results.md"
```

Real `skip-open` / `skip-reoccurring` classifications come back. The corpus is
normalised on load, so a raw list result works as-is; only `number` and `body`
are read. An unreadable file is a hard error, never a silent fall-back to an
unchecked run; an **empty** array — a valid first sweep — is reported with its
count so it cannot pass for a failed fetch.

### Cross-run ledger

The `--scan` classifications only see *live* issues. To decay findings across
runs — recognizing re-detections, suppressing deliberately-rejected findings,
and flagging genuine regressions — the sweep folds each scan onto a committed
**ledger** (`baselines/audit-ledger.json`, the arch-cycles-baseline envelope
shape). Each entry is keyed by the finding's fingerprint plus a location-based
`semanticKey` and carries a lifecycle `status`
(`new | filed | fixed | accepted-risk | regressed`). A finding whose tracking
Issue was closed as `not_planned` becomes `accepted-risk` and is **suppressed**
on every later scan; a `fixed` finding that re-appears becomes `regressed`. The
ledger is written by the unattended `--auto` sweep, by any `--scan --ledger`
run, and by the Phase 5c `--wire-edges` pass that records what was filed; the
plain `--scan` path leaves it untouched. A finding whose resolved Issue is open
is `filed`/known — a closed Issue still outranks that.

## Phase 7 — Summary & cleanup

Persist `temp/audits/audit-to-stories-$(date +%Y%m%dT%H%M%S).md`
summarising the run:

- Per-group breakdown: which findings merged, fingerprints, dependency
  edges, created/skipped Issue link (or plan-run / Story links).
- The severity threshold and grouping mode the operator chose.
- Final tally: `"<M> groups planned · <K> created · <J> skipped (open)
  · <L> skipped (re-occurring)"`.

When the single-plan path ran, link the Story (or plan-run) the chained
`/mandrel-plan` opened. When the Standalone-Stories path ran, list every Issue URL.
Either way, name the container Epic if one was created — it is the single id
that delivers the whole sweep (`/mandrel-deliver <epicId>`).

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
  the next run cannot dedupe. On the Single-plan path this is mechanical
  (`carryProvenanceFooters`, Phase 5a) — never an authoring step.
- **Never** re-mint a finding fingerprint while normalising a finding.
  `severity` and `labels` are identity fields folded into the sha, so
  normalising either without holding the hash stable silently breaks
  dedup for every finding already filed. The projection that keeps the
  fingerprint invariant under normalisation is
  `severity.js#fingerprintSeverity`; the contract is pinned by
  `tests/lib/findings/route-finding.contract.test.js`.
- **Always** grade findings on the canonical five-level scale
  (`lib/findings/severity.js`). A level outside it parses as no severity
  and the finding is dropped by every severity-filtered run.
- **Always** present the Phase 2, 3, and 4 HITL gates. Do not bypass —
  even when "obvious" — because the severity / grouping / mode picks
  are operator decisions that the workflow's UX contract relies on.
- **MCP fallback**: prefer `mcp__github__issue_write` for Issue
  creation; fall back to `gh issue create` when the MCP tool is
  unavailable.

## Scheduling a nightly sweep

To run an unattended maintenance sweep, `/schedule` a nightly (or weekly)
job that (1) runs the relevant `audit-*` lens workflows full-scope — no
`--paths`, no change-set filter, so the whole target-set union is audited —
writing their `temp/audits/audit-*-results.md` reports, then (2) invokes the
CLI's **`--auto` mode** over those results:

```bash
node .agents/scripts/audit-to-stories.js --auto [--dry-run] [--ledger-commit] \
  [--glob "temp/audits/audit-*-results.md"] [--severity <floor>]
```

The routine shape is **lenses full-scope → dry-run → live with a ledger PR**:

1. Run the `audit-*` lenses with no `--paths` and no change-set filter. A
   sweep scoped to a change set re-reports the same recent files every cycle
   and never reaches the untouched code where findings accumulate.
2. `--auto --dry-run` for the first cycles — zero writes, summary only. Read
   `totals.create` and raise the severity floor until it is a batch the team
   would actually take on.
3. `--auto --ledger-commit` once the tallies stop surprising you.

`--auto` runs with **no interactive gates**: it resolves the severity floor
from `delivery.auditToStories.severityFloor` (default `high`, overridable with
`--severity`), applies the two-stage dedup, reconciles the cross-run ledger,
and prints a run-summary JSON (create / skip-open / skip-reoccurring /
suppressed-by-ledger tallies, the `create`-classified group keys the `--ids`
map is built from, plus the re-detected open Issue numbers an operator may want
a "re-detected" comment on). It opens no Issues itself, so run Phase 5c after
filing or the sweep's memory stays empty. `--dry-run` performs zero GitHub
writes and skips the ledger write, emitting only the summary.

`--auto` **fails closed on any `summary.reportFailures[]` entry** (Phase 1): an
unattended sweep has no operator to read a warning, so a missing or mismatched
`Severity tally:` line — or a finding whose severity did not resolve — exits
non-zero having opened no Issue and written no ledger. `--allow-missing-tally`
is a `--scan` affordance that `--auto` ignores. A red sweep means the report is
untrustworthy: re-run the lens. The host scheduler owns the cadence; this
workflow owns the routing.

### The ledger is consumer state — commit it

`baselines/audit-ledger.json` is **committed consumer state, not scratch
output**. A scheduled sweep normally runs on an ephemeral checkout, so unless
the reconciled ledger is committed back it dies with the clone: every later
sweep starts amnesiac, re-proposing findings already filed and re-surfacing
findings a human already rejected.

`--ledger-commit` closes that loop. After the summary prints — and only when
the ledger changed — it creates `chore/audit-ledger-<YYYY-MM-DD>` from HEAD,
commits **only** the ledger file, pushes it, and opens a PR against
`project.baseBranch`. **Auto-merge is never requested**: a human glance at the
`accepted-risk` / `regressed` flips before it lands is the point. A git or `gh`
failure is fatal and names its step, but only after the summary is printed, so
a broken remote never costs the operator the run's findings. `--dry-run` skips
the tail. Without the flag, a changed ledger on a checkout that cannot persist
it — no `origin`, or HEAD off the base branch — sets `ledger.unpersisted: true`
in the summary and warns on stderr naming the file.

The full sweep procedure — tally cross-check, the ledger PR, the
enrich-before-deliver step and the label convention — ships as a
consumer-copyable template at
[`templates/docs/audit-sweep-runbook.md`](../templates/docs/audit-sweep-runbook.md).

## See also

- [`/mandrel-plan`](mandrel-plan.md) — the planning pipeline `/audit-to-stories`
  chains into for Story creation.
- [`lib/findings/route-finding.js`](../scripts/lib/findings/route-finding.js) —
  the shared fingerprint/dedup/route helper this workflow and `qa-explore`
  both consume. There is no second dedup implementation.
