---
description: >-
  Perform a comprehensive code review of all changes implemented during a sprint
---

# Sprint Code Review (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/epic-deliver` Phase 3 and from the Bookend Lifecycle in `/epic-deliver`
> when all Tasks reach `agent::done`. To run a review directly, use
> `/epic-deliver [Epic_ID]` — it delegates here (or pass `--skip-code-review`
> to bypass).

This helper performs a comprehensive code review of **all code changes** on an
Epic branch before it is merged to `main`. It is a mandatory Bookend phase —
every sprint must pass a code review before closure.

> **When to run**: After all Stories are merged into the Epic branch and before
> `/epic-deliver`. The Bookend Lifecycle in `/epic-deliver` invokes this
> automatically when all Tasks reach `agent::done`.
>
> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

## Step 0 — Resolve Context

1. Resolve `[EPIC_ID]` — the GitHub Issue number of the Epic under review.
2. Resolve `[EPIC_BRANCH]` — `epic/<epicId>`.
3. Resolve `[BASE_BRANCH]` from `baseBranch` in `.agentrc.json` (default:
   `main`).
4. Fetch the Epic ticket and identify linked context tickets:
   - **PRD** — the `context::prd` ticket linked in the Epic body.
   - **Tech Spec** — the `context::tech-spec` ticket linked in the Epic body.
5. Read both the PRD and Tech Spec fully to understand the intended scope,
   architectural decisions, and acceptance criteria.

## Step 1 — Automated Audit (Pre-Review)

Run the automated code review script to perform a quick maintainability and lint
sweep of the changes:

```powershell
node .agents/scripts/epic-code-review.js --epic [EPIC_ID]
```

This script will:

- Generate a `git diff` against `main`.
- Calculate maintainability scores for all new/modified files.
- Run a focused lint check.
- Post a structured summary report to the Epic issue.

## Step 2 — Review Pillars

For each changed file, execute a strict review against three pillars. The
middle pillar (**Integration Review**) deliberately defers the security /
performance / quality / coverage sweeps to the change-set-scoped audits
that already ran in Phase 4 — re-walking them here is duplication, not
defense-in-depth.

### Pillar 1: Spec Adherence

Does the implementation match the PRD requirements and Tech Spec architecture?

- Compare each completed Story/Task against its stated acceptance criteria.
- Flag any undocumented deviations, missing features, or scope creep.
- Verify API contracts, data models, and interface boundaries match the Tech
  Spec.

### Pillar 2: Integration Review

Read the **`audit-results` structured comment** posted on the Epic ticket by
the [`epic-audit.md`](epic-audit.md) helper in Phase 4. That comment is the
authoritative source of security, privacy, performance, code-quality, and
test-coverage findings for this change set — they were produced by the
change-set-aware lens selector and per-lens audit workflows under
`.agents/workflows/audit-*.md`. Do **not** re-derive those findings inline
here.

Your job in this pillar is the **integration view** the per-lens audits
cannot produce because each lens runs in isolation:

- Cross-reference 🔴 / 🟠 audit findings against the spec deviations flagged
  in Pillar 1 — a finding that traces back to a deliberate Tech-Spec
  decision is different from one that traces back to an oversight.
- Look for cross-cutting concerns no single lens owns: contract drift
  between Stories, shared-module ripple effects, boundary changes that
  thread security and performance implications together.
- Note any audit finding that the operator's remediation flow should
  bundle (e.g. one refactor closes findings from multiple lenses).

If the Epic has no `audit-results` comment (docs-only Epic, or Phase 4 was
skipped via `--skip-epic-audit`), record that explicitly in the findings
report and proceed — there is nothing to integrate.

### Pillar 3: Documentation Integrity

Verify documentation stays synchronized with code:

- All new public APIs have JSDoc/TSDoc comments.
- Updated interfaces have updated documentation.
- README and CHANGELOG reflect the changes if applicable.
- Inline comments explain _why_, not _what_.

## Step 3 — Maintainability Ratchet

Verify that no file's maintainability score has decreased below the project
baseline. The unified baselines gate enforces this floor:

```powershell
node .agents/scripts/check-baselines.js --format text
```

If this check fails, you MUST refactor the offending files to meet or exceed the
prior baseline before merging.

## Step 4 — Produce Findings Report

Findings are **persisted as a `code-review` structured comment on the Epic
issue** by `epic-code-review.js` (v5.9.0+). The comment is idempotent —
re-runs replace the prior one — and its body includes severity-tier counts plus
the full findings list so downstream workflows (notably the retro helper) can
summarise blockers/high findings without re-running the review.

