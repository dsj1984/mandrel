---
description: >-
  Run smart change-set audits at Epic finalize. Consumes the epic-audit-prepare
  envelope, dispatches each selected lens (inline, or via a single
  audit-orchestrator sub-agent that fans the lenses out as parallel level-2
  agents) through runAuditSuite, and posts an audit-results structured comment
  back onto the Epic ticket.
---

# Epic Audit (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/deliver` Phase 4 once the wave loop completes (all Stories at
> `agent::done`). To run an audit directly, use `/deliver [Epic_ID]` — it
> delegates here (or pass `--skip-epic-audit` to bypass).

This helper runs the **change-set-aware audit pass** on an Epic branch
before the code-review helper opens its review. Unlike code-review (which
walks the full diff against `main` through six fixed pillars), epic-audit
asks the [`selectAudits`](../../scripts/lib/audit-suite/index.js) SDK which
lenses are actually relevant to **this** Epic's change set, then dispatches
only the matching audit workflows. Docs-only Epics select zero lenses and
exit cleanly.

In addition to the change-set selection, `epic-audit-prepare.js` unions in
the **risk-routed lenses** (Story #3889): it reads the Epic's model-judged
`planningRisk` envelope off the `epic-plan-state` checkpoint and routes each
high-risk axis to its mapped lens via
[`resolveAuditLenses`](../../scripts/lib/orchestration/code-review.js)
(`security` → `audit-security`, `public-api` → `audit-architecture`). A
high-risk Epic therefore auto-runs its mapped lenses even when the change
set alone did not select them; a low-risk Epic adds nothing beyond the
change-set selection. Both lens sources fire through the **same**
`runAuditSuite` dispatch below — no new audit machinery.

> **When to run**: After Phase 3 close-validation passes and before Phase 5
> code-review. `/deliver` invokes this automatically once the wave loop
> completes and all Stories reach `agent::done`.
>
> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

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
   understand the intended
   scope, selected lenses, and acceptance criteria.

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
  "depth": "deep",
  "selectedAudits": ["audit-security", "audit-privacy"],
  "changeSetAudits": ["audit-privacy"],
  "riskRoutedAudits": ["audit-security"],
  "changedFiles": ["src/api/admin/users.ts", "..."],
  "changedFilesCount": 47,
  "substitutionsPayload": "src/api/admin/users.ts\n..."
}
```

`selectedAudits` is the de-duplicated **union** of `changeSetAudits` (the
change-set selection) and `riskRoutedAudits` (the model-judged risk-routed
lenses). The two source arrays are surfaced for observability so the
operator can see why each lens fired. Dispatch the `selectedAudits` union
in Step 2.

### The `depth` field (Story #3939)

`depth` is `light`, `standard`, or `deep` — an **orthogonal** signal that
tells you how thorough each **selected** lens should be on this Epic. It is
resolved by the shared `resolveDepth` resolver from the Epic's model-judged
risk envelope (`overallLevel` off the `epic-plan-state` checkpoint) folded
with `changedFilesCount`: a high-risk **or** wide-footprint Epic resolves to
`deep`, a low-risk small one to `light`, and everything else — including an
Epic that skipped `/plan` and has no checkpoint — to `standard`.

Depth changes **how deeply** each lens runs, never **which** lenses fire:

- **`light`** — run each selected lens against the **changed surface only**
  and report **only Critical/High** findings. Skip the Medium/Suggestion
  sweep. Light **never skips a selected lens** — including the alwaysRun
  floor (`audit-clean-code`, `audit-architecture`) — it only **shrinks the
  selected lens's sweep**. An easy, low-risk Epic still runs its audits;
  they just run lighter.
- **`standard`** — today's behavior: walk each selected lens's full
  procedure over the changed surface at every severity.
- **`deep`** — run the full lens procedure over the changed surface **plus
  the modules it directly touches**, at every severity.

Depth never changes the severity taxonomy, the findings-report shape, or the
Phase 4 halting rule below (a 🔴 Critical Blocker halts at every depth;
everything else logs). Thread the resolved `depth` into each lens walk in
Step 2 — it scopes the sweep, it does not gate the roster.

### Outcomes

- **`selectedAudits` is non-empty** — continue to Step 2.
- **`selectedAudits` is empty** (docs-only or no-lens change set, and no
  high-risk axis routed a lens) — skip Step 2 and write the docs-only
  marker described in Step 4.
- **`degraded: true`** — the selector aborted. Possible `reason` codes:
  `GIT_DIFF_TIMEOUT` (git-diff timed out), `HEAD_REF_UNRESOLVED` (the
  Epic's branch `refs/heads/epic/<id>` is not present in this checkout),
  or `EPIC_REF_MISMATCH` (the selector diffed a ref other than the
  requested Epic's branch — the cross-epic-leak guard from Story #3362).
  Surface the `reason`/`detail` fields to the operator, post a friction
  comment on the Epic, and STOP. Do not fall back to running the full lens
  roster — that defeats the change-set scoping, and an unresolved/mismatched
  ref means the change set would belong to the wrong Epic.

## Step 2 — Walk Selected Lenses (`runAuditSuite`)

> **Execution model — the host LLM is the executor, not the CLI.**
> `run-audit-suite.js` is a **prompt-assembly runner**, not a findings
> generator. It resolves each lens to its workflow markdown, applies
> the `{{ticketId}}` / `{{baseBranch}}` / `{{changedFiles}}` (and any
> per-audit) substitutions, and returns one *workflow descriptor* per
> lens. Its return envelope intentionally carries `findings: []` and
> `summary: { critical:0, high:0, medium:0, low:0 }` because no lens
> has been *executed* yet — the host LLM walks each workflow's
> procedure inline against the substitution payload, severity-rates
> what it finds, and assembles the aggregate report in Step 4. If you
> expected `findings[]` to be populated by the CLI, the rest of this
> helper will surprise you; stop and re-read this paragraph.

For each lens name in `selectedAudits`, invoke
[`runAuditSuite`](../../scripts/lib/audit-suite/index.js) (or its CLI
wrapper) with the prepare envelope as the substitution source. The
runner loads the matching `.agents/workflows/audit-<lens>.md` file,
applies the substitutions, and — when `--run-id` is supplied — writes
the substituted body to a per-lens artifact at
`<auditOutputDir>/audit-<run-id>-<lens>.md` (default `auditOutputDir`
is `temp/audits/`):

```bash
node .agents/scripts/run-audit-suite.js \
  --audits audit-security,audit-privacy \
  --ticket [EPIC_ID] \
  --base-branch [BASE_BRANCH] \
  --substitution changedFiles="[substitutionsPayload]" \
  --run-id epic-[EPIC_ID]
