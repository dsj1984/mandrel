# v6 Clean Code Audit Report

> Audit snapshot date: 2026-05-12
> Story: #1596 (`/audit-clean-code: fix High findings + top-10 Medium + high-CRAP methods`)
> Epic: #1184
> Source: scripted scan of `.agents/scripts/**/*.js`, cross-referenced against
> `baselines/crap.json`, `baselines/maintainability.json`, `baselines/lint.json`.

## Executive Summary

The mandrel orchestration scripts ship with a **medium** maintainability
posture overall. `baselines/lint.json` reports `errorCount=0, warningCount=0`
(clean), and the maintainability index for the bulk of the tree sits in the
80–100 band. The pain is concentrated in:

1. **Three MI=0 outliers** that anchor the bottom of the maintainability
   distribution: `lib/orchestration/epic-cleanup.js`,
   `lib/orchestration/epic-spec-reconciler-ops.js`, and `quality-watch.js`.
   These are likely stub/placeholder modules with no executable bodies, but
   they drag every aggregate the MI gate computes.
2. **43 methods with CRAP > 20** (per `baselines/crap.json`) — the threshold
   the kernel treats as "high-risk uncovered complexity." The single worst
   offender is `classifyGithubError` at CRAP=210, driven by a 6-branch
   classifier whose error-mapping branches are not exercised by tests.
3. **Two oversized scripts**: `providers/github.js` (1560 LoC) and
   `lib/orchestration/epic-runner/progress-reporter.js` (1157 LoC) violate the
   300-line component-bloat guideline by ~4x and ~3.8x respectively. Both
   bundle multiple concerns that read as separate modules.

There are no `High` severity dead-code findings (no orphan exports surfaced by
import-graph spot checks of the largest files). Empty `catch { }` blocks are
absent from the script tree; all observed `catch` blocks either log,
re-throw, or fall through deliberately with a comment.

## Detailed Findings

### CRAP=210 on `classifyGithubError`

- **Dimension:** KISS / Testability
- **Impact:** High
- **Current State:**
  `.agents/scripts/providers/github.js:160` — a six-branch error classifier
  (`feature-disabled`, `transient (status)`, `transient (codes)`,
  `permission (status)`, `permission (message)`, `permanent`) with no direct
  unit test exercising each branch. CRAP = `cc^2 * (1 - cov)^3 + cc`, so the
  210 figure indicates ~0% direct coverage on a cyclomatic of ~14 (counting
  every `||`-branch in `matchesAny` lookups).
- **Recommendation & Rationale:** Extract a pure-data `GITHUB_ERROR_RULES`
  table (`[{match, kind}]`) and reduce `classifyGithubError` to a fold over
  the table. Then add a parametrised test that drives every rule. The fold
  drops cyclomatic to ~3 and the explicit test coverage drives CRAP under 5.
- **Agent Prompt:** `Refactor classifyGithubError in .agents/scripts/providers/github.js to drive classification off a rules table and add a parametrised test in tests/providers/github-classify.test.js that covers every rule.`

### CRAP=148 on `deleteBranchesBatched`

- **Dimension:** Testability
- **Impact:** High
- **Current State:** `.agents/scripts/lib/git-branch-cleanup.js:151` — branches
  on scope, batch result, per-ref fallback, and remote validation. The
  per-ref fallback loop is not directly tested; the batched success path is.
- **Recommendation & Rationale:** Add focused tests for the fallback loop
  using a fake `gitSpawn` that returns non-zero on the batched call and a
  mixed-result per-ref sequence. No structural refactor required — the
  function is already cohesive.
- **Agent Prompt:** `Add tests/lib/git-branch-cleanup-fallback.test.js that injects a fake gitSpawn returning batch-fail then per-ref deleted/failed/not-found and asserts the deleted[] and failed[] partitioning.`

### CRAP=124 on `normalizeReturns`

- **Dimension:** SOLID (SRP) / Testability
- **Impact:** High
- **Current State:**
  `.agents/scripts/epic-execute-record-wave.js:196` — handles
  string/array/object inputs, malformed payloads, partial returns, and
  wave-record envelope shaping in one body.
