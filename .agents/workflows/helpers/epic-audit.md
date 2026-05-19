---
description: >-
  Run smart change-set audits at Epic finalize. Consumes the epic-audit-prepare
  envelope, dispatches each selected lens inline via runAuditSuite, and posts
  an audit-results structured comment back onto the Epic ticket.
---

# Epic Audit (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/epic-deliver` Phase 4 and from the Bookend Lifecycle when all Tasks reach
> `agent::done`. To run an audit directly, use `/epic-deliver [Epic_ID]` — it
> delegates here (or pass `--skip-epic-audit` to bypass).

This helper runs the **change-set-aware audit pass** on an Epic branch
before the code-review helper opens its review. Unlike code-review (which
walks the full diff against `main` through six fixed pillars), epic-audit
asks the [`selectAudits`](../../scripts/lib/audit-suite/index.js) SDK which
lenses are actually relevant to **this** Epic's change set, then dispatches
only the matching audit workflows. Docs-only Epics select zero lenses and
exit cleanly.

> **When to run**: After Phase 3 close-validation passes and before Phase 5
> code-review. The Bookend Lifecycle in `/epic-deliver` invokes this
> automatically when all Tasks reach `agent::done`.
>
> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

## Step 0 — Resolve Context

1. Resolve `[EPIC_ID]` — the GitHub Issue number of the Epic under audit.
2. Resolve `[EPIC_BRANCH]` — `epic/<epicId>`.
3. Resolve `[BASE_BRANCH]` from `baseBranch` in `.agentrc.json` (default:
   `main`).
4. Fetch the Epic ticket and identify linked context tickets:
   - **PRD** — the `context::prd` ticket linked in the Epic body.
   - **Tech Spec** — the `context::tech-spec` ticket linked in the Epic
     body.
5. Read both the PRD and Tech Spec fully to understand the intended scope,
   selected lenses, and acceptance criteria.

## Step 1 — Prepare (`epic-audit-prepare.js`)

Run the prepare CLI to compute the change-set, ask `selectAudits` which
lenses fire at `gate3` (the Epic close gate), and emit the helper-consumable
JSON envelope on stdout:

```bash
node .agents/scripts/epic-audit-prepare.js \
  --epic [EPIC_ID] --base-branch [BASE_BRANCH] --gate gate3
```

The CLI is thin glue around the audit-suite SDK and is fully described in
[`epic-audit-prepare.js`](../../scripts/epic-audit-prepare.js). Capture the
envelope:

```json
{
  "epicId": 2586,
  "epicBranch": "epic/2586",
  "selectedAudits": ["audit-security", "audit-privacy"],
  "changedFiles": ["src/api/admin/users.ts", "..."],
  "changedFilesCount": 47,
  "substitutionsPayload": "src/api/admin/users.ts\n..."
}
```

### Outcomes

- **`selectedAudits` is non-empty** — continue to Step 2.
- **`selectedAudits` is empty** (docs-only or no-lens change set) — skip
  Step 2 and write the docs-only marker described in Step 4.
- **`degraded: true`** — the selector aborted (typically a git-diff
  timeout). Surface the `reason`/`detail` fields to the operator, post a
  friction comment on the Epic, and STOP. Do not fall back to running the
  full lens roster — that defeats the change-set scoping.

## Step 2 — Walk Selected Lenses (`runAuditSuite`)

For each lens name in `selectedAudits`, invoke
[`runAuditSuite`](../../scripts/lib/audit-suite/index.js) inline with the
prepare envelope as the substitution source. The runner loads the matching
`.agents/workflows/audit-<lens>.md` file, applies substitutions
(`{{changedFiles}}`, `{{ticketId}}`, `{{baseBranch}}`, …), and returns a
slim workflow descriptor plus a per-lens artifact path under
`<auditOutputDir>` (default `temp/audits/`):

```bash
node .agents/scripts/run-audit-suite.js \
  --audits audit-security audit-privacy \
  --substitutions '{"ticketId":"[EPIC_ID]","baseBranch":"[BASE_BRANCH]","changedFiles":"[substitutionsPayload]"}' \
  --artifact-prefix epic-[EPIC_ID]
```

Then **read each per-lens artifact** under
`<auditOutputDir>/audit-epic-[EPIC_ID]-<lens>.md` and walk its findings
inline. Each lens workflow declares its own pillars, severity rubric, and
remediation prose — follow the workflow's procedure verbatim. Aggregate
findings across lenses by severity (🔴 / 🟠 / 🟡 / 🟢) for the Step 4 report.

