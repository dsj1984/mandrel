---
name: security-and-hardening
description:
  Hardens code against vulnerabilities. Use when handling user input,
  authentication, data storage, or external integrations. The non-negotiable
  security MUSTs live in `.agents/rules/security-baseline.md`; this skill shows
  how to apply them with process guidance, an audit-triage tree, and a review
  checklist.
---

# Security and Hardening

## Policy Capsule

- The non-negotiable security MUSTs — input validation, authentication, authorization, output/rendering, data-leakage & logging, transport & headers, secrets, dependency hygiene, and forbidden practices — live in [`.agents/rules/security-baseline.md`](../../../rules/security-baseline.md); that rule is the SSOT and wins on conflict. Read it for the **what**; this skill is the **how** and the process.
- Do **not** restate a baseline MUST here or work around one in code — open a PR against the rule instead. The baseline is inviolable ([`instructions.md` § 1.K](../../../instructions.md)); no skill relaxes it.
- Surface security-expanding changes — new auth flows, new PII categories, new external integrations, CORS / rate-limit changes, file uploads, elevated permissions — under a "Security surface" section in the PR body and on the ticket, label the change `risk::high`, and link the relevant baseline MUST.
- Surfacing **documents** the surface; it does **not** pause execution. `agent::blocked` is the only runtime pause label, reserved for unrecoverable blockers — never for "this change is sensitive."
- For validation-error responses (status code and envelope), cite [`.agents/rules/api-conventions.md`](../../../rules/api-conventions.md) — validation failures return **400** `VALIDATION_ERROR` in the canonical envelope. Do not carry a divergent inline status here.
- Open a `reference.md` section only when the task actually engages it (index below).

The MUSTs themselves are the SSOT in
[`security-baseline.md`](../../../rules/security-baseline.md). When the rule and
this skill diverge, the rule wins.

## Long-form reference — read on demand

The capsule above is the contract and the whole always-read surface of this
skill. The project-specific process material behind it lives in the on-demand
sibling [`reference.md`](reference.md), matching the split the always-on rules
use ([`rules/git-conventions.md`](../../../rules/git-conventions.md) ⇄
[`git-conventions-reference.md`](../../../rules/git-conventions-reference.md)).
Activating this skill costs the capsule; open a section below only when the
task engages it.

- [Security Surfacing, Not Runtime Pause](reference.md#security-surfacing-not-runtime-pause)
- [Validation-Error Responses](reference.md#validation-error-responses)
- [Triaging npm audit Results](reference.md#triaging-npm-audit-results)
- [Security Review Checklist](reference.md#security-review-checklist)