- **Recommendation & Rationale:** Split into `parseRawReturn(raw)` (pure)
  and `normalizeReturns(rawList)` (loop over parser). Add tests for each
  shape branch (string, JSON-as-string, object-with-task, missing
  task field). CRAP should drop below 10.
- **Agent Prompt:** `Extract parseRawReturn from normalizeReturns in epic-execute-record-wave.js and unit-test each input shape (string, JSON string, object with/without task field).`

### MI=0 on `lib/orchestration/epic-cleanup.js`

- **Dimension:** Dead Code
- **Impact:** High
- **Current State:** Maintainability baseline records `mi=0`, indicating the
  file is either empty or contains only comments/exports with no executable
  code paths. The MI gate floors at 0 when no halstead operators are
  detected.
- **Recommendation & Rationale:** If the module is a placeholder, delete it
  and remove the baseline entry. If it re-exports symbols, inline the
  re-exports at the call site (it cannot be a meaningful aggregation point
  at MI=0). Either action removes a permanent zero from the MI distribution
  and unblocks the MI gate's per-file `miDropRefactor` check.
- **Agent Prompt:** `Inspect .agents/scripts/lib/orchestration/epic-cleanup.js. If empty/placeholder, delete it and remove the baselines/maintainability.json entry plus any imports. If it has callers, replace with direct calls.`

### MI=0 on `lib/orchestration/epic-spec-reconciler-ops.js`

- **Dimension:** Dead Code
- **Impact:** High
- **Current State:** Same shape as the preceding finding — MI=0 in the
  maintainability baseline.
- **Recommendation & Rationale:** Same remediation. Inspect, delete or
  inline, prune the baseline entry.
- **Agent Prompt:** `Inspect .agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js, delete or inline as appropriate, and prune baselines/maintainability.json.`

### MI=0 on `quality-watch.js`

- **Dimension:** Dead Code
- **Impact:** High
- **Current State:** Same shape — MI=0 in the maintainability baseline.
- **Recommendation & Rationale:** Same remediation. If the script is
  retained for CLI surface (`npm run quality:watch`), inline its body so MI
  reports the actual complexity. If it is unused, delete and prune.
- **Agent Prompt:** `Inspect .agents/scripts/quality-watch.js, decide retain-and-rewrite vs delete, and prune baselines/maintainability.json accordingly.`

### `providers/github.js` is 1560 LoC and bundles 6 concerns

- **Dimension:** SOLID (SRP) / Component Health
- **Impact:** Medium
- **Current State:** `.agents/scripts/providers/github.js` mixes:
  error classification, sub-issues GraphQL, ticket mappers, the REST
  client wrapper, retry policy, and exports the public provider facade.
- **Recommendation & Rationale:** Split into
  `providers/github/error-classifier.js`,
  `providers/github/sub-issues-graphql.js` (already a sibling pattern with
  `projects-v2-graphql.js`), and `providers/github/ticket-mapper.js`. The
  faceted modules existed previously (comment markers reference "retired"
  files at lines 184, 222) — restore them as physical files.
- **Agent Prompt:** `Split .agents/scripts/providers/github.js along the inlined-from comments at lines 184 (sub-issues GraphQL), 222 (ticket mappers), and 155 (classifyGithubError) into sibling modules. Keep the public surface stable.`

### `epic-runner/progress-reporter.js` is 1157 LoC

- **Dimension:** SOLID (SRP) / Component Health
- **Impact:** Medium
- **Current State:**
  `.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js` — a
  single module owning phase-to-state translation
  (`phaseToState`, CRAP=42), wave-aggregator state writer, and the
  markdown body renderer.
- **Recommendation & Rationale:** Extract `phase-to-state.js` (pure
  mapping) and `progress-body-renderer.js` (markdown). The remaining file
  becomes the wave aggregator entry point.
- **Agent Prompt:** `Extract phaseToState and the markdown renderer from progress-reporter.js into sibling modules. Update tests to import from the new paths.`

### CRAP=75 on `generateAndSaveManifest`

- **Dimension:** Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/dispatcher.js:107` — orchestrates
  manifest derivation, disk persistence, and dependency-guard reporting in
  one body.
- **Recommendation & Rationale:** Extract `deriveManifest(state)` (pure)
  and `saveManifest(manifest, opts)` (I/O). Test the pure half exhaustively.
- **Agent Prompt:** `Split generateAndSaveManifest in dispatcher.js into pure derivation + I/O persistence halves and add unit tests for the pure half.`

### CRAP=53 on `lint-baseline.js#checkBaseline`