## Step 3 — Auto-fix Loop

Walk the aggregated 🔴 / 🟠 findings from Step 2 through the shared
bounded-retry loop in
[`../../scripts/lib/orchestration/auto-fix-loop.js`](../../scripts/lib/orchestration/auto-fix-loop.js).
The module owns the control flow (per-finding attempt ceiling, scope-cap,
anti-thrash, safety escalation); this helper supplies the phase-specific
hooks.

Resolve the loop budget from `.agentrc.json`:

- **`delivery.epicAudit.maxFixAttempts`** — per-finding attempt ceiling
  (`attemptCeiling`). Defaults to 3 if unset.
- **`delivery.epicAudit.maxFixScopeFiles`** — per-fix file scope cap
  (`scopeCap`). Defaults to 5 if unset.

Invoke `runAutoFixLoop` inline (Node ESM, top-level `await` inside the
helper's runner block):

```js
import {
  runAutoFixLoop,
} from '../../scripts/lib/orchestration/auto-fix-loop.js';

const { fixed, escalated } = await runAutoFixLoop({
  findings: aggregatedFindings, // 🔴 + 🟠 from Step 2, ordered by severity
  attemptCeiling: cfg.delivery?.epicAudit?.maxFixAttempts ?? 3,
  scopeCap: cfg.delivery?.epicAudit?.maxFixScopeFiles ?? 5,
  classify, // returns 'spec-deviation' | 'secrets' | … | 'fixable'
  applyFix, // assert-branch + edit + focused commit on [EPIC_BRANCH]
  rescan, // re-run the owning lens via run-audit-suite.js
  validate, // npm run lint + npm test (lens-appropriate subset)
});
```

The helper's `applyFix` hook MUST:

1. Call [`assert-branch.js`](../../scripts/assert-branch.js) with
   `--expected [EPIC_BRANCH]` before touching the working tree.
2. Stage explicit paths only (never `git add .`).
3. Make one focused conventional commit per finding
   (`fix(<scope>): <description> (audit finding)`).

Findings that route to `escalated[]` (safety classes, `ceiling-exhausted`,
`thrash-detected`, `validation-regression`, `scope-exceeded`) flow through
to Step 4 unchanged — the loop does not delete them, it just stops trying
to fix them automatically. Surface the `escalated` reasons in the
`audit-results` comment so the operator sees why the loop bailed.

## Step 4 — Post `audit-results` Structured Comment

Persist the findings as an `audit-results` structured comment on the Epic
issue. The comment is idempotent — re-runs replace the prior one. Build the
body in a temp file under `[TEMP_ROOT]/epic-[EPIC_ID]/audit-results.md`,
then upsert via [`post-structured-comment.js`](../../scripts/post-structured-comment.js):

```bash
node .agents/scripts/post-structured-comment.js \
  --ticket [EPIC_ID] \
  --marker audit-results \
  --body-file [TEMP_ROOT]/epic-[EPIC_ID]/audit-results.md
```

The body MUST include:

- the `selectedAudits` roster (or `Lenses applied: none (docs-only)` when
  the prepare envelope returned an empty list),
- the per-severity counts (🔴 critical / 🟠 high / 🟡 medium / 🟢 suggestion),
- the per-lens findings grouped under the lens name, each carrying file
  path + line range + pillar + recommended fix,
- a link to the per-lens artifact files under `<auditOutputDir>` so the
  operator (and downstream retro) can re-read the full prompt body.

### Severity gating

- **Any 🔴 Critical Blocker** → STOP. Relay to the operator and let
  `/epic-deliver` Phase 4 record a manual intervention.
- **Only 🟠/🟡/🟢** → log as non-blocking and return to `/epic-deliver`
  Phase 5 (code-review).

## Constraints

- **Always** diff against `[BASE_BRANCH]`, not against individual Story
  branches. The audit examines the cumulative effect of the entire Epic.
- **Always** read the PRD and Tech Spec before walking lenses. Findings
  without spec context are noise.
- **Always** run auto-fix through the shared `runAutoFixLoop` module — never
  re-derive bounded-retry / anti-thrash / escalation semantics inline. The
  loop is the single source of truth for those guarantees.
- **Never** widen the lens roster past `selectedAudits`. The whole point of
  the change-set selector is to avoid running irrelevant audits on a
  scoped Epic — running extras defeats the gate.
- **Always** propagate `degraded` envelopes verbatim. Do not paper over a
  selector failure with a full-roster fallback.
