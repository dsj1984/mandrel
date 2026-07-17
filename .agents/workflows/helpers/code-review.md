---
description: >-
  Perform a comprehensive code review of a Story change set against main
  before `/deliver` opens or merges the Story PR
---

# Code Review (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/deliver` via `single-story-close.js`. To run a review directly, invoke
> the parent workflow — operators do not call this helper by hand.

This helper performs a comprehensive code review of a change set before it
is merged to `main`. The live v2 path is **Story scope only**:

- **Story scope** — reviews `main...story-<storyId>` (or
  `project.baseBranch...story-<storyId>`) inside `single-story-close.js`
  after the PR opens and before auto-merge. Findings post to the PR;
  critical findings block close (`agent::blocked`).

Legacy `scope: epic` / Epic-branch review procedure (including
`epic-audit-prepare.js` / `epic-audit-recheck.js`) was removed with the
v2 Story-only cutover.

**Invariant — Story-scope review runs outside the maker's LLM context.**
The Story-scope review executes inside the `single-story-close.js` close
subprocess, **not** in the delivering child's (maker agent's) LLM context.
The close pipeline invokes it after the delivering child has exited, so
the change set is reviewed by a process the maker cannot influence. The
enforcing code path is
[`runStoryScopeReview`](../../scripts/lib/orchestration/single-story-close/phases/code-review.js)
→ shared
[`runStoryReviewCore`](../../scripts/lib/orchestration/story-close/phases/review-core.js).
A future refactor MUST preserve this isolation: do not move Story-scope
review into the maker's context or run it as a step of the delivering
child.

> **Persona**: `architect` · **Skills**: `core/code-review-and-quality`,
> `core/security-and-hardening`

## Argument contract

The caller passes the following arguments (`/deliver` passes
`scope: story`):

| Argument    | Type                                  | Required | Meaning                                                                                          |
| ----------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `scope`     | `"story"` \| `"epic"`                 | yes      | Live path is `"story"`. `"epic"` remains only for legacy cumulative adapters.                    |
| `ticketId`  | integer                               | yes      | GitHub issue number of the Story (when `scope === 'story'`) or cumulative ticket (legacy `scope === 'epic'`). |
| `baseRef`   | string (git ref)                      | yes      | The diff base. Story scope: `main` (or `project.baseBranch`). Legacy cumulative scope: caller-provided base. |
| `headRef`   | string (git ref)                      | yes      | The branch tip under review. Story scope: `story-<storyId>`. Legacy cumulative scope: caller-provided head. |
| `depth`     | `"light"` \| `"standard"` \| `"deep"` | no       | Risk-derived review thoroughness lever. Absent → `standard`. See **Review depth** below.         |

All scope-dependent behavior in this helper branches off the first four
arguments. Do not hard-code branch names or ticket types — read them from
the argument envelope.

### Review depth (`depth`)

`depth` is the thoroughness lever introduced by Story #3876, made a live
consumed signal end to end by Story #3937, and re-based on an observable signal
by Story #4542. `runCodeReview` derives it from the diff it already enumerates,
via [`review-depth.js`](../../scripts/lib/orchestration/review-depth.js): the
changed files' intersection with the `sensitivePaths` classes registered in
`audit-rules.json` gives the level, their count gives the width, and
`resolveDepth` folds the two (a sensitive path OR a wide diff → `deep`; neither,
on a small diff → `light`; an unenumerable diff → `standard`). It takes no
planner-authored input and reads no checkpoint. `runCodeReview` forwards `depth`
to every provider's `runReview` input.

It is an **input-only** signal: it changes *how thorough* the review is, never
the findings envelope (`{ status, severity, posted, report, halted,
blockerReason }`) nor the posted `verification-results` structured-comment body. An
absent or malformed `depth` is treated as `standard`, so a Story that skipped
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

1. Resolve `[TICKET_ID]` from `ticketId` (the Story for live `scope: story`).
2. Resolve `[BASE_REF]` from `baseRef` and `[HEAD_REF]` from `headRef`.
3. Fetch the Story ticket and resolve the planning context from its own
   body: folded `## Spec` / `## Slicing`, acceptance criteria, and the
   `story-plan-state` structured comment when present.
4. Read that Spec fully to understand the intended scope, architectural
   decisions, and acceptance criteria. Do **not** look for a parent Epic.

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
[`runStoryReviewCore`](../../scripts/lib/orchestration/story-close/phases/review-core.js)
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

The live close entry point —
[`runStoryScopeReview`](../../scripts/lib/orchestration/single-story-close/phases/code-review.js)
— reaches this pass through the shared `runStoryReviewCore` spine. Because
the pass lives inside the close subprocess (invoked after the delivering
child exits), it honors the maker-blind invariant above: a maker never runs
its own local-lens review.

## Step 2 — Review Pillars

For each changed file, execute a strict review against four pillars. The
second pillar (**Integration Review**) deliberately defers the security /
performance / quality / coverage sweeps to the change-set-scoped lenses —
those ran shift-left in the Story-scope local-lens pass (Step 1a).
Re-walking those sweeps a second time in this pillar is duplication, not
defense-in-depth.

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

Does the implementation match the Story's acceptance criteria and folded Spec?

- Compare the completed Story against its stated acceptance criteria.
- Flag any undocumented deviations, missing features, or scope creep.
- Verify API contracts, data models, and interface boundaries match the Spec.

### Pillar 2: Integration Review

The diff under review is `baseRef..headRef`
(`main..story-<storyId>`, or the configured base branch to the Story
branch). The Story-scope local-lens pass (Step 1a) has already covered the
local-tier concerns. Lens findings and pillar findings share the single
`verification-results` comment this pass posts (Story #4411). The
integration view here focuses on cross-cutting ripple within the Story and
contract drift against the base branch. Look for:

- Contract drift inside the Story (one change's API edit vs. another caller
  in the same branch).
- Shared-module ripple effects from this Story onto code already merged to
  `main`.
- Spec deviations that individual commits papered over.

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
Story #4411; this single comment carries the
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
   - `spec-deviation` — the change diverges from the Story `## Spec`.
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
- **Always** read the Story body and folded Spec before reviewing code. Findings without
  spec context are noise.
- **Never** implement fixes unless the operator explicitly requests it. The
  default mode is read-only audit.
- **Never** mark findings as Critical Blocker unless they represent a genuine
  security risk, data integrity issue, or functional breakage. Overuse of
  Critical severity creates alert fatigue.
- **Always** provide actionable, concrete fix suggestions — not vague advice
  like "consider improving this."
