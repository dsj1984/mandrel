---
description: >-
  Perform a comprehensive code review of a change set scoped to either a Story
  branch or an Epic branch
---

# Code Review (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/deliver` (Story scope) and `/deliver` Phase 5 (Epic scope).
> To run a review directly, invoke the parent workflow — operators do not
> call this helper by hand.

This helper performs a comprehensive code review of a change set before it
is merged upstream. It runs in two scopes:

- **Story scope** — reviews the diff between a Story branch and its parent
  Epic branch, before `story-close.js` merges the Story into the Epic.
- **Epic scope** — reviews the cumulative diff between an Epic branch and
  `main`, before `/deliver` opens the integration pull request.

**Invariant — Story-scope review runs outside the maker's LLM context.**
The Story-scope review executes inside the `story-close.js` /
`single-story-close.js` close subprocess, **not** in the delivering
child's (maker agent's) LLM context. The close pipeline invokes it after
the delivering child has exited, so the change set is reviewed by a
process the maker cannot influence. The enforcing code path is
[`.agents/scripts/lib/orchestration/story-close/phases/code-review.js`](../../scripts/lib/orchestration/story-close/phases/code-review.js)
(invoked from `runStoryCloseLocked`; both close entry points reach it
through the shared `runStoryReviewCore` spine). A future refactor MUST
preserve this isolation: do not move Story-scope review into the maker's
context or run it as a step of the delivering child.

> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

## Argument contract

The caller passes the following arguments (Story workflows pass
`scope: story`; Epic workflows pass `scope: epic`):

| Argument    | Type                                  | Required | Meaning                                                                                          |
| ----------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `scope`     | `"story"` \| `"epic"`                 | yes      | Selects the integration-pillar diff base and the structured-comment target ticket.               |
| `ticketId`  | integer                               | yes      | GitHub issue number of the Story (when `scope === 'story'`) or Epic (when `scope === 'epic'`).   |
| `baseRef`   | string (git ref)                      | yes      | The diff base. Story scope: `epic/<epicId>`. Epic scope: `main` (or `project.baseBranch`).       |
| `headRef`   | string (git ref)                      | yes      | The branch tip under review. Story scope: `story-<storyId>`. Epic scope: `epic/<epicId>`.        |
| `depth`     | `"light"` \| `"standard"` \| `"deep"` | no       | Risk-derived review thoroughness lever. Absent → `standard`. See **Review depth** below.         |

All scope-dependent behavior in this helper branches off the first four
arguments. Do not hard-code branch names or ticket types — read them from
the argument envelope.

### Review depth (`depth`)

`depth` is the risk-derived thoroughness lever introduced by Story #3876 and
made a live consumed signal end to end by Story #3937. The Epic caller
(`/deliver` Phase 5) resolves it from the Epic's judged `planningRisk`
envelope via
[`resolveReviewDepthForEpic`](../../scripts/lib/orchestration/code-review.js)
(`high` → `deep`, `low` → `light`, everything else — including a missing
`epic-plan-state` checkpoint — → `standard`) and passes it in this envelope.
`runCodeReview` forwards `depth` to every provider's `runReview` input.

It is an **input-only** signal: it changes *how thorough* the review is, never
the findings envelope (`{ status, severity, posted, report, halted,
blockerReason }`) nor the posted `verification-results` structured-comment body. An
absent or malformed `depth` is treated as `standard`, so an Epic that skipped
`/plan` still gets a passing review with no new failure mode.

How each tier changes the review protocol:

- **`light`** — single-pass review focused on Pillar 1 (Spec Adherence) over
  the changed surface; Pillars 2–3 (Integration, Documentation Integrity) are
  reduced to a quick scan for obvious breakage rather than exhaustively
  re-walked.
- **`standard`** — the default: all three pillars at today's depth.
- **`deep`** — all three pillars at full depth, **plus** an explicit second
  adversarial pass over the diff hunting for integration regressions and
  security-relevant edges before findings are finalized.

The LLM-backed review providers (codex, security-review, ultrareview) render
the resolved `depth` into the prompt/instructions they emit so the underlying
model actually changes thoroughness. The native provider deliberately ignores
`depth` — its mechanical lint + maintainability sweep already scales with diff
size, and there is no "review harder" knob a deterministic scorer can turn (its
module JSDoc documents this). When you (the host LLM) perform the Step 2 pillar
review yourself, honor the `depth` semantics above directly.

