---
description: >-
  Perform a comprehensive code review of a change set scoped to either a Story
  branch or an Epic branch
---

# Code Review (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/story-deliver` (Story scope) and `/epic-deliver` Phase 5 (Epic scope).
> To run a review directly, invoke the parent workflow — operators do not
> call this helper by hand.

This helper performs a comprehensive code review of a change set before it
is merged upstream. It runs in two scopes:

- **Story scope** — reviews the diff between a Story branch and its parent
  Epic branch, before `story-close.js` merges the Story into the Epic.
- **Epic scope** — reviews the cumulative diff between an Epic branch and
  `main`, before `/epic-deliver` opens the integration pull request.

> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

## Argument contract

The caller passes the following arguments (Story workflows pass
`scope: story`; Epic workflows pass `scope: epic`):

| Argument    | Type                  | Required | Meaning                                                                                          |
| ----------- | --------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `scope`     | `"story"` \| `"epic"` | yes      | Selects the integration-pillar diff base and the structured-comment target ticket.               |
| `ticketId`  | integer               | yes      | GitHub issue number of the Story (when `scope === 'story'`) or Epic (when `scope === 'epic'`).   |
| `baseRef`   | string (git ref)      | yes      | The diff base. Story scope: `epic/<epicId>`. Epic scope: `main` (or `project.baseBranch`).       |
| `headRef`   | string (git ref)      | yes      | The branch tip under review. Story scope: `story-<storyId>`. Epic scope: `epic/<epicId>`.        |

All scope-dependent behavior in this helper branches off these four
arguments. Do not hard-code branch names or ticket types — read them from
the argument envelope.

## Step 0 — Resolve Context

1. Resolve `[TICKET_ID]` from `ticketId` (Story or Epic depending on `scope`).
2. Resolve `[BASE_REF]` from `baseRef` and `[HEAD_REF]` from `headRef`.
3. Fetch the `[TICKET_ID]` ticket and identify linked context tickets:
   - **Story scope** — read the parent Epic from the Story body, then load
     the Epic's `context::prd` (PRD) and `context::tech-spec` (Tech Spec).
   - **Epic scope** — load the Epic's `context::prd` (PRD) and
     `context::tech-spec` (Tech Spec) directly from the Epic body.
4. Read both the PRD and Tech Spec fully to understand the intended scope,
   architectural decisions, and acceptance criteria.

## Step 1 — Automated Audit (Pre-Review)