Output a consolidated findings report grouped by severity:

1. **🔴 Critical Blocker** — Must be fixed before merge (security
   vulnerabilities, data loss risks, broken functionality).
2. **🟠 High Risk** — Should be fixed before merge (performance regressions,
   missing auth checks, spec deviations).
3. **🟡 Medium Risk** — Should be addressed but not blocking (code quality
   issues, missing tests for edge cases).
4. **🟢 Suggestion** — Nice-to-have improvements (style, naming, minor
   optimizations).

For every finding, provide:

- **File path** and **line number(s)**
- **Pillar** (which review pillar it failed)
- **Description** of the issue
- **Recommended fix** with a concrete code suggestion
- **Agent Prompt** — a self-contained, copy-pasteable instruction the
  operator can hand verbatim to a fresh sub-agent (or the auto-fix loop)
  to remediate this single finding. The prompt MUST name the file path,
  the specific change to make, and the acceptance check that proves the
  fix worked. Keep it tight (≤ 5 sentences); the sub-agent will read the
  surrounding code itself.

## Step 4.5 — Auto-fix Loop

Walk the 🔴 / 🟠 findings from Step 4 through the shared bounded-retry
loop in
[`../../scripts/lib/orchestration/auto-fix-loop.js`](../../scripts/lib/orchestration/auto-fix-loop.js).
The module owns the control flow (per-finding attempt ceiling, scope-cap,
anti-thrash, safety escalation); this helper supplies the phase-specific
hooks.

Resolve the loop budget from `.agentrc.json`:

- **`delivery.codeReview.maxFixAttempts`** — per-finding attempt ceiling
  (`attemptCeiling`). Defaults to 3 if unset.
- **`delivery.codeReview.maxFixScopeFiles`** — per-fix file scope cap
  (`scopeCap`). Defaults to 5 if unset.

Invoke `runAutoFixLoop` inline (Node ESM):

```js
import {
  runAutoFixLoop,
} from '../../scripts/lib/orchestration/auto-fix-loop.js';

const { fixed, escalated } = await runAutoFixLoop({
  findings: reviewFindings, // 🔴 + 🟠 from Step 4, ordered by severity
  attemptCeiling: cfg.delivery?.codeReview?.maxFixAttempts ?? 3,
  scopeCap: cfg.delivery?.codeReview?.maxFixScopeFiles ?? 5,
  classify, // returns 'spec-deviation' | 'secrets' | … | 'fixable'
  applyFix, // assert-branch + edit + focused commit on [EPIC_BRANCH]
  rescan, // re-run epic-code-review.js or targeted diff scan
  validate, // npm run lint + npm test
});
```

The helper's `applyFix` hook MUST:

1. Call [`assert-branch.js`](../../scripts/assert-branch.js) with
   `--expected [EPIC_BRANCH]` before touching the working tree.
2. Stage explicit paths only (never `git add .`).
3. Make one focused conventional commit per finding
   (`fix(<scope>): <description> (review finding)`).

Findings that route to `escalated[]` (safety classes, `ceiling-exhausted`,
`thrash-detected`, `validation-regression`, `scope-exceeded`) remain on
the `code-review` structured comment for the operator to triage manually
in Step 5. The loop never deletes a finding it could not fix — it just
stops retrying.

## Step 5 — Remediation

If the operator instructs you to fix any findings:

1. Implement the fixes on the `[EPIC_BRANCH]`.
2. Commit each logical fix atomically:

   ```powershell
   # Guard: confirm we're on the Epic branch before committing.
   node .agents/scripts/assert-branch.js --expected [EPIC_BRANCH]

   # Stage explicit paths — never `git add .` on a shared tree.
   git add <path/one> <path/two>
   # or, for tracked edits only:
   # git add -u

   git commit -m "fix(<scope>): <description> (review finding)"
   ```

3. Re-run the project's validation suite to confirm no regressions:

   ```powershell
   npm run lint
   npm test
   ```

If no fixes are requested, this workflow is complete. The operator may proceed
to `/epic-deliver`.

## Constraint

- **Always** diff against `[BASE_BRANCH]`, not against individual Story
  branches. The review examines the **cumulative** effect of the entire Epic.
- **Always** read the PRD and Tech Spec before reviewing code. Findings without
  spec context are noise.
- **Never** implement fixes unless the operator explicitly requests it. The
  default mode is read-only audit.
- **Never** mark findings as Critical Blocker unless they represent a genuine
  security risk, data integrity issue, or functional breakage. Overuse of
  Critical severity creates alert fatigue.
- **Always** provide actionable, concrete fix suggestions — not vague advice
  like "consider improving this."