- **Dimension:** Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/lint-baseline.js:294` — checks current
  lint counts against baseline, applies the ratchet, and prints diff
  output in one body.
- **Recommendation & Rationale:** Split into `compareCounts(curr, base)`
  (pure) and `formatBaselineDiff(diff)` (rendering). Test compareCounts
  with synthetic counts.
- **Agent Prompt:** `Extract compareCounts and formatBaselineDiff from checkBaseline in lint-baseline.js and unit-test the pure comparator.`

### CRAP=46 on `story-close.js#runStoryCloseLocked`

- **Dimension:** SOLID (SRP) / Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/story-close.js:247` — wraps the merge
  runner under a lock and threads validation, push, and cascade results
  through. The body is long enough that the lock-acquired branch and the
  lock-busy branch are interleaved with merge logic.
- **Recommendation & Rationale:** Separate `acquireAndRun(lockKey, fn)`
  (already exists conceptually in `withEpicMergeLock`) from the merge
  body. Test the lock-busy branch independently with an injected lock.
- **Agent Prompt:** `Refactor runStoryCloseLocked to delegate locking entirely to withEpicMergeLock and test the lock-busy short-circuit with a fake lock acquirer.`

### CRAP=42 on `assert-branch.js#parseArgs`

- **Dimension:** Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/assert-branch.js:51` — accepts
  multiple aliases per flag with custom validation; no parametrised tests
  cover the alias matrix.
- **Recommendation & Rationale:** Replace ad-hoc parsing with the existing
  `lib/cli-args.js` `defineFlags` infrastructure (also a high-CRAP target
  — see below — but already shared across the suite). Test every alias
  with one parametrised case.
- **Agent Prompt:** `Replace parseArgs in assert-branch.js with a defineFlags-based wrapper and add a parametrised test covering every alias.`

### CRAP=42 on `epic-runner/progress-reporter.js#phaseToState`

- **Dimension:** KISS / Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js:89`
  — switch-like translation from phase strings to ticket states with
  fall-through behaviour that is not unit tested.
- **Recommendation & Rationale:** Move to a `PHASE_STATE_MAP` constant and
  reduce the function to a lookup. Cover every key with one
  table-driven test.
- **Agent Prompt:** `Replace phaseToState's switch with a PHASE_STATE_MAP lookup and add a single table-driven test covering every key.`

### CRAP=41 on `branch-initializer.js#bootstrapWorktree`

- **Dimension:** SOLID (SRP) / Testability
- **Impact:** Medium
- **Current State:**
  `.agents/scripts/lib/story-init/branch-initializer.js:214` — copies
  `.env`/`.mcp.json` into a worktree, falls back on missing source files,
  swallows EACCES, and emits a structured log entry. Five branches with
  thin coverage.
- **Recommendation & Rationale:** Split copy-per-file from the outer loop;
  test the inner copy with a fake `fs` for missing/EACCES/success.
- **Agent Prompt:** `Extract bootstrapWorktreeCopyOne from bootstrapWorktree and test missing/EACCES/success with a fake fs.`

### CRAP=40 on `check-maintainability.js#main`

- **Dimension:** SOLID (SRP)
- **Impact:** Medium
- **Current State:** `.agents/scripts/check-maintainability.js:340` — the
  CLI entry point owns argv parsing, baseline diffing, drop detection,
  and JSON/text output. Each concern is a candidate sub-function.
- **Recommendation & Rationale:** Split into `runCheck(opts)` (pure) and
  the CLI shell. Test runCheck across the three drop scenarios.
- **Agent Prompt:** `Extract runCheck from main in check-maintainability.js and unit-test no-drop, soft-drop, and refactor-required drop scenarios.`

### CRAP=36 on `epic-execute-record-wave.js#resolveRecordInput`

- **Dimension:** Testability
- **Impact:** Medium
- **Current State:** `.agents/scripts/epic-execute-record-wave.js:690` —
  resolves the wave-record payload from a mix of stdin, argv, and disk.