```

CLI shape notes:

- `--audits` is **comma-separated**, not space-separated. Passing each
  lens as a separate positional arg only captures the first one.
- `--substitution` is **repeatable** (`key=value` per occurrence); the
  legacy `--substitutions '<json>'` flag is not supported.
- `--run-id` is the per-lens artifact prefix (the legacy
  `--artifact-prefix` flag is not supported). When omitted, no
  artifact is written and the host LLM must walk the workflow body in
  memory.

After the runner returns:

1. **Read the descriptor stream** — confirm every requested lens
   appears in `metadata.auditsRun`, then walk each entry in
   `workflows[]` (or each on-disk artifact when `--run-id` was set).
2. **Execute the lens inline at the run's `depth`.** Open the lens
   workflow at `path` (or the per-lens artifact file when `--run-id`
   produced one) and follow its procedure verbatim against the
   substituted change set, scoping the sweep to the envelope's `depth`
   (see "The `depth` field" above): `light` walks the changed surface and
   reports only 🔴/🟠 findings, `standard` walks the full procedure at
   every severity, and `deep` extends the sweep to the directly-touched
   modules. Depth scopes the sweep only — never skip a selected lens.
   Each lens declares its own pillars, severity rubric, and remediation
   prose; treat its body as the canonical execution contract for that
   pass.
3. **Aggregate** by severity (🔴 Critical Blocker / 🟠 High /
   🟡 Medium / 🟢 Suggestion). Hold the aggregate for Step 3
   (auto-fix) and Step 4 (the `audit-results` structured comment).

### Optional: delegate the roster walk to an audit-orchestrator sub-agent

The Step 2 loop above walks the `selectedAudits` roster **serially in the
host's own context**. When the roster carries more than one lens, `/deliver`
Phase 4 MAY instead delegate the whole walk to a **single audit-orchestrator
sub-agent** — one level-1 `Agent` call (`subagent_type: general-purpose`) — that:

1. Receives the **already-selected** `selectedAudits` roster, the run's
   `depth`, and the prepare envelope's substitution payload. It does **not**
   re-run `selectAudits` and does **not** widen the roster — the roster is
   fixed upstream by Step 1 (see the Constraints below).
2. Fans the roster out as **parallel level-2 agents, one per lens** (nested
   `Agent` dispatch — verified depth 2, announced max depth 5, per
   [#2870](https://github.com/dsj1984/mandrel/issues/2870) and the
   "Flat Story dispatch by design" note in
   [`deliver-epic.md`](deliver-epic.md)). Each level-2 agent executes exactly
   one lens's workflow procedure at the run's `depth`, isolated from the main
   context.
3. Collects the per-lens findings, **aggregates them by severity** (🔴 / 🟠 /
   🟡 / 🟢), and returns **only the aggregated audit-results** to the host —
   the per-lens reasoning transcripts stay in the level-2 leaves and never
   enter the main context. The host resumes at Step 3 (remediation routing)
   with the aggregate exactly as if it had walked the roster itself, and Step 4
   posts the identical `audit-results` comment.

This delegation is a **cross-lens parallelization of the roster walk only**. It
is orthogonal to — and MUST NOT be conflated with — the *per-lens execution
strategy*:

- **The per-lens cost/precision gate is preserved.** Each level-2 lens agent
  still runs its own lens at whatever strategy that lens's cost/precision gate
  dictates (`docs/roadmap.md` § "The per-lens cost / precision gate"): an
  orchestrated lens fans its own analysis dimensions out under
  `runAuditOrchestration`, a sequential-only lens runs turn-by-turn. Fanning
  the *roster* out in parallel changes **which context** runs a lens, never
  **how** that lens runs internally, so no per-lens cost gate is bypassed or
  altered.
- **The "do not batch-convert the sequential-only lenses" rule is preserved.**
  The seven sequential-only lenses (`audit-dependencies`, `audit-devops`,
  `audit-sre`, `audit-privacy`, `audit-seo`, `audit-ux-ui`,
  `audit-lighthouse`) stay sequential **inside** their level-2 agent.
  Dispatching them as parallel level-2 agents is **not** a batch-conversion of
  their internal execution — a sequential-only lens remains sequential-only
  (`docs/roadmap.md` § "Remaining orchestration surface"). Generalizing any of
  those lenses to orchestrated is still a separate, gated, lens-by-lens
  decision that this roster fan-out neither performs nor pre-empts.

Weigh the whole subtree's token cost before delegating
([`.agents/instructions.md` § 4](../../instructions.md) — cost compounds with
nesting depth): the level-1 orchestrator plus one level-2 agent per lens
re-pays the always-loaded context at each level. For a single-lens roster the
serial host walk is cheaper; the delegation pays off when several lenses fan
out at once. Either path produces the identical Step 4 `audit-results` comment,
so the delegation is a performance/context-isolation choice, never a change to
what gets audited or reported.

If a future Story lifts per-lens execution out of the host-LLM walk
into the CLI itself, the runner will populate `findings[]` and this
section will collapse to a "read the structured findings off the
envelope" bullet. Until then, the host LLM is the gate.

## Step 3 — Remediation Routing (host LLM, no automated loop)

There is **no runtime auto-fix function** at this phase. The host LLM is
the executor: it inspects the aggregated findings from Step 2 and either
applies a focused fix on the Epic branch or escalates the finding to the
operator via the `audit-results` comment in Step 4.

### Resolve the remediation threshold (Story #4399)

Read `delivery.epicAudit.autoFixSeverity` from the resolved `.agentrc.json`
(default **`medium`**; the resolver in
[`config/runners.js`](../../scripts/lib/config/runners.js) supplies the
default when the key is absent). The threshold governs **which severities
route into on-branch remediation** — it never changes the halting rule
(a surviving 🔴 still stops Phase 4 in Step 4) or the escalation classes:

- **`medium`** (default) — route 🔴 Critical, 🟠 High, **and 🟡 Medium**
  findings into remediation. 🟢 Suggestions still graduate to follow-up
  issues (never auto-fixed).
- **`high`** — route only 🔴 Critical and 🟠 High findings into
  remediation, reproducing the pre-4399 behavior exactly. 🟡 Medium and
  🟢 Suggestion findings graduate to follow-up issues untouched.

This is a hard cutover per
[`rules/git-conventions.md`](../../rules/git-conventions.md) § Contract
Cutovers — there is no back-compat flag; `high` is opt-in to the old
routing, `medium` is the shipped default.

### 🔴 / 🟠 findings — per-finding ceremony (unchanged)

For each 🔴 / 🟠 finding, the host LLM MUST decide between two paths:

1. **Apply a focused fix on `[EPIC_BRANCH]`.** Permitted only when the
   finding is unambiguously *fixable* (clean remediation, no scope creep,
   no spec deviation, no secret exposure):
   - Call [`assert-branch.js`](../../scripts/assert-branch.js) with
     `--expected [EPIC_BRANCH]` before touching the working tree.
   - Stage explicit paths only (never `git add .`).
   - Make one focused conventional commit per finding
     (`fix(<scope>): <description> (audit finding)`).
   - Re-run the owning lens (re-invoke `run-audit-suite.js` for that
     single lens) and confirm the finding is gone before moving on.
   - Run the lens-appropriate validation subset (`npm run lint` plus the
     relevant `npm test` slice) to confirm the fix did not regress
     anything.
   - If the rescan still surfaces the same finding, or validation
     regresses, **stop fixing** — route the finding to escalation
     (path 2) and record the attempt context in Step 4.
2. **Escalate to the operator via Step 4.** Required when the finding
   falls into any of the following classes:
   - `spec-deviation` — the change diverges from the Epic/Tech Spec.
   - `secrets` — credentials, tokens, or PII surfaced in the diff.
   - `test-deletion` — coverage was removed without an explicit
     decision in the spec.
   - `scope-exceeded` — the remediation would touch more files than the
     change set warrants.
   - Any finding the host LLM cannot remediate after one focused
     attempt (the equivalent of the prior loop's
     `validation-regression` / `thrash-detected` exits).

### 🟡 Medium findings — batched per-lens ceremony (only when `autoFixSeverity: medium`)

When the threshold is `medium`, remediate the fixable 🟡 Medium findings
in a **batch keyed by owning lens** rather than the per-finding ceremony
above — the per-finding rescan is disproportionate for the volume of
Mediums a wide change set surfaces:

1. Group the fixable Mediums by their owning lens. A Medium is fixable on
   the same terms as a 🟠 (clean remediation, no escalation class); a
   Medium that falls into any escalation class (`spec-deviation`,
   `secrets`, `test-deletion`, `scope-exceeded`) routes to Step 4
   untouched exactly like a 🟠.
2. For each lens, call `assert-branch.js --expected [EPIC_BRANCH]`, stage
   explicit paths only, and make **one focused conventional commit per
   lens** carrying all that lens's Medium fixes
   (`fix(<scope>): <description> (audit findings batch)`).
3. The bounded-attempt semantics extend to the batch: each finding in the
   batch gets **at most one** attempt, and a lens's batch commit that
   would exceed `delivery.epicAudit.maxFixScopeFiles` routes that lens's
   findings to escalation (`scope-exceeded`) instead of committing.
4. After **all** lens batches are committed, run a **single** validation
   pass (`npm run lint` plus the relevant `npm test` slice) and a
   **single** rescan of the **overlapping lenses only** (re-invoke
   `run-audit-suite.js` for the lenses whose findings were touched).
   Confirm the batched findings are gone. If a batched finding survives
   the rescan or validation regresses, route the surviving finding(s) to
   escalation and record the attempt context in Step 4.

Record every remediated finding (🟠 or 🟡) in the **"Fixed on-branch"**
section of the `audit-results` comment (Step 4) so it does not graduate to
a follow-up issue.

Do not invent a programmatic retry budget. The host LLM applies *at most
one* focused-fix attempt per finding (or per batched finding) before
escalating; any further remediation is the operator's call after reading
the `audit-results` comment.

Escalated findings flow through to Step 4 unchanged with their
escalation reason recorded — the audit pass does not delete them, it
just stops trying to fix them automatically. Surface the escalation
reason for each in the `audit-results` comment so the operator sees
exactly why the finding was not auto-remediated.

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

### The `## Fixed on-branch` section (Story #4399)

