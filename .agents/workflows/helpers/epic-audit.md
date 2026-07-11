---
description: >-
  Resolve the slim Epic-close (gate3) lens roster for /deliver. Consumes the
  epic-audit-prepare envelope, restricts it to the cumulative + global +
  risk-routed lenses the Epic-close tier owns, and hands that roster to the
  Phase 5 code-review pass — which walks the cumulative Epic diff once and folds
  the lens findings into its single verification-results comment.
---

# Epic-close lens roster (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/deliver` Phase 4 once the wave loop completes (all Stories at
> `agent::done`) to resolve the Epic-close lens roster that the Phase 5
> code-review pass walks. To run delivery, use `/deliver [Epic_ID]` (or pass
> `--skip-epic-audit` to bypass the Epic-close lens tier).

This helper resolves the **change-set-aware Epic-close lens roster** for an
Epic branch. Under the three-tier verification model (Epic #4405) it does
**not** run a standalone lens walk of its own and does **not** post its own
structured comment. It selects the slim roster and hands it to the Phase 5
[`code-review.md`](code-review.md) pass, which walks the cumulative Epic diff
**once** — executing these lenses as review dimensions — and folds their
findings into the single `verification-results` comment it posts on the Epic.

> **Three-tier model — where each lens concern is verified.** A lens's `scope`
> field in [`audit-rules.json`](../../schemas/audit-rules.json) (resolved by
> [`resolveLensTier`](../../scripts/lib/audit-suite/selector.js)) decides the
> **one** tier that owns its concern:
>
> - **`local`** — decidable from a single Story's diff. Verified **write-time**
>   (the distilled checklist threaded into the Story implementation prompt,
>   Story #4410) and at **Story-scope** (the maker-blind local-lens pass in
>   `story-close`, Story #4409). **Not** re-run at Epic close.
> - **`cumulative`** — only decidable across the Epic's combined diff. Verified
>   at **Epic close** only.
> - **`global`** — evaluates a whole-product property regardless of the diff
>   (exempt from the cross-epic-leak change-set narrowing). Verified at **Epic
>   close** only.
>
> No lens concern is verified at more than one tier: the Epic-close roster
> below deliberately **excludes every local-tier change-set lens** and keeps
> only cumulative + global + risk-routed lenses.

**When to run**: After Phase 3 close-validation passes, to resolve the roster
the Phase 5 code-review pass consumes. `/deliver` invokes this automatically
once the wave loop completes and all Stories reach `agent::done`.

**Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
`core/security-and-hardening`

## Step 0 — Resolve Context

1. Resolve `[EPIC_ID]` — the GitHub Issue number of the Epic under audit.
2. Resolve `[EPIC_BRANCH]` — `epic/<epicId>`.
3. Resolve `[BASE_BRANCH]` from `baseBranch` in `.agentrc.json` (default:
   `main`).
4. Fetch the Epic ticket — the Epic body is the single planning
   document:
   - **Narrative sections** — Context / Goal / Scope / User Stories /
     Acceptance Criteria.
   - **Tech Spec** — the folded Tech Spec sections (opening with
     `## Delivery Slicing`) inside the body's managed region.
5. Read the Epic body fully (including its Tech Spec sections) to
   understand the intended scope, selected lenses, and acceptance criteria.

## Step 1 — Prepare (`epic-audit-prepare.js`)

Run the prepare CLI to compute the change-set, ask `selectAudits` which
lenses fire at `gate3` (the Epic close gate), union in the model-judged
risk-routed lenses, and emit the helper-consumable JSON envelope on stdout:

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
  "depth": "deep",
  "selectedAudits": ["audit-security", "audit-architecture", "audit-privacy"],
  "epicCloseLenses": ["audit-architecture", "audit-security"],
  "changeSetAudits": ["audit-architecture", "audit-privacy"],
  "riskRoutedAudits": ["audit-security"],
  "globalLenses": [],
  "changedFiles": ["src/api/admin/users.ts", "..."],
  "changedFilesCount": 47,
  "substitutionsPayload": "src/api/admin/users.ts\n..."
}
```

- **`epicCloseLenses` is the roster you hand to Phase 5.** It is the slim
  Epic-close roster — `selectedAudits` restricted to the tiers the Epic-close
  tier owns via
  [`selectEpicCloseLenses`](../../scripts/lib/orchestration/code-review.js):
  every **cumulative** and **global** change-set lens, plus every **risk-routed**
  lens, with every **local-tier** change-set lens dropped (its concern is
  already verified shift-left). In the example above `audit-privacy` (local) is
  excluded from `epicCloseLenses` while `audit-architecture` (cumulative) is
  kept and `audit-security` (risk-routed) is kept.
- **`selectedAudits` / `changeSetAudits` / `riskRoutedAudits`** are surfaced for
  observability so the operator can see the pre-slim union and why each lens
  fired. Do **not** walk `selectedAudits` — walk `epicCloseLenses`.
- **`globalLenses`** is the subset of the roster on the global-lens allowlist
  (e.g. `audit-navigability`) that the Phase 5 walk runs against the WHOLE
  route tree, exempt from the cross-epic-leak guard's change-set narrowing
  (Epic #4131, F2).

### The `depth` field (Story #3939)

`depth` is `light`, `standard`, or `deep` — an **orthogonal** signal that
tells the Phase 5 pass how thorough each **rostered** lens should be on this
Epic. It is resolved by the shared `resolveDepth` resolver from the Epic's
model-judged risk envelope (`overallLevel` off the `epic-plan-state`
checkpoint) folded with `changedFilesCount`: a high-risk **or** wide-footprint
Epic resolves to `deep`, a low-risk small one to `light`, and everything else
— including an Epic that skipped `/plan` and has no checkpoint — to `standard`.
Depth changes **how deeply** each lens runs, never **which** lenses fire.

### Outcomes

- **`epicCloseLenses` is non-empty** — pass the roster (and `depth`,
  `globalLenses`, `substitutionsPayload`) to the Phase 5 code-review pass.
- **`epicCloseLenses` is empty** (docs-only change set, or every selected lens
  was a local-tier change-set lens already covered shift-left, and no high-risk
  axis routed a lens) — there is no Epic-close lens dimension to walk; the
  Phase 5 pass still runs its review pillars and posts the
  `verification-results` comment.
- **`degraded: true`** — the selector aborted. Possible `reason` codes:
  `GIT_DIFF_TIMEOUT` (git-diff timed out), `HEAD_REF_UNRESOLVED` (the
  Epic's branch `refs/heads/epic/<id>` is not present in this checkout),
  or `EPIC_REF_MISMATCH` (the selector diffed a ref other than the
  requested Epic's branch — the cross-epic-leak guard from Story #3362).
  Surface the `reason`/`detail` fields to the operator, post a friction
  comment on the Epic, and STOP. Do not fall back to running the full lens
  roster — that defeats the change-set scoping, and an unresolved/mismatched
  ref means the change set would belong to the wrong Epic.

## Step 2 — Hand the roster to the Phase 5 code-review pass

The cumulative Epic diff is walked **once** at Epic close. The
`epicCloseLenses` roster is executed as **dimensions of the Phase 5
code-review pass** ([`code-review.md`](code-review.md) with `scope: epic`),
not as a standalone walk here. The Phase 5 pass:

1. Loads each rostered lens's `.agents/workflows/audit-<lens>.md` via
   [`runAuditSuite`](../../scripts/lib/audit-suite/index.js) (the
   prompt-assembly runner), applying the `{{changedFiles}}` / `{{ticketId}}` /
   `{{baseBranch}}` substitutions from this envelope.
2. Executes each lens inline at the run's `depth` over the cumulative diff,
   folding its findings into the pass's severity aggregate alongside the review
   pillars — one walk of `main..epic/<id>`, one aggregate.
3. Posts the single `verification-results` structured comment (there is **no**
   separate `audit-results` comment; that producer was retired in Story #4412).

Remediation of the aggregate is **tier-aware** (Story #4412): the Epic-close
tier reads `delivery.epicAudit.autoFixSeverity` (default **`high`** — see
[`config/runners.js`](../../scripts/lib/config/runners.js)) and routes only
🔴 Critical + 🟠 High findings into on-branch remediation; 🟡 Medium and
🟢 Suggestion findings graduate to follow-up issues, because 🟡 Medium concerns
are already remediated shift-left at the write-time and Story-scope tiers.
Setting `medium` opts back into routing 🔴/🟠/🟡 on-branch. The severity gate
is **unchanged** — a surviving 🔴 Critical Blocker halts the run.

## Constraints

- **Always** diff against `[BASE_BRANCH]`, not against individual Story
  branches. The Epic-close pass examines the cumulative effect of the entire
  Epic.
- **Always** read the Epic body and Tech Spec before the Phase 5 walk. Findings
  without spec context are noise.
- **Never** walk `selectedAudits`. The roster the Phase 5 pass executes is
  `epicCloseLenses` — the slim cumulative + global + risk-routed set. Walking
  the pre-slim union re-verifies local-tier concerns already covered
  shift-left, defeating the three-tier model.
- **Never** widen the roster past `epicCloseLenses`. The whole point of the
  change-set selector plus the tier filter is to avoid re-running irrelevant or
  already-verified lenses on a scoped Epic.
- **Never** post an `audit-results` structured comment. The Epic-close lens
  findings are folded into the Phase 5 `verification-results` comment — the
  single findings surface on the Epic.
- **Always** propagate `degraded` envelopes verbatim. Do not paper over a
  selector failure with a full-roster fallback.