- **Recommendation & Rationale:** Pure-extract the input-shape resolution
  and unit-test each input vector with synthetic streams/argv.
- **Agent Prompt:** `Extract resolveRecordInputPure from resolveRecordInput and test stdin/argv/disk-only/all-three combinations.`

### CRAP=34 on `pending-cleanup.js#retryStage1ForEntry`

- **Dimension:** Testability
- **Impact:** Medium
- **Current State:**
  `.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js:108` — branches
  on stage transitions, retry budgets, and last-attempt timestamps.
- **Recommendation & Rationale:** Add parametrised tests across the
  stage/retry matrix; no structural change needed.
- **Agent Prompt:** `Add tests/lib/worktree/lifecycle/pending-cleanup-retry.test.js that exercises every stage/retry combination of retryStage1ForEntry.`

### CRAP=31 on `lib/cli-args.js#defineFlags`

- **Dimension:** SOLID (SRP)
- **Impact:** Medium
- **Current State:** `.agents/scripts/lib/cli-args.js:145` — defines the
  flag declaration DSL plus the parser plus the help renderer.
- **Recommendation & Rationale:** Split parser from renderer and
  declaration validator. This is the shared cli-arg layer; reducing its
  CRAP also reduces blast radius across every script that uses it.
- **Agent Prompt:** `Split defineFlags into validateFlagSpec, parseFlags, and renderHelp; preserve the public re-export.`

## Dead Code Inventory

| File | Symbol / Block | Type | Estimated LOC |
| --- | --- | --- | --- |
| .agents/scripts/lib/orchestration/epic-cleanup.js | entire module | Orphaned file (MI=0) | ~unknown (placeholder) |
| .agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js | entire module | Orphaned file (MI=0) | ~unknown (placeholder) |
| .agents/scripts/quality-watch.js | entire module | Orphaned file (MI=0) | ~unknown (placeholder) |
| .agents/scripts/providers/github.js | lines 184-220 (inlined GraphQL) | Retired sibling module — restore as separate file | ~37 |
| .agents/scripts/providers/github.js | lines 222-310 (inlined mappers) | Retired sibling module — restore as separate file | ~90 |

No empty-`catch` blocks were found in `.agents/scripts/**` after grepping
`catch\s*\{` and inspecting matches; every match either logged or had an
explicit fall-through comment.

## Technical Debt Backlog

The following files concentrate the bulk of remediation surface and should
be prioritised as a group rather than per-method:

1. **`.agents/scripts/providers/github.js`** — 1560 LoC, 2 CRAP > 20
   methods (210, 28), one Medium SRP finding. Owner of the GitHub
   provider facade; refactor lands the largest MI delta and unblocks
   targeted testing of `classifyGithubError`.
2. **`.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js`**
   — 1157 LoC, 1 CRAP > 20 (`phaseToState`, 42), MI=68 (already on the
   low-MI watch list). Splitting renderer + mapper has the second-best
   maintainability return on investment.
3. **`.agents/scripts/epic-execute-record-wave.js`** — 799 LoC, 3 CRAP > 20
   methods including the 124-CRAP `normalizeReturns`. Touches the wave
   aggregator's input boundary, so pure extraction directly improves
   `/epic-deliver` debuggability.
4. **`.agents/scripts/lib/worktree/lifecycle/reap.js`** — 612 LoC, 3 CRAP > 20
   methods (`removeWorktreeWithRecovery`, `reap`, `deleteBranchAfterReap`).
   Already on the low-MI list (75.31). Reap-correctness is a load-bearing
   concern for every story close on Windows.
5. **`.agents/scripts/lib/orchestration/story-close/merge-runner.js`** —
   3 CRAP > 20 methods (`runFinalizeMerge`, `rebaseStoryOnEpic`,
   `finalizeMergeIfPending`). The merge runner is the single biggest
   source of story-close friction in the field; splitting it improves
   recovery-path coverage.

## Scope for Story #1596

Story #1596 commits its sibling Task (`#1614`) to:

- fix every **High** finding (6 items above),
- fix the **top-10 Medium** findings (the next 10 in CRAP-sorted order),
- fix every **CRAP > 20** method (43 items in `baselines/crap.json`).

The Medium findings beyond the top-10 and the Technical Debt Backlog
remain visible for follow-up Stories.
