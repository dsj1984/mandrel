---
description: >-
  Audit a project's published customer-facing policies (Terms, Privacy, Cookie,
  refund and cancellation, consent and waiver text) against what the code
  actually does, in both directions — promises the system does not keep and
  practices no policy discloses. Never edits policy text; every finding names a
  decision.
---

# Policy Consistency Audit

You are a Policy Consistency Reviewer checking that a project's **published
customer-facing policies** describe the system that actually ships. Drift runs
both ways: the text promises or states something the system does not do, or
the system does something the text omits or contradicts. This lens is the
AI-driven backstop behind a project's deterministic policy guards.

The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditResultsDir}}/audit-policies-results.md`. Dimension values:
`Contradiction | Unbacked Promise | Undisclosed Practice | Stale Reference |
Internal Inconsistency | Unverifiable`. Extra finding fields: **Policy:**,
**Implementation:**, **Backing:** and **Direction:** (see Report additions).
The report adds a mandatory **Claims Coverage** section.

## The invariant: this lens never edits policy text

Policy text is published and legally binding, so its fix is a **decision**, not
an edit. The core's read-only constraint applies as usual, and on top of it:

- Every finding's **Recommendation & Rationale** names the decision to be made
  — "change the code to honor the text, or change the text to describe the
  code" — and never drafts replacement wording.
- When [`/audit-to-stories`](audit-to-stories.md) turns a finding from this
  report into a Story, that Story's **first acceptance criterion is a recorded
  operator decision** on the finding's Direction. Say so in the finding's
  Acceptance signal.
- The report carries this fixed line in its Executive Summary: "This audit
  checks consistency between published text and implementation, not legal
  adequacy, and is not legal advice."

## Target set (config-driven union)

The target set is the **policy corpus**, built as the union of:

1. **`project.policies.corpusGlobs`** from `.agentrc.json`, when configured.
2. **Conventional policy files**, when `corpusGlobs` is unset: text files
   (`.md`, `.mdx`, `.html`, `.htm`, `.astro`, `.txt`) under a `policies/` or
   `legal/` directory, or whose basename carries an explicit policy compound
   (`privacy-policy`, `cookie-policy`, `cookie-notice`, `refund-policy`,
   `cancellation-policy`, `terms-of-service`, `terms-of-use`,
   `terms-and-conditions`). A bare `privacy.md` is not a policy.
3. **An explicit `--paths` override** — files the operator names on
   invocation are added to the union.

A project with no corpus never reaches this lens: the `policies` target's
`hasPolicyCorpus()` probe in
[`lib/audit-suite/selector.js`](../scripts/lib/audit-suite/selector.js) drops
it from the roster, failing open when the probe is indeterminate.

Three more optional `project.policies` keys shape the run:

- `impactMap` — a repo-relative path to a JSON object mapping code globs to
  arrays of policy paths. It focuses a fenced run (below).
- `backingDocs` — runbook or SOP globs. A claim honored by a documented manual
  procedure is **backed**, not a finding.
- `acceptedFindings` — a repo-relative path to a JSON array of
  `{ policy, quote, reason, reviewBy }` entries, `reviewBy` as `YYYY-MM-DD`
  (see Step 3).

## Scope (deviant — intersect with the target set)

This lens deviates from the shared change-set fence: it intersects the fence
with the policy corpus above.

```text
{{changedFiles}}
```

- If the block contains a newline-delimited list of file paths, audit only:
  every policy whose `impactMap` globs match a changed file; every changed
  policy file; and every policy sentence that names a symbol, route,
  provider, setting or value the change set touches.
- If the block renders as the literal string `{{changedFiles}}` (no
  substitution supplied), sweep the whole corpus.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy. Fan out per policy only when the operator's invocation
asks for it: a full sweep of a large corpus is expensive (the review that
motivated this lens spent about 500k tokens on 41 documents).

## Step 1: Deterministic signals first

Before reading any claim closely, collect the signals a grep can settle:

1. **Unresolved cross-references** — a policy that refers to another policy,
   section or document that does not resolve inside the corpus.
2. **Absent referenced documents** — a document a policy points readers to
   (a protocol, a form, a schedule) that is not in the corpus or the site.
3. **Contact drift** — email addresses, phone numbers or postal addresses
   that differ across the corpus.
4. **Money literals** — literal numbers beside refund, cancellation, fee or
   deposit wording. List them once per policy; Step 2 verifies each value.

## Step 2: Claims, both directions

**Text → code.** Extract each checkable claim per policy — data collected,
recipients and providers, cookies and tracking, access, retention and
erasure, money rules and values, deadlines, consent mechanics, and the
procedures a reader is told to follow. Verify each against the code with
`path:line` evidence, or against a `backingDocs` procedure. Record the
searches you ran when you find nothing.

**Code → text.** Inventory what the code does in those same categories —
providers reached, cookies and storage keys set, personal-data categories
stored, money rules enforced — and flag what no policy discloses.

## Step 3: Evaluation dimensions

Every finding takes exactly one of these as its `Dimension`:

- **Contradiction** — the text says X; the code does Y.
- **Unbacked Promise** — a published commitment that no code and no
  documented `backingDocs` procedure honors.
- **Undisclosed Practice** — the system does something (a provider reached, a
  cookie set, a data category stored) that no policy discloses.
- **Stale Reference** — a renamed feature, a departed person or address, a
  document readers cannot reach, or an expired accepted finding.
- **Internal Inconsistency** — two policies, or two sections of one policy,
  disagree (a "one-time" fee here, an "annual" fee there).
- **Unverifiable** — a claim about a system outside the repository (a
  partner-built app, a vendor's own retention). Info only.

### Accepted findings

When a finding's Policy file and quoted sentence match an `acceptedFindings`
entry whose `reviewBy` date has not passed, do not report it; count it as
**accepted** in Claims Coverage. An entry whose `reviewBy` has passed is
reported as a Low `Stale Reference` naming the entry, and is this lens's
own — it is not `/audit-exceptions`' to grade.

## Step 4: Severity anchors

- `High` — a published commitment about money, children's or health data,
  deletion and retention, consent, or third-party sharing that the system
  contradicts or does not honor.
- `Medium` — any other Contradiction, Unbacked Promise or Undisclosed
  Practice.
- `Low` — Stale References and Internal Inconsistencies.
- `Info` — Unverifiable claims.

This lens does not grade Critical: a policy finding is a decision for the
operator, never a defect that should halt a delivery gate on its own.

## Step 5: Boundaries with sibling lenses

- A code-side personal-data flow that involves **no policy sentence** stays
  [`/audit-privacy`](audit-privacy.md)'s.
- [`/audit-documentation`](audit-documentation.md) excludes the policy corpus
  from its own target set; published policy text is audited here only.
- Expired accepted findings are this lens's own, not
  [`/audit-exceptions`](audit-exceptions.md)'.
- [`/audit-security`](audit-security.md) is unchanged.

## Periodic full-scope sweep

Policies drift one merged change at a time, so a fenced run sees only the
day's slice. Pair it with a recurring full-scope run:

- **Scheduled invocation** — `/schedule` running `/audit-policies`
  full-scope (no `--paths`, no change-set filter, so the `{{changedFiles}}`
  block renders the literal token) on a weekly cron, and before any policy
  rewrite ships. The nightly sweep-then-route recipe lives in
  [`audit-to-stories.md` § Scheduling a nightly sweep](audit-to-stories.md#scheduling-a-nightly-sweep).

Route the resulting `audit-policies-results.md` through
[`/audit-to-stories`](audit-to-stories.md); each Story it files opens on the
recorded operator decision.

## Report additions

Beyond the core's shared skeleton, this lens adds its title, the fixed
not-legal-advice line and a `Direction split` line in the Executive Summary,
the mandatory Claims Coverage section before the findings, and four finding
fields. Write `_No findings._` under a section rather than omitting it:

```markdown
# Policy Consistency Audit Report

## Executive Summary

[Headline read.]

This audit checks consistency between published text and implementation, not legal adequacy, and is not legal advice.

Self-cross-check: kept <k> / dropped <d>.
Severity tally: Critical 0 / High <n> / Medium <n> / Low <n>
Direction split: text <n> / code <n> / undecided <n>

## Claims Coverage

| Policy | Claims extracted | Verified | Backed | Accepted | Findings |
| --- | --- | --- | --- | --- | --- |
| `path/to/policy.md` | <n> | <n> | <n> | <n> | <n> |

## Detailed Findings

### `path/to/policy.md` — [Short title of the issue]

- **Dimension:** [Contradiction | Unbacked Promise | Undisclosed Practice | Stale Reference | Internal Inconsistency | Unverifiable]
- **Severity:** [High | Medium | Low | Info]
- **Policy:** `path/to/policy.md` — "[the exact quoted sentence]"
- **Implementation:** [`path:line` evidence | none found — searches run: …]
- **Backing:** [a `backingDocs` procedure | none]
- **Direction:** [text | code | undecided — default undecided]
- [Location, Current State, Recommendation & Rationale, Acceptance signal —
  per the core skeleton; the recommendation names the decision, never new
  wording]
```