Findings that Step 3 remediated on the Epic branch MUST be rendered under a
dedicated **`## Fixed on-branch`** heading, **not** under their lens's
open-findings group. This is the contract seam that keeps remediated
findings from spawning ghost follow-up issues: the
[`audit-results` graduator](../../scripts/lib/feedback-loop/audit-results-graduator.js)
skips every entry inside this section (both because a fixed entry is
rendered with a **✅ prefix** — so it carries no leading severity emoji the
parser would match — and because the parser has an explicit
Fixed-on-branch section guard).

Render each fixed finding as a `✅`-prefixed line naming its original
severity, the file path in backticks, and the remediating commit SHA, e.g.:

```markdown
## Fixed on-branch

- ✅ 🟡 Medium (audit-clean-code): `.agents/scripts/foo.js` — dead branch removed (a1b2c3d)
- ✅ 🟠 High (audit-security): `src/api/users.js` — ownership check added (d4e5f6a)
```

Open (escalated / unfixed) findings stay under their lens heading with
their leading severity emoji so the graduator still files them.

### Severity gating

The gate is unchanged by the threshold — it keys off the **surviving**
(unfixed) findings after Step 3:

- **Any surviving 🔴 Critical Blocker** → STOP. Relay to the operator and
  let `/deliver` Phase 4 record a manual intervention.
- **Only 🟠/🟡/🟢 surviving** → log as non-blocking and return to
  `/deliver` Phase 5 (code-review).

## Constraints

- **Always** diff against `[BASE_BRANCH]`, not against individual Story
  branches. The audit examines the cumulative effect of the entire Epic.
- **Always** read the Epic body and Tech Spec before walking lenses. Findings
  without spec context are noise.
- **Always** cap focused fixes at one attempt per finding (Step 3). The
  host LLM is the executor; there is no shared retry/anti-thrash module
  to call. Any finding that does not resolve cleanly on the first attempt
  routes to escalation in Step 4.
- **Never** widen the lens roster past `selectedAudits`. The whole point of
  the change-set selector is to avoid running irrelevant audits on a
  scoped Epic — running extras defeats the gate.
- **Always** propagate `degraded` envelopes verbatim. Do not paper over a
  selector failure with a full-roster fallback.