The caller invokes the in-process code-review pipeline
(`runCodeReview` in `.agents/scripts/lib/orchestration/code-review.js`)
with the resolved `{ scope, ticketId, baseRef, headRef }` envelope. The
pluggable `ReviewProvider` adapter chain (Epic #2815) runs against the
diff `baseRef..headRef` and posts a structured summary to `[TICKET_ID]`.
The pipeline will:

- Generate a `git diff baseRef..headRef`.
- Calculate maintainability scores for all new/modified files.
- Run a focused lint check on the change set.
- Post a structured summary report to the `[TICKET_ID]` issue.

## Step 2 — Review Pillars

For each changed file, execute a strict review against three pillars. The
middle pillar (**Integration Review**) deliberately defers the security /
performance / quality / coverage sweeps to the change-set-scoped audits
that already ran upstream — re-walking them here is duplication, not
defense-in-depth.

### Pillar 1: Spec Adherence

Does the implementation match the PRD requirements and Tech Spec architecture?

- Compare each completed Story/Task against its stated acceptance criteria.
- Flag any undocumented deviations, missing features, or scope creep.
- Verify API contracts, data models, and interface boundaries match the Tech
  Spec.

### Pillar 2: Integration Review

The integration view depends on `scope`. The diff under review is always
`baseRef..headRef`, but the **set of upstream audit signals** to integrate
against differs:

- **`scope: story`** — the diff is `epic/<epicId>..story-<storyId>` (i.e.
  one Story's contribution to the Epic). There is typically no
  `audit-results` comment on the Story; Phase 4 epic-level audits have not
  yet run for this change set. The integration view here focuses on
  cross-Task ripple within the Story and contract drift against the Epic
  branch tip. Look for:
  - Cross-Task contract drift inside the Story (one Task's API change vs.
    another Task's caller in the same branch).
  - Shared-module ripple effects from this Story onto siblings already
    merged into `epic/<epicId>`.
  - Spec deviations that the per-Task commits papered over.

- **`scope: epic`** — the diff is `main..epic/<epicId>` (the cumulative
  Epic change set). Read the **`audit-results` structured comment** posted
  on the Epic ticket by the [`epic-audit.md`](epic-audit.md) helper in
  Phase 4. That comment is the authoritative source of security, privacy,
  performance, code-quality, and test-coverage findings for this change
  set — they were produced by the change-set-aware lens selector and
  per-lens audit workflows under `.agents/workflows/audit-*.md`. Do **not**
  re-derive those findings inline here.

  The integration view at epic scope is what the per-lens audits cannot
  produce because each lens runs in isolation:

  - Cross-reference 🔴 / 🟠 audit findings against the spec deviations
    flagged in Pillar 1 — a finding that traces back to a deliberate
    Tech-Spec decision is different from one that traces back to an
    oversight.
  - Look for cross-cutting concerns no single lens owns: contract drift
    between Stories, shared-module ripple effects, boundary changes that
    thread security and performance implications together.
  - Note any audit finding that the operator's remediation flow should
    bundle (e.g. one refactor closes findings from multiple lenses).

  If the Epic has no `audit-results` comment (docs-only Epic, or Phase 4
  was skipped via `--skip-epic-audit`), record that explicitly in the
  findings report and proceed — there is nothing to integrate.

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

Findings are **persisted as a `code-review` structured comment on the
`[TICKET_ID]` issue** by `runCodeReview`. The target ticket is the Story
when `scope === 'story'` and the Epic when `scope === 'epic'`. The comment
is idempotent — re-runs replace the prior one — and its body includes
severity-tier counts plus the full findings list so downstream workflows
(notably the retro helper) can summarise blockers/high findings without
re-running the review.

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
  applyFix, // assert-branch + edit + focused commit on [HEAD_REF]
  rescan, // re-run runCodeReview or a targeted diff scan
  validate, // npm run lint + npm test
});
```

The helper's `applyFix` hook MUST:

1. Call [`assert-branch.js`](../../scripts/assert-branch.js) with
   `--expected [HEAD_REF]` before touching the working tree.
2. Stage explicit paths only (never `git add .`).
3. Make one focused conventional commit per finding
   (`fix(<scope>): <description> (review finding)`).

Findings that route to `escalated[]` (safety classes, `ceiling-exhausted`,
`thrash-detected`, `validation-regression`, `scope-exceeded`) remain on
the `code-review` structured comment for the operator to triage manually
in Step 5. The loop never deletes a finding it could not fix — it just
stops retrying.

## Step 4.6 — Cross-phase re-check trigger

After the auto-fix loop in Step 4.5 returns, the `fixed[]` commits have
modified files on `[HEAD_REF]` that the Phase 4 audit lenses already
walked. Some of those edits may overlap the `filePatterns` of one or more
lenses (e.g. an auto-fix landing in `**/auth/*.js` overlaps the
`audit-security` lens). When that happens, the prior `audit-results`
structured comment is **stale for the overlapping lenses only** — the
non-overlapping findings remain authoritative and MUST NOT be
re-derived.

> **Scope note.** This cross-phase re-check applies only when
> `scope === 'epic'`. Story-scope reviews run before Phase 4 epic audits
> exist, so there is no `audit-results` comment to invalidate; skip this
> step entirely for `scope === 'story'`.

Invoke the re-check selector with the cumulative set of paths touched by
the auto-fix commits:

```powershell
node .agents/scripts/epic-audit-recheck.js \
  --epic [TICKET_ID] --files <comma-separated-touched-paths>
```

For large touched-file lists, pass `@<file>` (where `<file>` is a
newline-delimited list written to `temp/`) to avoid shell argument-length
limits. The CLI emits a JSON envelope of the shape
`{ selectedAudits: [...], context: { ... } }` restricted to lenses whose
`filePatterns` overlap the input file list. An empty `selectedAudits`
array means no overlap — there is nothing to re-run and this step is a
no-op.

When `selectedAudits` is non-empty:

1. Re-invoke each listed lens prompt under
   [`../audit-*.md`](../) the same way Phase 4's `epic-audit.md` does —
   one lens at a time, against the current `[HEAD_REF]` tip.
2. **Append** a `## Cross-phase re-check` section to the **existing**
   `audit-results` structured comment on the Epic ticket. Do **not** post
   a new comment; the comment is idempotent and downstream consumers
   (the code-review trim, `/epic-deliver` Pillar 2, the retro helper)
   read it once. The append carries the re-checked lens names, the new
   findings (if any), and the auto-fix commit SHAs that triggered the
   re-run, so reviewers can trace each finding back to the change set
   that produced it.
3. If the re-check surfaces fresh 🔴 / 🟠 findings, route them back
   through Step 4.5's `runAutoFixLoop` invocation. The loop's per-finding
   ceiling is preserved across re-entries — a finding that was already
   counted against `attemptCeiling` in the first pass does not get a
   fresh budget when the cross-phase re-check resurfaces an adjacent
   one.

If `selectedAudits` is empty, skip silently and proceed to Step 5. The
re-check trigger is **read-only signal** — it never mutates the Epic
branch on its own; mutations only happen if the re-invoked lenses
surface findings that the auto-fix loop then converts into commits.

## Step 5 — Remediation

If the operator instructs you to fix any findings:

1. Implement the fixes on the `[HEAD_REF]` branch.
2. Commit each logical fix atomically:

   ```powershell
   # Guard: confirm we're on the correct branch before committing.
   node .agents/scripts/assert-branch.js --expected [HEAD_REF]

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
to the next phase of the parent workflow.

## Constraint

- **Always** diff `baseRef..headRef`. Never substitute a different base —
  the scope is set by the caller, and reviewing against the wrong base
  produces either a hollow review (too small a diff) or noise (too large a
  diff that includes unrelated history).
- **Always** read the PRD and Tech Spec before reviewing code. Findings without
  spec context are noise.
- **Never** implement fixes unless the operator explicitly requests it. The
  default mode is read-only audit.
- **Never** mark findings as Critical Blocker unless they represent a genuine
  security risk, data integrity issue, or functional breakage. Overuse of
  Critical severity creates alert fatigue.
- **Always** provide actionable, concrete fix suggestions — not vague advice
  like "consider improving this."