## Step 0 — Resolve Context

1. Resolve `[TICKET_ID]` from `ticketId` (Story or Epic depending on `scope`).
2. Resolve `[BASE_REF]` from `baseRef` and `[HEAD_REF]` from `headRef`.
3. Fetch the `[TICKET_ID]` ticket and resolve the planning context:
   - **Story scope** — read the parent Epic from the Story body, then load
     the Epic body (including its `## User Stories` section and its folded
     Tech Spec sections).
   - **Epic scope** — read the Epic body directly; its managed sections
     carry the Tech Spec.
4. Read the Epic body fully (including its Tech Spec sections) to
   understand the intended
   scope, architectural decisions, and acceptance criteria.

## Step 1 — Automated Audit (Pre-Review)

The caller invokes the in-process code-review pipeline
(`runCodeReview` in `.agents/scripts/lib/orchestration/code-review.js`)
with the resolved `{ scope, ticketId, baseRef, headRef, depth }` envelope
(`depth` defaults to `standard` when the caller omits it). The
pluggable `ReviewProvider` adapter chain (Epic #2815) runs against the
diff `baseRef..headRef`, with the LLM-backed providers honoring `depth`
(see **Review depth** above), and posts a structured summary to `[TICKET_ID]`.
The pipeline will:

- Generate a `git diff baseRef..headRef`.
- Calculate maintainability scores for all new/modified files.
- Run a focused lint check on the change set.
- Post a structured summary report to the `[TICKET_ID]` issue.

### Step 1a — Story-scope local-lens pass (`scope: story` only, Epic #4405)

When `scope === 'story'`, the shared review spine
[`runStoryReviewCore`](../../scripts/lib/orchestration/story-close/phases/code-review.js)
runs a **shift-left local-lens pass** in the same close subprocess, *before*
returning the review envelope. It:

1. Enumerates the actual Story diff (`baseRef...headRef` via
   `git diff --name-only`).
2. Selects the **local-tier** lenses that own a concern decidable from a single
   Story's diff — `resolveLensTier(lens) === 'local'` **plus** the pure
   `matchesAnyFilePattern` matcher against the diff (the audit-suite SDK's
   [`selectLocalLenses`](../../scripts/lib/audit-suite/selector.js)). This is
   deliberately **not** `selectAudits`: `selectAudits` unions in keyword and
   gate matches and has no per-tier gate, so it would widen the roster past the
   footprint-matched local set this tier owns.
3. Materializes the matched roster at **`light`** depth
   (`STORY_SCOPE_LENS_DEPTH`) via `runAuditSuite`, surfacing the outcome on the
   review envelope's `localLensReview` field.

A diff that matches no local lens adds **no** lens work (the roster is empty and
`runAuditSuite` is never invoked). The pass is advisory and best-effort: a git
or materialization failure degrades to a skipped envelope and never blocks the
close.

Both close entry points —
[`runStoryCodeReview`](../../scripts/lib/orchestration/story-close/phases/code-review.js)
(Epic-attached) and
[`runStoryScopeReview`](../../scripts/lib/orchestration/single-story-close/phases/code-review.js)
(standalone) — reach this pass through the single `runStoryReviewCore` spine, so
standalone Stories gain local-lens coverage for the first time. Because the pass
lives inside the close subprocess (invoked after the delivering child exits), it
honors the maker-blind invariant above: a maker never runs its own local-lens
review. This step does not apply to `scope: epic`, whose lens roster is the
cumulative + global + risk-routed set resolved at Epic close (Step 1b).

### Step 1b — Epic-close lens roster (`scope: epic` only, Epic #4405)

When `scope === 'epic'`, the cumulative Epic diff is walked **once** at close:
the Epic-close lens roster is executed as **dimensions of this same review
pass**, not as a separate Phase 4 walk (Story #4412 folded the standalone
epic-audit lens walk into this pass). Resolve and walk the roster inline:

1. Resolve the roster via [`helpers/epic-audit.md`](epic-audit.md) Step 1 —
   run `epic-audit-prepare.js --gate gate3` and take its **`epicCloseLenses`**
   field: the slim roster of cumulative + global + risk-routed lenses, with
   every local-tier change-set lens excluded (routed off `resolveLensTier` in
   [`selectEpicCloseLenses`](../../scripts/lib/orchestration/code-review.js)).
   Local-tier concerns are already verified shift-left (write-time checklists +
   the Story-scope local-lens pass), so they are **not** re-run here.
2. Materialize each rostered lens via
   [`runAuditSuite`](../../scripts/lib/audit-suite/index.js) at the envelope's
   `depth`, applying the `{{changedFiles}}` substitution, and walk each lens's
   `.agents/workflows/audit-<lens>.md` procedure over the cumulative
   `main..epic/<epicId>` diff. Global lenses (`globalLenses`, e.g.
   `audit-navigability`) run against the WHOLE route tree, exempt from the
   change-set narrowing.
3. Fold the lens findings into this pass's severity aggregate **alongside** the
   Step 2 review pillars — one walk of the cumulative diff, one aggregate, one
   `verification-results` comment (Step 4). An empty `epicCloseLenses` roster
   (docs-only, or every selected lens already covered shift-left, and no
   risk-routed lens) adds no lens dimension — the pillars still run.

This step does not apply to `scope: story` (its roster is the local-tier set of
Step 1a) and is skipped when `epic-audit-prepare.js` returns `degraded: true`
(propagate the reason and STOP, per `epic-audit.md`).

## Step 2 — Review Pillars

For each changed file, execute a strict review against four pillars. The
second pillar (**Integration Review**) deliberately defers the security /
performance / quality / coverage sweeps to the change-set-scoped lenses — at
`scope: story` those ran shift-left in the Story-scope local-lens pass (Step
1a); at `scope: epic` they run inline in this same pass as the Epic-close lens
roster (Step 1b). Re-walking those sweeps a second time in this pillar is
duplication, not defense-in-depth.

**Apply the `depth` lever** (see **Review depth** above) to how hard you walk
these pillars: at `light`, focus on Pillar 1 and reduce Pillars 2–3 to a quick
scan for obvious breakage; at `standard`, cover all four at today's depth; at
`deep`, cover all four at full depth and then make a second adversarial pass
over the diff hunting for integration regressions and security-relevant edges
before finalizing findings. Pillar 4 (**Anti-Gaming / Shortcut Detection**)
is walked at **every** depth, including `light` — it targets the class of
correctness failure the deterministic gates structurally cannot see, so it is
never reduced to a scan.

### Pillar 1: Spec Adherence

Does the implementation match the Epic's requirements and Tech Spec architecture?

- Compare each completed Story/Task against its stated acceptance criteria.
- Flag any undocumented deviations, missing features, or scope creep.
- Verify API contracts, data models, and interface boundaries match the Tech
  Spec.

### Pillar 2: Integration Review

The integration view depends on `scope`. The diff under review is always
`baseRef..headRef`, but the **set of upstream audit signals** to integrate
against differs:

- **`scope: story`** — the diff is `epic/<epicId>..story-<storyId>` (i.e.
  one Story's contribution to the Epic). The Story-scope local-lens pass
  (Step 1a) has already covered the local-tier concerns; the Epic-close lens
  roster has not run for this change set (it runs once at Epic close). The
  integration view here focuses on cross-Task ripple within the Story and
  contract drift against the Epic branch tip. Look for:
  - Cross-Task contract drift inside the Story (one Task's API change vs.
    another Task's caller in the same branch).
  - Shared-module ripple effects from this Story onto siblings already
    merged into `epic/<epicId>`.
  - Spec deviations that the per-Task commits papered over.

- **`scope: epic`** — the diff is `main..epic/<epicId>` (the cumulative
  Epic change set). The Epic-close lens roster (`epicCloseLenses`) is walked
  **inline as part of this pass** (Step 1b) — the cumulative diff is read once,
  and the security, privacy, performance, code-quality, and test-coverage
  findings the rostered lenses produce feed this pass's aggregate directly.
  There is no separate `audit-results` comment to read (Story #4412 retired it);
  the lens findings and the pillar findings share the single
  `verification-results` comment this pass posts.

  The integration view at epic scope is what the per-lens audits cannot
  produce because each lens runs in isolation:

  - Cross-reference 🔴 / 🟠 lens findings against the spec deviations
    flagged in Pillar 1 — a finding that traces back to a deliberate
    Tech-Spec decision is different from one that traces back to an
    oversight.
  - Look for cross-cutting concerns no single lens owns: contract drift
    between Stories, shared-module ripple effects, boundary changes that
    thread security and performance implications together.
  - Note any lens finding that the operator's remediation flow should
    bundle (e.g. one refactor closes findings from multiple lenses).

  If the Epic-close roster is empty (docs-only Epic, every selected lens
  already covered shift-left, or the pass was skipped via
  `--skip-epic-audit` / `--skip-code-review`), record that explicitly in the
  findings report and proceed — there is no lens dimension to integrate.

### Pillar 3: Documentation Integrity

Verify documentation stays synchronized with code:

- All new public APIs have JSDoc/TSDoc comments.
- Updated interfaces have updated documentation.
- README and CHANGELOG reflect the changes if applicable.
- Inline comments explain *why*, not *what*.

### Pillar 4: Anti-Gaming / Shortcut Detection

Does the change reach "done" by *fixing the code*, or by *weakening the check
that would have caught it broken?* This is the class of correctness failure the
deterministic `verify[]` commands and the ratchet gates structurally cannot
see: a green suite, a passing lint, and an unchanged maintainability score all
report success whether the code got correct or the test got quieter. Walk the
diff for the shortcut taxonomy below and flag every instance — a plausible-but-
unjustified match is a 🟠 finding, an unambiguous one (test deletion without a
spec decision, a swallowed error on a real failure path) is a 🔴.

- **Relaxed tests** — an assertion loosened to pass rather than the code fixed
  to satisfy it: a tightened matcher swapped for a looser one
  (`toEqual` → `toBeTruthy`, an exact value → `expect.anything()`), a
  narrowed expected value widened, a strict schema check softened, or a
  threshold moved to admit the current (wrong) output.
- **Skipped tests** — a failing test quarantined instead of fixed:
  `it.skip` / `test.skip` / `xit` / `describe.skip`, a `return` early in the
  test body, a `--test-name-pattern` / grep exclusion, an `@skip`/`@ignore`
  tag, or a test commented out wholesale. Deleting a test outright is the
  most severe form — treat unexplained coverage removal as `test-deletion`
  (Step 4.5) and never auto-fix it.
- **Swallowed errors** — a failure path silently absorbed: an empty
  `catch {}`, `catch (e) {}` with no rethrow/log/handle, a bare
  `.catch(() => {})` on a promise, a `try` wrapped solely to suppress a
  throw the caller needs, or an error downgraded to a no-op return so the
  happy path "passes".
- **Stub returns** — a hardcoded value standing in for real logic: a function
  that `return true` / `return []` / `return null` / `return {}` regardless of
  input, a mock left wired into production code, a `TODO`/`FIXME` guarding an
  unimplemented branch that the acceptance criteria required, or a constant
  substituted for a computation the Story asked for.
- **Fake renames** — a change dressed up as a rename that is actually a
  deletion or a behavior change: content dropped under cover of a
  move/rename, a "rename" whose diff quietly alters logic, or a re-export
  shim that orphans the real implementation while the symbol name survives.
- **Comment-deletion-as-fix** — a warning silenced by removing its evidence
  rather than its cause: a failing assertion turned into a comment, a
  `// TODO: this is broken` note deleted while the breakage remains, a
  disabled-code block removed to make a diff look clean, or a lint-suppression
  comment (`biome-ignore`, `eslint-disable`, `@ts-expect-error`) added to mute
  a real diagnostic instead of fixing it.

For every hit, name the file and line, the taxonomy category, and *why the
code — not the check — should have changed*. A finding here is legitimate only
when the diff itself lacks a recorded rationale (a commit-body or Story-comment
note explaining a deliberate, spec-sanctioned relaxation clears it — per the
engineer persona's Implementation Latitude, unlogged reshaping is the
anti-pattern this pillar surfaces).

## Step 3 — Maintainability Ratchet

Verify that no file's maintainability score has decreased below the project
baseline. The unified baselines gate enforces this floor:

```powershell
node .agents/scripts/check-baselines.js --format text
```

If this check fails, you MUST refactor the offending files to meet or exceed the
prior baseline before merging.

## Step 4 — Produce Findings Report

Findings are **persisted as a `verification-results` structured comment on
the `[TICKET_ID]` issue** by `runCodeReview` (the unified findings contract of
Story #4411; at `scope: epic` this single comment also carries the Step 1b
Epic-close lens findings). The target ticket is the Story when
`scope === 'story'` and the Epic when `scope === 'epic'`. The comment
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
  operator can hand verbatim to a fresh sub-agent to remediate this
  single finding. The prompt MUST name the file path,
  the specific change to make, and the acceptance check that proves the
  fix worked. Keep it tight (≤ 5 sentences); the sub-agent will read the
  surrounding code itself.

### The `## Fixed on-branch` section (Story #4399)

Findings that Step 4.5 remediated on `[HEAD_REF]` MUST be rendered under a
dedicated **`## Fixed on-branch`** heading, **not** in the severity groups
above. This is the contract seam that keeps remediated findings from
spawning ghost follow-up issues: the
[audit-results graduator](../../scripts/lib/feedback-loop/audit-results-graduator.js)
(the sole canonical reader of the unified comment)
skips every entry inside this section (both because a fixed entry is
rendered with a **✅ prefix** — so it carries no leading severity emoji the
parser would match — and because the parser has an explicit
Fixed-on-branch section guard).

Render each fixed finding as a `✅`-prefixed line naming its original
severity, the file path in backticks, and the remediating commit SHA, e.g.:

```markdown
## Fixed on-branch

- ✅ 🟡 Medium: `src/lib/foo.js` — missing edge-case guard added (a1b2c3d)
- ✅ 🟠 High: `src/api/users.js` — ownership check added (d4e5f6a)
```

Open (escalated / unfixed) findings stay in their severity group with
their leading severity emoji so the graduator still files them.

## Step 4.5 — Focused-fix Routing (host LLM, no automated loop)

There is **no runtime auto-fix function** at this phase. The host LLM is
the executor: it decides, per finding, between a focused fix on
`[HEAD_REF]` and leaving the finding on the `verification-results`
structured comment for the operator.

### Resolve the remediation threshold (Story #4399)

Read `delivery.codeReview.autoFixSeverity` from the resolved `.agentrc.json`
(default **`medium`**; the resolver in
[`config/runners.js`](../../scripts/lib/config/runners.js) supplies the
default when the key is absent). The threshold governs **which severities
route into on-branch remediation** — it never changes the halting rule (a
surviving 🔴 still stops) or the escalation classes:

- **`medium`** (default) — route 🔴 Critical, 🟠 High, **and 🟡 Medium**
  findings into remediation. 🟢 Suggestions stay on the comment (never
  auto-fixed).
- **`high`** — route only 🔴 Critical and 🟠 High findings, reproducing
  the pre-4399 behavior exactly. 🟡 Medium and 🟢 Suggestion findings stay
  on the comment.

Hard cutover per
[`rules/git-conventions.md`](../../rules/git-conventions.md) § Contract
Cutovers — no back-compat flag; `high` is opt-in to the old routing.

### 🔴 / 🟠 findings — per-finding ceremony (unchanged)

For each 🔴 / 🟠 finding from Step 4, decide between two paths and keep the
`verification-results` structured comment authoritative for anything not fixed
in-place.

1. **Apply a focused fix on `[HEAD_REF]`.** Permitted only when the
   finding is unambiguously *fixable* (clean remediation, no scope
   creep, no spec deviation, no secret exposure):
   - Confirm `git branch --show-current` reports `[HEAD_REF]` before
     touching the working tree; if it does not, STOP and re-checkout.
   - Stage explicit paths only (never `git add .`).
   - Make one focused conventional commit per finding
     (`fix(<scope>): <description> (review finding)`).
   - Re-run a targeted rescan: invoke `runCodeReview` (or the relevant
     diff-scoped subset of pillar checks) on the touched files and
     confirm the finding is gone.
   - Run validation appropriate to the change (`npm run lint` plus the
     relevant `npm test` slice).
   - If the rescan still surfaces the same finding, or validation
     regresses, **stop fixing** — leave the finding on the `code-review`
     structured comment for the operator to triage in Step 5.
2. **Leave the finding on the structured comment for Step 5.** Required
   when the finding falls into any of the following classes:
   - `spec-deviation` — the change diverges from the Epic/Tech Spec.
   - `secrets` — credentials, tokens, or PII surfaced in the diff.
   - `test-deletion` — coverage was removed without an explicit
     decision in the spec.
   - `scope-exceeded` — the remediation would touch more files than
     the review scope warrants.
   - Any finding the host LLM cannot remediate after one focused
     attempt (the equivalent of the prior loop's
     `validation-regression` / `thrash-detected` exits).

### 🟡 Medium findings — batched per-lens ceremony (only when `autoFixSeverity: medium`)

When the threshold is `medium`, remediate the fixable 🟡 Medium findings in
a **batch keyed by owning review lens/pillar** rather than the per-finding
ceremony above:

1. Group the fixable Mediums by owning lens (the pillar or audit family
   that produced them). A Medium is fixable on the same terms as a 🟠; a
   Medium in any escalation class stays on the comment exactly like a 🟠.
2. For each lens, confirm `git branch --show-current` reports
   `[HEAD_REF]`, stage explicit paths only, and make **one focused
   conventional commit per lens** (`fix(<scope>): <description> (review findings batch)`).
3. Bounded-attempt semantics extend to the batch: each finding gets **at
   most one** attempt, and a lens's batch commit that would exceed
   `delivery.codeReview.maxFixScopeFiles` routes that lens's findings to
   escalation (`scope-exceeded`) instead of committing.
4. After **all** lens batches are committed, run a **single** validation
   pass (`npm run lint` plus the relevant `npm test` slice) and a
   **single** targeted rescan over the touched files. Surviving batched
   findings stay on the comment for Step 5.

Record every remediated finding (🟠 or 🟡) in the **"Fixed on-branch"**
section of the `verification-results` comment (Step 4) so it does not graduate
to a follow-up issue.

Do not invent a programmatic retry budget. The host LLM applies *at most
one* focused-fix attempt per finding (or per batched finding) before
escalating to the operator. Escalated findings remain on the `code-review`
structured comment with their reason recorded, so Step 5 (and downstream
consumers) see exactly why each one was not auto-remediated.

## Step 4.6 — Cross-phase re-check trigger

After the focused-fix routing in Step 4.5 completes, any host-LLM-applied
fix commits have modified files on `[HEAD_REF]` that the Epic-close lens
roster already walked (Step 1b). Some of those edits may overlap the
`filePatterns` of one or more lenses (e.g. a fix landing in `**/auth/*.js`
overlaps the `audit-security` lens). When that happens, the lens findings in
the `verification-results` comment are **stale for the overlapping lenses
only** — the non-overlapping findings remain authoritative and MUST NOT be
re-derived.

> **Scope note.** This cross-phase re-check applies only when
> `scope === 'epic'`. Story-scope reviews carry no Epic-close lens roster,
> so there is nothing to invalidate; skip this step entirely for
> `scope === 'story'`.

Invoke the re-check selector with the cumulative set of paths touched by
the focused-fix commits:

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
   [`../audit-*.md`](../) the same way the Step 1b Epic-close walk does —
   one lens at a time, against the current `[HEAD_REF]` tip.
2. **Append** a `## Cross-phase re-check` section to the **existing**
   `verification-results` structured comment on the Epic ticket. Do **not**
   post a new comment; the comment is idempotent and downstream consumers
   (the code-review trim, `/deliver` Pillar 2, the retro helper)
   read it once. The append carries the re-checked lens names, the new
   findings (if any), and the focused-fix commit SHAs that triggered the
   re-run, so reviewers can trace each finding back to the change set
   that produced it.
3. If the re-check surfaces fresh 🔴 / 🟠 findings, route them back
   through Step 4.5's focused-fix routing. Findings that already
   received a focused-fix attempt in the first pass do not get a fresh
   attempt when the cross-phase re-check resurfaces an adjacent one —
   leave them on the `verification-results` comment for the operator.

If `selectedAudits` is empty, skip silently and proceed to Step 5. The
re-check trigger is **read-only signal** — it never mutates the Epic
branch on its own; mutations only happen if the re-invoked lenses
surface findings that the host LLM then converts into commits through
the same focused-fix routing as Step 4.5.

## Step 5 — Remediation

If the operator instructs you to fix any findings:

1. Implement the fixes on the `[HEAD_REF]` branch.
2. Commit each logical fix atomically:

   ```powershell
   # Guard: confirm we're on the correct branch before committing.
   # ([HEAD_REF] mismatch -> STOP and re-checkout before any commit.)
   git branch --show-current

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
- **Always** read the Epic body and Tech Spec before reviewing code. Findings without
  spec context are noise.
- **Never** implement fixes unless the operator explicitly requests it. The
  default mode is read-only audit.
- **Never** mark findings as Critical Blocker unless they represent a genuine
  security risk, data integrity issue, or functional breakage. Overuse of
  Critical severity creates alert fatigue.
- **Always** provide actionable, concrete fix suggestions — not vague advice
  like "consider improving this."
