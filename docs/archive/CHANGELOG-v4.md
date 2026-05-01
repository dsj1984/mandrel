# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.7.2] - 2026-04-05

### Added

- **Main-First Sprint Planning**: Restructured the `/plan-sprint` workflow to
  generate and commit planning artifacts (PRD, Tech Spec, Playbook) to the base
  branch (`main`) _before_ the sprint branch is created. This ensures the sprint
  branch inherits a fully-audited, committed set of planning documents.
- **Clean-Slate Planning**: Added a strict "Purge Prior Artifacts" step to the
  planning workflow that deletes any existing sprint documents for the target
  sprint number before generation. This prevents prior context or failed
  planning runs from influencing new artifact generation.

### Changed

- **Robust Directory Setup**: Updated `sprint-setup.md` to use `mkdir -p` when
  initializing sprint directories, ensuring compatibility with the new
  "Main-First" planning flow where directories are created during the document
  generation phase.

## [4.7.1] - 2026-04-05

### Fixed

- **Critical: Command Injection via Shell Interpolation
  (`sprint-integrate.js`)**: Replaced the single `spawnSync` call that chained
  lint, typecheck, and test commands via `;` separators with `shell: true` —
  which was both a command-injection vector and a fragile cross-platform pattern
  — with three sequential, shell-free `spawnSync` calls routed through
  `diagnose-friction.js`. Each verification step now has granular error
  reporting, per-step timing, and early-exit on first failure.
- **Critical: Dirty-State Cleanup (`sprint-integrate.js`)**: `cleanup()` now
  calls `git merge --abort` before attempting checkout, preventing the repo from
  being left in a broken merge state when cleanup is invoked during an active
  conflict resolution.
- **CLI Argument Parsing (`sprint-integrate.js`)**: `--sprint` and `--task` now
  validate that the following argument exists and is not another flag,
  preventing out-of-bounds access and silent misassignment (e.g.,
  `--sprint --task` no longer assigns `"--task"` as the sprint number).
- **Feature Branch Existence Check (`sprint-integrate.js`)**: Added
  `git rev-parse --verify` before the merge attempt. Previously, a nonexistent
  feature branch (typo, deleted) would fall through to the conflict analysis
  path and produce cryptic, misleading errors.
- **Consolidation Checkout Guard (`sprint-integrate.js`)**: The `git checkout`
  before the final consolidation merge now checks its return code and exits
  cleanly instead of silently merging into the wrong branch.
- **Binary-Safe Conflict Analysis (`sprint-integrate.js`)**: Replaced manual
  `fs.readFileSync` + regex conflict marker counting with `git diff --check`,
  which is binary-safe and avoids loading large files into memory.
- **Auto-Resolution Audit Trail (`sprint-integrate.js`)**: Minor conflict
  auto-resolution now logs the discarded sprint-base content via `VerboseLogger`
  before accepting `--theirs`, making silent data loss auditable.
- **Path Anchoring (`sprint-integrate.js`)**: The `--sprint` path passed to
  `diagnose-friction.js` is now anchored to `PROJECT_ROOT`, fixing a CWD
  mismatch where friction logs could be written to the wrong directory.

### Changed

- **Dead Code Removal (`sprint-integrate.js`)**: Removed unused `execFileSync`
  import and the no-op `maxBuffer` option (which has no effect with
  `stdio: 'inherit'`).

## [4.7.0] - 2026-04-05

### Changed

- **Code-review pass on v4.6.1 remediations** — post-merge review against all 10
  `audit-clean-code-results` findings. Three follow-up issues were surfaced and
  closed:
  1. **`verify-prereqs.js` — corrupted import line (Finding #8, final close)**:
     The previous edit left a CRLF-mangled line that concatenated two import
     statements on a single line
     (`import { resolveConfig } … \rimport { Logger }…`). Also removed trailing
     empty statements that followed `Logger.fatal()` calls (dead code after a
     non-returning call). File is now fully LF-normalised with clean, separate
     imports.

  2. **`aggregate-telemetry.js` — hardcoded paths and padding (Finding #10)**:
     `process.cwd()` replaced with the canonical `PROJECT_ROOT` from
     `config-resolver.js`. `'docs', 'sprints'` path segments replaced with
     `agentConfig.sprintDocsRoot`. `padStart(3, '0')` replaced with
     `agentConfig.sprintNumberPadding`. An `AGENT_PROJECT_ROOT` environment
     variable override is exposed so integration tests can point the script at a
     fixture directory without altering the real project root.

  3. **`generate-playbook.js` — dead imports after delegation refactor**:
     `buildGraph`, `assignLayers`, `transitiveReduction`,
     `computeChatDependencies` (all now internal to `PlaybookOrchestrator`) and
     `analyzeAndSplit`, `loadComplexityConfig` (delegated to
     `ComplexityEstimator` inside the orchestrator) were still imported at the
     top of the CLI entry point but never referenced. Removed.

- **`audit-clean-code-results.md` deleted** — all findings closed; the report is
  superseded by this changelog entry.

### Added

- **Verbose Interaction Logging**: Introduced an opt-in `verboseLogging`
  configuration in `.agentrc.json` that records all agentic interactions and
  responses as structured JSONL files for post-hoc analysis (model evaluation,
  cost attribution, prompt engineering, debugging).
  - New `VerboseLogger` class (`.agents/scripts/lib/VerboseLogger.js`) with
    singleton factory, graceful no-op degradation when disabled, and per-sprint
    JSONL file output.
  - Configuration: `agentSettings.verboseLogging.enabled` (default: `false`) and
    `agentSettings.verboseLogging.logDir` (default: `temp/verbose-logs`).
  - Integrated into `AgentLoopRunner.js` (action dispatches, observations,
    errors), `sprint-integrate.js` (merge, conflict, verify, consolidate
    phases), and `run-agent-loop.js` (CLI entry point initialization).
  - Updated `config-resolver.js` with zero-config defaults and schema boundary
    validation for `verboseLogging.logDir`.
  - Updated `instructions.md` §1.H with documentation for the verbose logging
    feature.

## [4.6.1] - 2026-04-05

### Changed

- **Refactored — `generate-playbook.js` god function**: `generateFromManifest()`
  is now a thin 8-line wrapper that delegates entirely to
  `PlaybookOrchestrator.run()`. The 143-line duplicated pipeline body has been
  removed. Tests continue to exercise the production code path through this
  delegation.

- **Canonical auto-serialization in `Graph.js`**: Extracted the focusArea
  overlap detection algorithm into a new exported function
  `autoSerializeOverlaps(manifest, adjacency)`. Both `generateFromManifest` and
  `PlaybookOrchestrator.build()` now delegate to this single optimized
  implementation (bulk-accumulate pattern, single graph rebuild). The previous
  O(N⁵) loop inside `generateFromManifest` has been eliminated.

- **Centralized bookend detection via `task-utils.js`**: Created a new module
  `.agents/scripts/lib/task-utils.js` exporting `isBookendTask(task)`. Replaced
  7+ verbatim instances of the compound boolean
  `task.isIntegration || task.isQA || task.isCodeReview || task.isRetro || task.isCloseSprint`
  across `generate-playbook.js`, `PlaybookOrchestrator.js`, `Renderer.js`, and
  `ComplexityEstimator.js`.

- **Extended `config-resolver.js`**: `resolveConfig()` now returns a `raw` field
  containing the full parsed `.agentrc.json` object (not just `agentSettings`).
  Exported `PROJECT_ROOT` as a shared constant. Error handling now distinguishes
  `ENOENT` (safe fallback to defaults) from JSON parse failures (now thrown
  immediately as fatal errors, not silently swallowed).

- **Eliminated redundant file I/O in `loadValidModelNames`**: Now uses
  `resolveConfig().raw.models.categories` — removing the second
  `fs.readFileSync` that re-parsed `.agentrc.json` on every call.

- **`CacheManager.js` proxy replaced**: Removed the hand-rolled proxy object
  with manual method forwarders. `instance` is now a clean `re-export` of
  `getInstance`, callable as `instance()`. Updated all consumer call sites in
  `generate-playbook.js`.

- **`ComplexityEstimator.js` error hardening**: `loadComplexityConfig()` now
  only silences `ENOENT` errors; all other errors (JSON parse failures,
  permission errors) are re-thrown. Replaced inline bookend boolean with
  `isBookendTask()`.

- **`Renderer.js` decomposed**: `renderPlaybook()` has been split into two
  independently testable sub-functions exported from the module:
  - `renderHeader(manifest, options)` — title block + blockquote metadata +
    sprint summary section.
  - `renderTaskBlock(task, session, taskIdToNumber, chatDeps, taskIndex, options)`
    — full per-task block including metadata, agent prompt fence, branching,
    close-out, and optional manual-fix block. Replaced all inline bookend
    booleans with `isBookendTask()`.

### Added

- **`lib/task-utils.js`**: New shared module with `isBookendTask(task)`
  predicate.
- **`tests/lib/task-utils.test.js`**: 10 unit tests covering all bookend flag
  variants, multi-flag scenarios, and truthy/falsy coercion.
- **`tests/lib/config-resolver.test.js`**: 5 tests verifying `PROJECT_ROOT` is
  absolute, caching is consistent, `raw` is populated, and malformed JSON
  throws.
- **`tests/lib/renderer.test.js`**: 16 unit tests for the extracted
  `renderHeader()` and `renderTaskBlock()` sub-functions, covering all rendering
  branches in isolation.

### Fixed

- **Lint**: Fixed three `markdownlint` violations in
  `audit-clean-code-results.md` (MD036 emphasis-as-heading, MD031 fence blank
  lines).

## [4.6.0] - 2026-04-04

### Added

- **Lint Baseline Ratcheting Mechanism**: Integrated a
  `.agents/scripts/lint-baseline.js` checker into the sprint workflows to
  prevent pre-existing ESLint warnings from blocking sprint integrations.
  - `sprint-setup.md` captures an initial baseline (`capture` mode).
  - `sprint-finalize-task.md` and `sprint-integrate.js` verification phases run
    against the baseline (`check` mode).
  - The script enforces zero-deterioration: integrations fail if new warnings
    are introduced, and dynamically ratchets the baseline down when the codebase
    health improves.
  - Added new configuration keys `lintBaselineCommand` and `lintBaselinePath` to
    `.agentrc.json`.
- **Ephemeral State Cleanup Protocol**: Updated the `sprint-close-out.md`
  workflow to strictly enforce the purging of local temporary state at the end
  of the sprint lifecycle.
  - Added localized removal steps for `temp/workspaces` and `temp/task-state` to
    prevent project bloat and ensure isolation between sequential sprints.
  - Hardened Step 0 of the close-out workflow with explicit path resolution for
    `WORKSPACES_ROOT` and `TASK_STATE_ROOT`.

## [4.5.0] - 2026-04-04

### Added

- **Two-Tier Skill Library Architecture**: Restructured `.agents/skills/` into a
  `core/` + `stack/` two-tier system to separate universal process protocols
  from tech-stack-specific knowledge:
  - **`core/`** (20 skills): Universal, process-driven skills adopted from the
    `potential-skills` library. Covers the full SDLC:
    `api-and-interface-design`, `browser-testing-with-devtools`,
    `ci-cd-and-automation`, `code-review-and-quality`, `code-simplification`,
    `context-engineering`, `debugging-and-error-recovery`,
    `deprecation-and-migration`, `documentation-and-adrs`,
    `frontend-ui-engineering`, `git-workflow-and-versioning`, `idea-refinement`,
    `incremental-implementation`, `performance-optimization`,
    `planning-and-task-breakdown`, `security-and-hardening`,
    `shipping-and-launch`, `spec-driven-development`, `test-driven-development`,
    and `using-agent-skills`.
  - **`stack/`** (14 skills): Tech-stack-specific skills retained from the
    previous library and reorganized under `stack/architecture/`,
    `stack/backend/`, `stack/frontend/`, `stack/qa/`, and `stack/security/`.
- **Anti-Laziness Coding Rules**: Merged the `autonomous-coding-standards` skill
  rules directly into `instructions.md` §5 Quality Standards, making them
  universal system-level constraints rather than an opt-in skill.

### Changed

- **Skill Activation Protocol (§1.B)**: Updated `instructions.md` to document
  the two-tier skill system with path conventions and selection guidance.
- **`using-agent-skills` Meta-Skill**: Updated skill discovery tree to reference
  renamed `idea-refinement` skill.
- **Playbook Bookend Task Skills**: Updated `sprint-generate-playbook.md`
  bookend recommendations to reference new `core/` and `stack/` paths.
- **`architect.md` Protocol Evolution**: Updated skill path references to
  `core/` and `stack/` tiers.
- **`engineer-web.md`**: Updated `stack/frontend/` skill path reference.

### Removed

- **Superseded Process Skills** (deleted, now covered by `core/`):
  - `architecture/autonomous-coding-standards` → merged into `instructions.md`
  - `architecture/markdown` → superseded by `core/documentation-and-adrs`
  - `conventional-commits-enforcer` → superseded by
    `core/git-workflow-and-versioning`
  - `devops/git-flow-specialist` → superseded by
    `core/git-workflow-and-versioning`
  - `qa/resilient-qa-automation` → superseded by `core/test-driven-development`
  - `security/zero-trust-security-engineer` → superseded by
    `core/security-and-hardening`
- **Root-Level Duplicate Skills** (11 deleted, canonical versions retained in
  `stack/`): `astro-react-island-strategist`, `cloudflare-hono-architect`,
  `cloudflare-queue-manager`, `expo-react-native-developer`,
  `monorepo-path-strategist`, `resilient-qa-automation`,
  `secure-telemetry-logger`, `sqlite-drizzle-expert`, `stripe-billing-expert`,
  `ui-accessibility-engineer`, `zero-trust-security-engineer`.
- **`idea-refine` Skill**: Renamed to `idea-refinement` for grammatical
  consistency with the rest of the skill library.

## [4.4.0] - 2026-04-04

### Added

- **DFS-Based Graph Algorithms (`Graph.js`)**: Replaced the O(N³) Floyd-Warshall
  implementations in `computeReachability` and `transitiveReduction` with
  O(V·(V+E)) DFS-based algorithms.
- **Bulk-Accumulate DAG Serialization (`PlaybookOrchestrator.js`)**: Eliminated
  the O(N⁵) thrashing in the auto-serialization loop via `Set` intersections and
  bulk edge application.
- **Async Command Dispatch (`AgentLoopRunner.js`)**: Migrated
  `ExecuteSafeCommand` to `util.promisify(exec)` to maintain event-loop
  responsiveness.
- **Complexity Estimator Optimization**: Removed redundant O(N) `manifest.find`
  lookups in the splitting logic.
- **Improved E2E Test Reliability**: Updated `run-agent-loop-e2e.test.js` with
  async/await and task flushing to support new non-blocking dispatch patterns.
- **Cross-Artifact Version Lineage**: Implemented systemic protocol version
  tracking to ensure deterministic consistency across the planning pipeline.
  - Added `protocolVersion` to `task-manifest.schema.json`.
  - Added `Protocol Version` fields to `prd-template.md`,
    `technical-spec-template.md`, and `sprint-playbook-template.md`.
  - Updated `PlaybookOrchestrator.js` to automatically verify that the
    manifest's version matches the system's current version in
    `.agents/VERSION`, emitting a warning on mismatch.
- **Mandatory Alignment Audit**: Integrated a protocol version verification step
  into the `plan-sprint.md` master workflow, requiring agents to explicitly
  confirm version consistency across all planning artifacts (PRD, Tech Spec,
  Manifest, Playbook).

### Changed

- **Workflow Governance**: Updated `sprint-generate-prd.md`,
  `sprint-generate-tech-spec.md`, and `sprint-generate-playbook.md` to mandate
  the injection of the current protocol version from `.agents/VERSION` into all
  generated artifacts.
- **Parallelism Guardrails**: Hardened the `sprint-generate-playbook.md`
  workflow with explicit "Diamond Fan-out" pattern guidance and a list of
  dependency anti-patterns (Linear Chain Bias, Shared Focus Serialization) to
  prevent unnecessary task serialization.

## [4.3.0] - 2026-04-04

### Fixed

- **Critical: Agent Hang Prevention in Integration Pipeline**: Added
  configurable `timeout` and `maxBuffer` to the `spawnSync` call in
  `sprint-integrate.js` (verification suite) and `diagnose-friction.js` (inner
  command wrapper). Both now respect `executionTimeoutMs` and
  `executionMaxBuffer` from `.agentrc.json`, eliminating the primary cause of
  indefinite agent stalls during `lint`/`typecheck` runs.
- **Critical: Cascading Pipeline Stall in `hydrate-cache.js`**: Added timeout to
  the `execFileSync` subprocess call that invokes `update-task-state.js`,
  preventing cascading stalls in the APC hydration pipeline.
- **Non-Blocking APC Extraction**: Converted the synchronous `execFileSync` call
  to `extract-intent.js` in `update-task-state.js` to an async fire-and-forget
  `spawn` (detached, unref'd). APC intent extraction is a best-effort
  optimization that no longer blocks the critical path of task state updates.

### Changed

- **Config Resolver Caching**: `resolveConfig()` now caches results at module
  level, eliminating 3-4 redundant file reads and JSON parses per execution run.
  A `bustCache` option is available for scripts that need to force re-read.
- **Lazy CacheManager Singleton**: The `CacheManager` singleton is now
  instantiated lazily on first access instead of eagerly at import time,
  avoiding unnecessary I/O for scripts that never use the cache.
- **Optimized Directory Walk**: `context-indexer.js` now uses
  `fs.readdirSync(dir, { withFileTypes: true })` instead of separate
  `fs.statSync()` calls per entry, halving syscall count during index builds.
- **Pre-compiled Regex Patterns**: Icon selection regex patterns in
  `generate-playbook.js` are now compiled once at module level instead of on
  every `selectIcon()` invocation.
- **Pre-computed Sort Keys**: `harvest-golden-path.js` now pre-computes `mtime`
  values into a Map before sorting, eliminating redundant `statSync` calls
  inside the sort comparator.
- **Model Name Loader**: `loadValidModelNames()` now includes explanatory
  comments about OS-level filesystem caching for its config file read.

## [4.2.0] - 2026-04-04

### Added

- **Complexity-Aware Task Decomposition**: Introduced a new
  `ComplexityEstimator` module (`.agents/scripts/lib/ComplexityEstimator.js`)
  that scores task complexity based on instruction length, estimated file count,
  scope breadth, focus area count, cross-package language indicators, and
  bullet-point density. Tasks exceeding the configurable `maxComplexityScore`
  threshold (default: 8) are automatically split into sequentially-chained
  sub-tasks when explicit `substeps` are provided in the manifest, or flagged
  with an inline `⚠️ COMPLEXITY WARNING` to instruct agents to self-decompose.
- **Manifest Schema Extensions**: Added two optional properties to the task
  manifest schema (`task-manifest.schema.json`):
  - `estimatedFiles` (integer): Approximate file count hint for the complexity
    estimator.
  - `substeps` (array): Pre-decomposed sub-steps enabling automatic task
    splitting with correct dependency chaining.
- **Complexity Configuration**: Added configurable `complexity` settings block
  to `.agentrc.json` with tunable thresholds: `maxComplexityScore`,
  `instructionLengthBreakpoints`, `estimatedFilesBreakpoints`,
  `focusAreasBreakpoints`, `enableAutoSplit`, `enableComplexityWarnings`, and
  `maxSubstepsPerTask`.
- **Complexity-Aware Execution Protocol (§9)**: Added a new section to
  `instructions.md` mandating agents self-decompose when encountering complexity
  warnings, enforcing a 5-file-per-substep rule and incremental commit
  discipline.
- **Renderer Enhancements**: Auto-split tasks display `🔀 Auto-split` badges
  with part numbering and parent task origin. High-complexity unsplittable tasks
  receive prominent `⚠️ COMPLEXITY WARNING` blocks in the rendered playbook.
- **Shared Branch Strategy**: Sub-tasks from auto-split share the parent task's
  branch (`task/sprint-XXX/{parentId}`) and follow the natural
  `sprint.chat.step` numbering (e.g. `045.1.1`, `045.1.2`, `045.1.3`).
- **Test Coverage**: Added `tests/complexity-estimator.test.js` with 27 tests
  covering scoring heuristics, task splitting, dependency rewiring, config
  toggles, and edge cases.

### Changed

- **Pipeline Integration**: The complexity analysis phase runs between
  `enrichManifest` and `validateManifest` in both `generate-playbook.js` and
  `PlaybookOrchestrator.js`, ensuring sub-task IDs are present before schema
  validation.
- **SDLC Documentation**: Updated the Sprint Planning section in `SDLC.md` with
  guidance on using `estimatedFiles` and `substeps` for complexity-aware
  planning.

## [4.1.3] - 2026-04-04

### Fixed

- **Shell Compatibility Hardening**: Updated `instructions.md` to strictly
  forbid `&&` chaining in PowerShell environments, mandating the more robust
  `; if ($?) { ... }` success-chaining pattern.
- **Cross-Platform Git Helper**: Introduced
  `.agents/scripts/git-commit-if-changed.js` to handle conditional git commits
  without relying on shell-specific logical operators.
- **Renderer Robustness**: Updated `Renderer.js` templates to utilize the new
  cross-platform commit script, ensuring generated playbooks are 100% compatible
  with Windows/PowerShell 5.1.
- **Documentation Alignment**: Updated `README.md` examples and `package.json`
  script guidance to reflect cross-platform best practices and avoid
  shell-related parser errors.

## [4.1.2] - 2026-04-04

### Fixed

- **Legacy Config Cleanup**: Replaced 30+ stale references to deprecated
  `.agents/config/` files (`config.json`, `models.json`, `tech-stack.json`)
  across `instructions.md`, `SDLC.md`, `README.md`, personas, templates, and
  workflows. All documentation now consistently references `.agentrc.json`.
- **Notification Enhancement**: prepended specific task/sprint IDs to webhook
  notifications across all sprint workflows for improved channel visibility.
- **Task State ID Validation**: Added format guard to `update-task-state.js`
  rejecting non-numeric slugs (e.g., `directories-db-migrations`). Only dotted
  playbook IDs (e.g., `045.2.1`) are now accepted. Disambiguated `[TASK_ID]`
  token definition in `sprint-finalize-task.md` and fixed the dangerously
  ambiguous "extract from branch name" instruction in `sprint-integration.md`.
- **Legacy Fallback Removal**: Removed the deprecated
  `.agents/config/config.json` fallback path from `config-resolver.js`.
  Resolution is now `.agentrc.json` → built-in defaults.
- **SDLC Diagram Correction**: Fixed Mermaid diagram in `SDLC.md` to show the
  correct bookend order (Integration → Code Review → QA) and updated the
  "Closing the Loop" section to match.
- **Read Context Grounding**: Improved the generator's `Read Context`
  instruction with explicit sprint-relative file paths (`prd.md`,
  `tech-spec.md`) and a direct reference to `.agentrc.json`'s `techStack`
  section.

## [4.1.1] - 2026-04-04

### Fixed

- **Playbook Pipeline Hardening**: Resolved "split-brain" dependency graph
  issues where parallel feature tracks were artificially serialized.
- **Global Context Synchronization**: Migrated the Project Reference Document
  list to `instructions.md`, establishing a global protocol for architectural
  grounding without redundant injections in every playbook task.
- **Instruction Injection**: Mandatory `Read Context` instruction step now
  auto-injected for non-bookend tasks to ensure grounding in PRD/Tech Specs and
  global project reference docs.
- **Bookend Sequence**: Established the bookend session order to **Integration →
  Code Review → QA** facilitating architectural alignment and pattern-level
  fixes before formal QA testing cycles begin.
- **Auto-Serializer Guard**: Fixed over-aggressive serialization logic to
  prevent feature tracking collisions based on bare scope matches.
- **Config Standardization**: Renamed `webhookUrl` to `notificationWebhookUrl`
  in `.agentrc.json` and all associated workflows to explicitly define its
  purpose for status notifications.

## [4.1.0] - 2026-04-04

### Added

- **Coverage Verification Phase**: Integrated a mandatory "Step 2.5" into the
  `sprint-generate-playbook.md` workflow to cross-check Tech Spec coverage and
  scope completeness before manifest finalization.
- **Model Registry Validation**: Added automated warnings during playbook
  generation for unrecognized model strings, validating against the
  `.agentrc.json` registry.

### Changed

- **Feature Track Isolation**: Hardened dependency rules to prevent artificial
  cross-feature serialization that destroys parallelism.
- **Mandatory Context Sync**: Every non-bookend agent prompt now mandates
  reading the PRD and Tech Spec before execution to prevent hallucination of
  architecture/schema details.
- **Strict Execution Ordering**: Reordered task instructions to ensure
  `Mark Executing` is the first action performed by the agent.
- **Explicit Branch Merges**: Renderer now injects concrete
  `git merge origin/<branch>` commands for all task dependencies, eliminating
  branching ambiguity.
- **Human-Operator Clarification**: Clearly labeled the
  `Manual Fix Finalization` block as a human-operator task in `Renderer.js` to
  prevent agent execution confusion.

## [4.0.0] - 2026-04-03

### Added

- **Cryptographic Provenance**: Integrated automated ED25519 PKI digital
  signatures into the agent receipt pipeline. By enabling
  `requireCryptographicProvenance` in `.agentrc.json`, the framework establishes
  a Zero-Trust immutable chain of custody for playbook integration gates.
- **Universal Protocol Standardization**: Consolidated all previously fragmented
  agent configuration into a single `.agentrc.json` at the project root. The
  canonical default is shipped as `.agents/default-agentrc.json` for consumers
  to copy and customise. All orchestration scripts now use the shared
  `lib/config-resolver.js` utility, which resolves `.agentrc.json` first, falls
  back to the legacy path with a deprecation warning, then applies built-in
  defaults as a final safety net.
- **Perception-Action Event Stream Protocol**: Implemented the core architecture
  for decoupling agent reasoning from environment execution. Playbooks now
  strictly enforce discrete, atomic environmental interactions via a localized
  event ledger.
- **Atomic Action Schema**: Introduced a formal JSON schema
  (`.agents/schemas/atomic-action-schema.json`) defining the structured API
  boundaries for agent environment interactions (ReadFile, WriteFile,
  ExecuteSafeCommand, ConcludeTask).
- **Isolated Multi-Agent Parallelization**: Eliminated Git lock race conditions
  during concurrent executions. The `run-agent-loop.js` orchestrator now
  natively intercepts branch instructions and creates isolated task execution
  environments using `git worktree` under `temp/workspaces/<task-id>`.
- **Strict Workflow Patterns**: Integrated `--pattern` parameterization into the
  Event Stream loop to enforce specialized AI architectures (e.g., Evaluator-
  Optimizer, Prompt Chaining) decoupled from monolithic playbook generation.
- **Event Stream Orchestrator**: Shipped `.agents/scripts/run-agent-loop.js`, a
  secure JSON-based REPL that manages the perception-action cycle and maintains
  an append-only JSONL audit trail in `temp/event-streams/`.
- **Agentic Plan Caching (APC)**: Implemented a novel test-time memory
  architecture to extract structured intent from successful executions.
  Standardized intent extraction now stores semantic logic in `temp/apc-cache/`
  to bypass redundant generative dependencies for identical tasks.
- **Speculative Execution & Cache-Aware Scheduling**: Integrated the
  `CacheManager` into the `generate-playbook.js` engine. The engine now
  mathematically identifies tasks that match previously cached intent and
  automatically tags them as `SpeculativeCache` for autonomous hydration.
- **Speculative Execution Hydration System**: Created `hydrate-cache.js` to
  natively apply cached diff parameterizations, allowing the framework to skip
  generative LLM cycles and bypass expensive planning for repetitive structural
  work.
- **Global APC Configuration**: Centralized cache settings, including TTL,
  hashing strictness, and execution toggles, into the global `.agentrc.json`
  schema under `apcCacheSettings`.

## [3.5.0] - 2026-04-03

### Added

- **`typecheckCommand` config key**: Configurable TypeScript compiler command
  (default: `pnpm turbo run typecheck`). Previously hardcoded across four
  heuristic rules.
- **`buildCommand` config key**: Configurable production build command (default:
  `pnpm turbo run build`). Previously hardcoded in the `.astro`/`.tsx`
  verification heuristic.

### Changed

- **Heuristics decoupled from commands**: All four heuristic rules that
  referenced `pnpm turbo run typecheck` or `pnpm turbo run build` now reference
  the configured `typecheckCommand` and `buildCommand` keys, making the protocol
  portable across monorepos using different package managers or task runners.

### Fixed

- **Task State Stagnation**: Simplified agent "Close-out" instructions in
  `Renderer.js` to eliminate redundant inline Git steps that were causing agents
  to skip the mandatory `sprint-finalize-task` workflow and its state update
  (`committed`).
- **Hardened Prerequisite Verification**:
  - Updated `Renderer.js` to explicitly pass the `taskStateRoot` argument to the
    `verify-prereqs.js` pre-flight command.
  - Upgraded `verify-prereqs.js` with internal configuration resolution to
    correctly identify the decoupled task state directory even when CLI
    arguments are omitted, matching the robustness of the primary status update
    utility.
- **Model Fallback Dead Code**: Fixed a logic ordering bug in `enrichManifest`
  where the `.includes()` substring dedup check always fired before the exact
  equality cross-assignment branch, causing the secondary model to be silently
  nullified instead of cross-assigned from the opposite tier. Tasks now
  consistently display both a First Choice and Second Choice model.

## [3.4.6] - 2026-04-03

### Changed

- **UI Prompt Layout**: Added double newlines after `=== SECTION ===` headers in
  the agent prompt and architectural review prompt. This fixes a rendering issue
  where headers and content were collapsed into a single line in some markdown
  readers, significantly improving legibility.

## [3.4.5] - 2026-04-03

### Fixed

- **Remote-Tracking Merge Refs**: Fixed dependency-chaining branching in
  `Renderer.js` to use `origin/task/sprint-N/...` remote-tracking refs instead
  of local branch names, preventing `not something we can merge` crashes in
  ephemeral environments.
- **Scope Auto-Expansion for E2E**: Added `e2e`, `playwright`, and `test` to the
  cross-package detection keywords, ensuring E2E-scoped tasks auto-expand to
  `root` when their instructions reference testing workspaces.

### Added

- **Bookend Completeness Warning**: Post-generation validation now emits
  warnings if any mandatory bookend task type (Integration, Code Review, QA,
  Retro, Close-Sprint) is missing from the manifest.

## [3.4.4] - 2026-04-03

### Fixed

- **Close-out Literal Variable Trap**: Separated the cognitive instruction
  ("Analyze your diff, then run this command with your generated message") from
  the executable bash pattern, preventing agents from literally committing
  placeholder strings into git history.
- **Model Duplication Bug**: Fixed the fallback dedup check to use `.includes()`
  substring matching instead of strict `===` equality, eliminating triple-model
  strings like
  `Claude Sonnet 4.6 (Think) OR Gemini 3.1 Pro (High) OR Gemini 3.1 Pro (High)`.
- **HITL Over-Flagging**: Engine now strips `requires_approval` from non-bookend
  development tasks during enrichment, reserving HITL stops exclusively for
  Integration, Code Review, and Close-Sprint phases.

### Added

- **Cache/Eviction Test Heuristic**: Tasks modifying caching or memory
  management logic must include explicit test-writing instructions.
- **Soft-Verb Replacement Heuristic**: Instructions using "validate that" /
  "ensure that" must be replaced with explicit CLI execution commands.
- **Astro Build Verification Heuristic**: `.astro`/`.tsx` text replacements must
  mandate both `typecheck` AND `build` to catch structural HTML errors.

## [3.4.3] - 2026-04-03

### Fixed

- **Auto-Serialization Guard Widened**: Changed the overlap detection from `&&`
  (both global) to `||` (either global) in `generate-playbook.js`, ensuring any
  `scope: root` task forces serialization with all parallel tasks to prevent
  merge conflicts.
- **Scope Auto-Expansion**: Added cross-package instruction analysis in
  `enrichManifest` that auto-expands task scope to `root` when instructions
  reference 2+ workspace indicators (e.g., "Astro" + "Expo"), preventing agent
  sandbox crashes.
- **Close-out Clean Tree Crash**: Replaced prose-only commit instructions in
  `Renderer.js` with a crash-safe bash pattern
  (`git diff --staged --quiet || git commit`) that returns `exit 0` on clean
  working trees.
- **Branching Fetch Injection**: Moved `git fetch origin` from a regex on the
  task instructions field (which agents don't copy) into the actual
  `branchInstruction` builder (which agents do copy) across all three code paths
  (default, bookend, dependency-chaining).
- **Bookend Model Elevation**: Added `model` overrides to `isQA`,
  `isCodeReview`, and `isRetro` bookend requirements in `.agentrc.json`, and
  wired `enrichManifest` to apply them to the primary model field.

## [3.4.2] - 2026-04-03

### Fixed

- **Structural Global Sweep Serialization**: Hardened the `generate-playbook.js`
  engine to mathematically detect and auto-serialize parallel monorepo-wide
  sweep tasks (e.g. `scope: root`), eliminating merge conflict vectors without
  manual AI intervention or brittle prompt heuristics.
- **Literal Execution Protocol Hardening**: Removed all literal string examples
  (e.g., git commit messages) in the `Renderer.js` Close-out protocols to
  prevent autonomous agents from hyper-literally copying placeholder values into
  production Git histories.
- **Compute Allocation Elevation**: Exposed and upgraded the default planning
  model to High/Thinking tiers (e.g., Claude Sonnet 3.6 OR Gemini 3.1 Pro) in
  `.agentrc.json` to ensure sufficient reasoning capacity for complex monorepo
  AST operations.

## [3.4.1] - 2026-04-03

### Fixed

- **Universal Remote State Sync**: Refactored the internal `Renderer.js`
  branching protocol to mandate an explicit `git fetch origin` before any
  checkout or merge, ensuring ephemeral runners never crash due to stale local
  branch lists.
- **Architectural Scope Validation**: Implemented a core heuristic in
  `.agentrc.json` that restricts Planner-defined task scopes to valid monorepo
  workspace names (e.g. `@repo/web`) or the literal string `root`, preventing
  `pnpm --filter` tool crashes.
- **Ambiguous UI Constraint Guardrail**: Added systemic planner heuristics that
  force the grounding of UI standardization tasks against the official design
  system documentation, eliminating subjective hallucination vectors for
  autonomous styling agents.
- **Monorepo-Wide Verification**: Codified a mandatory
  `pnpm turbo run typecheck` requirement for all cross-cutting type-safety
  refactors to ensure architectural boundaries remain unbroken.

## [3.4.0] - 2026-04-03

### Fixed

- **Parallel Fan-Out Merge Collision Detection**: Integrated a transitive
  closure reachability matrix into the core graph engine (`Graph.js`) which
  proactively identifies when concurrent tasks share focusArea patterns without
  explicit sequencing, throwing a fatal validation error to prevent git merge
  conflicts.
- **Literal Bash Instruction Decoupling (Final)**: Completely decoupled
  non-executable cognitive variables from bash backticks in `Renderer.js`,
  preventing hyper-literal agents from corrupting commit messages with
  placeholder templates.

### Added

- **Protocol Lineage Tracking**: Embedded an automatic version indicator at the
  top of all generated Playbook files to streamline traceability and protocol
  debugging across multiple sprint versions.

## [3.3.9] - 2026-04-03

### Fixed

- **Bash Command Literal Execution**: Refactored `Renderer.js` prompt logic to
  explicitly decouple cognitive instructions from bash command strings,
  preventing agents from hyper-literally executing the text `<generate...>`
  instead of an actual message.
- **Model Fallback Determinism**: Overhauled `generate-playbook.js` manifest
  enrichment to automatically invert default fallback assignments when the
  primary model matches the fallback family, ensuring 100% diversity in the
  retry loop.

### Added

- **Zod Schema Bridge Heuristic**: Added a systemic guardrail to `.agentrc.json`
  enforcing the generation and export of validation schemas (Zod) during
  database migration tasks to proactively stabilize downstream API consumption.

## [3.3.8] - 2026-04-03

### Fixed

- **Multi-Dependency Branching Collision**: Updated `Renderer.js` to
  intelligently chain `git merge` commands during task initialization when
  multiple fan-in dependencies are present, ensuring all required context is
  available.
- **Graceful "Clean Tree" Commits**: Refactored the universal
  `AGENT EXECUTION PROTOCOL` to make commits conditional on staged changes
  (`git diff --staged --quiet || git commit`), preventing exit code crashes in
  headless terminals on zero-diff tasks.
- **Semantic Commit Enforcement**: Replaced hardcoded `feat:` prefixes with a
  dynamic instruction for agents to generate context-aware Conventional Commit
  messages based on their actual diffs.
- **Code Review Push Stability**: Standardized the manual fix prompt to push to
  `HEAD` instead of hardcoded sprint branches, resolving detached state
  conflicts.

### Added

- **Architectural Risk Gate Heuristics**: Expanded the global `.agentrc.json`
  risk gates with mandatory systemic guardrails enforcing programmatic tests
  (Playwright/Vitest), type-check verification after AST refactors, and
  synchronous DB schema pushes.

## [3.3.7] - 2026-04-03

### Added

- **Configurable Golden Example Storage**: Introduced `goldenExamplesRoot` in
  `.agentrc.json` to allow custom paths for harvested golden paths (defaulting
  to `temp/golden-examples`).
- **Dynamic Playbook Reinforcement**: Updated `Renderer.js` and
  `harvest-golden-path.js` to dynamically resolve the golden example store using
  the new configuration property, enabling project-specific few-shot prompt
  reinforcement.

## [3.3.6] - 2026-04-03

### Changed

- **Native Bookend Workflows**: Restructured post-integration workflows
  (`sprint-testing`, `sprint-code-review`, `sprint-retro`, `sprint-close-out`)
  to execute natively on the base `sprint-[NUM]` branch, completely eliminating
  the creation of post-integration feature branches.
- **Workflow Cleanup**: Removed the self-cleanup branch deletion step from
  `sprint-integration` as the agent now executes natively on the base
  integration branch.

## [3.3.5] - 2026-04-03

### Fixed

- **Markdown Code Block Collisions**: Upgraded the outer agent prompt wrapper in
  `Renderer.js` to use 4 backticks (` `markdown ````). This prevents Golden
  Example triple-backticks from prematurely closing the prompt and corrupting
  the playbook's structure.

## [3.3.4] - 2026-04-03

### Added

- **Manual Fix Finalization Prompt**: Updated `Renderer.js` to automatically
  inject a specialized **DevOps/Git-Flow** cleanup prompt into Code Review
  tasks. This ensures manual architectural fixes are correctly committed and
  merged back into the sprint base branch before QA begins.

## [3.3.3] - 2026-04-03

### Changed

- **Nomenclature Realignment**: Updated all visual and textual references in the
  playbook and integration workflows to use `Pending Integration` and
  `Integrated` instead of the ambiguous "Not Started" vs "Complete".

## [3.3.2] - 2026-04-03

### Changed

- **Cross-Platform State Tracking**:
  - Replaced manual `mkdir -p` and `echo` JSON commands in
    `sprint-finalize-task.md` with invocations of the `update-task-state.js`
    Node script to ensure cross-platform compatibility (preventing execution
    spinning/hanging on Windows PowerShell).
  - Updated `update-task-state.js` to automatically generate the
    `[TASK_ID]-test-receipt.json` artifact when instructed with the `passed`
    state.
  - Updated `verify-prereqs.js` to recognize decoupled `passed` states as
    logically equivalent to `committed`, ensuring dependent tasks seamlessly
    unblock.

## [3.3.1] - 2026-04-02

### Fixed

- **Ghost Branching & Uncommitted Changes**:
  - Updated `Renderer.js` to explicitly mandate a `git add . && git commit` step
    in the `AGENT EXECUTION PROTOCOL` before pushing.
  - Hardened root task branching: agents now explicitly reset to the sprint base
    branch (`git checkout sprint-[NUM]`) before creating new feature branches,
    preventing uncommitted changes from being dragged across parallel roots.

## [3.3.0] - 2026-04-02

### Changed

- **Refactored Playbook Generation**:
  - Replaced abstract `/[.agents/workflows/... ]` commands with explicit natural
    language instructions to prevent LLMs from hallucinating bash commands.
  - Added explicit instructions for agents to push their integrated branches
    using `git push -u origin HEAD`.
  - Modified task instructions presentation so bulleted lists format correctly
    under the task header line.
  - Reordered bookend pipeline: **Code Review** now strictly precedes **QA
    Audit** to ensure tests run on architecturally approved code.
  - Enforced deterministic ordering by recalculating graph adjacency after
    grouping, ensuring the markdown execution plan matches the logical flow.

### Fixed

- **Execution & Branching Bugs**:
  - Implemented **chained branching commands** for dependent tasks: agents now
    explicitly checkout their prerequisite branch before creating their own
    feature branch.
  - Added **intelligent pathspec mapping**: dependencies on integration, QA, or
    Code Review tasks now correctly resolve to the `integration` branch.
  - Optimized administrative workflows: **Sprint Close Out** now reuses the
    retro branch to minimize redundant git tree clutter.
  - Enforced **universal pre-flight validation**: EVERY task (including roots)
    now executes `verify-prereqs.js` for environment and state consistency.
  - Fixed implicit dependency flaws where task steps without explicit
    `dependsOn` declarations were bypassing pre-flight `verify-prereqs`
    execution instructions inside the agent context.
  - Enforced structured `🚨 HITL REQUIRED` stopping points dynamically within
    the volatile task context instead of just as metadata.

## [3.2.1] - 2026-04-02

### Changed

- **Refactored Playbook Task Layout**:
  - Grouped task metadata, dependencies, and agent prompts into a single,
    unified, sequential block per task for better readability and execution
    clarity.
  - Removed top-level `#### Tasks` and `#### Agent Prompt` headings to
    streamline the execution plan.
  - Unified the checkbox format to `[ ] **{taskId}** {taskTitle}` without
    leading markdown dashes.

### Fixed

- **Resilient Prerequisite Verification**:
  - Updated `verify-prereqs.js` regex logic to support both legacy (`- [ ]`) and
    new (`[ ]`) checkbox formats, ensuring backward compatibility for concurrent
    sprints.

## [3.2.0] - 2026-04-02

### Added

- **Exploratory Testing Integration**:
  - Enhanced the `/sprint-testing` workflow with a mandatory **Exploratory
    Testing** step (Step 5) to identify edge cases and regressions outside the
    formal test plan.
  - Mandated a remediation loop where agents must address and verify any issues
    found during exploratory testing before finalizing the task.
  - Introduced the `exploratoryTestCommand` configuration property in
    `.agentrc.json` (default: `pnpm test:exploratory`) to ensure the testing
    suite is fully configurable.

## [3.1.3] - 2026-04-02

### Fixed

- **Decoupled Playbook Prompts**: Fixed a regression where consolidated
  phase-based Chat Sessions (e.g., "Merge & Verify") were erroneously rendering
  multiple distinct tasks inside a single `#### Agent Prompt` block.
- Refactored `Renderer.js` to iterate over session tasks and generate distinct
  LLM instruction blocks (`#### Agent Prompt: [Title]`) for each task within a
  consolidated session, ensuring clear, distinct execution bounds.

## [3.1.2] - 2026-04-02

### Fixed

- **ESM Notification Script**: Converted `.agents/scripts/notify.js` to a native
  ES module to resolve `ReferenceError: require is not defined`.
- **Structured Friction Logging**:
  - Replaced brittle shell-based `echo` appending with a robust Node.js utility:
    `.agents/scripts/log-friction.js`.
  - This ensures valid JSONL formatting and eliminates stray characters or
    newlines that caused JSON parsing failures in previous versions.
  - Updated `sprint-setup`, `sprint-finalize-task`, `sprint-integration`, and
    `sprint-close-out` workflows to use the new logging script.

## [3.1.1] - 2026-04-02

### Added

- **Decoupled Task State Management**:
  - Introduced `.agents/scripts/update-task-state.js` utility for standardized
    JSON-based task state tracking.
  - Refactored the `AGENT EXECUTION PROTOCOL` to include a mandatory **Mark
    Executing** step using the new utility.
  - Formally aligned the playbook with the **v2.18.3+ simplified protocol**,
    removing all instructions for manual checkbox editing (`- [ ]` -> `- [/]`).

- **Config-Driven Playbook Generation**:
  - Refactored `generate-playbook.js` and `Renderer.js` to eliminate hardcoded
    `docs/sprints` paths and `3`-digit padding.
  - The generation pipeline now dynamically respects `sprintDocsRoot` and
    `sprintNumberPadding` defined in `.agentrc.json`.

- **Intelligent Model Fallbacks**:
  - Restored the dual-model enforcement protocol in `generate-playbook.js`.
  - Every task now guarantees both a **First Choice** and **Second Choice**
    model.
  - Implemented configurable fallbacks (Planning -> Pro Low, Fast -> Flash)
    defined in `.agentrc.json`.

- **Enhanced Task Branching Logic**:
  - Updated `Renderer.js` to inject explicit `git checkout -b` commands for
    every task directly into the agent instructions.
  - Standardized the feature branch naming convention:
    `task/sprint-[NUM]/[TASK_ID]`.

- **Conditional Pre-flight Verification**:
  - Refactored the `AGENT EXECUTION PROTOCOL` to conditionally omit the
    pre-flight dependency check for tasks with zero dependencies.
  - This streamlines execution for independent tasks while maintaining strict
    verification for chained work.

### Changed

- **Human-Centric Model Recommendations**:
  - Refactored the playbook layout to move `Mode` and `Model` identifiers above
    the `Agent Prompt` block.
  - This ensures recommendations are clearly visible for human consumption and
    manual model selection while keeping the automated prompt block focused on
    execution logic.

### Fixed

- **Task ID Resolution Bug**: Fixed a logic error where the pre-flight
  verification script was being generated with incorrect internal manifest IDs
  (e.g., `043.1.a`) instead of the required numeric identifiers (e.g.,
  `043.1.1`).

## [3.1.0] - 2026-04-02

### Added

- **Optional Style-Guide Support**:
  - Introduced support for a `docs/style-guide.md` file to house
    project-specific writing standards, aesthetic constraints, and UI
    copywriting rules.
  - Updated all core personas (`technical-writer`, `ux-designer`, `product`,
    `engineer-web`, `engineer-mobile`) and the `Markdown Mastery` skill to
    conditionally defer to the style guide if present.
  - Added a high-fidelity "Golden Sample" style guide to
    `.agents/sample-docs/style-guide.md` based on the KinetixID design system.
  - MARKED `docs/style-guide.md` as an optional artifact in the SDLC
    documentation and global instructions.

- **Context Caching Prompt Architecture**:
  - Restructured the `playbook.md` generation logic in `Renderer.js` to strictly
    separate static framework rules from volatile task state.
  - Implemented a two-layer prompt architecture with an immutable
    `=== SYSTEM PROTOCOL & CAPABILITIES ===` header at the start of every agent
    prompt block.
  - This optimization maximizes character-for-character prefix matching,
    enabling 100% native LLM API token caching for protocol-level instructions.
  - Promoted task-specific "Pre-flight Task Validation" to a clearly labeled
    volatile section to maintain both discoverability and cache consistency.

- **Automated Context Pruning ("Gardener")**:
  - Implemented `run-context-pruning.md` workflow for systematic archiving of
    stale architectural decisions and patterns.
  - Updated `context-indexer.js` to explicitly ignore the `docs/archive/`
    directory, preventing stale context from polluting Local RAG.
  - Integrated the Gardener workflow into `epic-retro.md` as a mandatory
    close-out step.
  - Updated SDLC and README to reflect the new documentation lifecycle and the
    `docs/archive/` directory standard.

- **Zero-Touch Remediation Loop**:
  - Automates the transition from a failed `/sprint-integration` candidate check
    into an immediate `/sprint-hotfix` loop.
  - Introduced `maxIntegrationRetries` to `.agentrc.json` (default: 2) to
    control the automated remediation depth.
  - Integrated diagnostic capturing via `diagnose-friction.js` directly into the
    integration verification step.
  - Mandated recursive integration attempts within `sprint-hotfix.md` until the
    retry threshold is reached, minimizing human-in-the-loop dependencies for
    integration failures.

- **Dynamic Golden-Path Harvesting (Agentic RLHF)**:
  - Created `harvest-golden-path.js` script to automatically extract
    Zero-Friction implementation diffs and instruction pairings into a local
    `.agents/golden-examples/` repository.
  - Updated `diagnose-friction.js` to support `--task` tagging, enabling precise
    association of friction points with specific task IDs.
  - Integrated harvesting into the `/sprint-finalize-task` workflow as a
    standard completion step.
  - Modified `Renderer.js` to dynamically inject harvested golden paths as
    few-shot prompts into new playbooks, facilitating autonomous project
    alignment and reinforcement learning.

- **Semantic Risk & Blast-Radius Gates**:
  - Upgraded static keyword `riskGates.words` in `.agentrc.json` to a semantic
    `riskGates.heuristics` framework.
  - Updated `sprint-generate-tech-spec.md` to instruct the AI Architect to act
    as a semantic classifier for blast-radius analysis.
  - Updated `sprint-generate-playbook.md` to enforce Human-In-The-Loop (HITL)
    approval for tasks flagged by semantic security assessments.
  - Refined documentation (SDLC, README) to reflect the transition from brittle
    deterministic checks to contextual AI-driven risk mitigation.

- **Adversarial Red-Teaming (Tribunal)**:
  - Introduced the on-demand `/run-red-team` workflow for cross-examining and
    hardening code via dynamic fuzzing and mutation tests.
  - Assigned the `security-engineer` persona to provide adversarial scrutiny on
    branches or directories before functional QA.

## [3.0.0] - 2026-04-02

### Added

- **Local RAG & Semantic Context Retrieval**:
  - Implemented `.agents/scripts/context-indexer.js`, a zero-dependency TF-IDF
    engine for local documentation indexing and semantic search.
  - Updated `.agents/workflows/sprint-gather-context.md` to prioritize semantic
    retrieval over monolithic file reading.
  - Refined `instructions.md` to mandate Local RAG for efficient context
    gathering, mitigating context window bloat.
  - Added repository-wide Guiding Principles to `docs/roadmap.md` focusing on
    flexibility and self-contained architecture.

- **FinOps & Economic Guardrails**:
  - Added `maxTokenBudget` and `budgetWarningThreshold` properties to
    `.agentrc.json`.
  - Updated `instructions.md` (Section 2) with mandatory token tracking,
    soft-warning (80%), and hard-stop (100%) protocols to prevent budget
    overruns.
  - Enriched `.agentrc.json` with `finops_recommendations` to guide agents
    toward cost-effective API tiering.

- **HITL Risk Gates for Safe Execution**:
  - Added `riskGates` configuration to `.agentrc.json` with default trigger
    keywords (`DROP`, `DELETE`, `IAM`, etc.).
  - Updated the Task Manifest schema with a `requires_approval` property.
  - Automated Tech Spec phase to flag destructive workflows natively in the
    playbook, halting the execution sequence until explicitly human-approved.
  - Solidified the safety guidelines in the core `instructions.md`.

- **Telemetry-Driven Retro Recommendations (Self-Healing)**:
  - Enhanced `.agents/workflows/epic-retro.md` and the `architect` persona to
    mandate macro-analysis of `agent-friction-log.json`.
  - Modified `.agents/templates/sprint-retro-template.md` to format Protocol
    Optimization Recommendations as "agent-ready" markdown snippets, creating an
    evolving library immune loop.

- **Macroscopic Telemetry Observer**:
  - Created `.agents/scripts/aggregate-telemetry.js`, a script that parses
    structured telemetry across an entire sprint range.
  - Auto-generates `docs/telemetry/observer-report.md` tracking long-term
    efficiency bottlenecks and framework tool failures.

- **Unified Quality Auditing**:
  - Renamed `audit-qa` workflow to `audit-quality` to better reflect its
    comprehensive scope (Infrastructure, Coverage, Fragility, and Strategy).
  - Updated all internal documentation, personas, and file links to the new
    `/audit-quality` standard.

## [2.24.0] - 2026-04-02

### Added

- **Enhanced Diagnostic Tools & Passive Telemetry**:
  - Implemented `.agents/scripts/diagnose-friction.js`, replacing the "honor
    system" for logging tool failures. This script wraps failing commands, logs
    execution details (stdout/stderr) natively to `agent-friction-log.json`, and
    outputs structured remediation steps back to the agent to prevent thrashing.
  - Updated `instructions.md` to formally mandate the use of the new diagnostic
    interceptor for unrecoverable errors.
  - Refined `SDLC.md` to articulate the expanded Observability loop using this
    automated telemetry approach.
  - Shifted the corresponding roadmap item from **Planned** to **Completed**.

## [2.23.0] - 2026-04-02

### Added

- **Persona Specialization & Framework Handshake**:
  - Introduced the mandatory **Framework Handshake** protocol in
    `engineer-web.md`, forcing agents to read framework-specific skills before
    execution.
  - **Astro 5 (Iron) Modernization**: Updated `astro/SKILL.md` to enforce Server
    Islands (`server:defer`), Astro Actions for data mutations, and the new
    Content Layer API.
  - **Tailwind CSS v4 (CSS-First)**: Hardened the `tailwind-v4/SKILL.md` and
    `ux-designer.md` persona to enforce a strict CSS-only configuration using
    the `@theme` directive, banning legacy `tailwind.config.ts/js` files and
    arbitrary utility values.
  - **Task State Tracking**: Created localized task and walkthrough artifacts
    for traceable implementation.

## [2.22.0] - 2026-04-02

### Added

- **Hybrid Integration & Blast-Radius Containment (Option 3)**:
  - Introduced the "Integration Candidate" protocol to ensure the shared
    `sprint-[NUM]` branch never enters a broken state.
  - **Ephemeral Verification**: Merges are now performed on temporary
    `integration-candidate-[TASK_ID]` branches first.
  - **Fail-Safe Rollback**: If tests fail on the candidate branch, the branch is
    purged, and the failure is logged to `agent-friction-log.json` without
    polluting the sprint base.
  - **`sprint-hotfix` Workflow**: Created a dedicated workflow for rapid
    remediation of broken features directly on their original branch, unblocking
    other parallel integrations.
  - **SDLC Documentation**: Updated `SDLC.md` and the `roadmap.md` to reflect
    the completion and adoption of the hybrid containment model.

## [2.21.0] - 2026-04-02

### Added

- **Advanced Concurrency & Merge Conflict Protocols**:
  - Introduced a hybrid concurrency model (Option C) to eliminate complex
    structural merge conflicts during execution.
  - **Schema Update**: Added `focusAreas` property to
    `task-manifest.schema.json` to allow static prediction of high-risk file
    overlaps during the planning phase.
  - **Runtime Rebase Wait-Loop**: Refactored the `sprint-finalize-task` workflow
    to force agents to run `git pull --rebase origin sprint-[NUM]` and manually
    resolve structural conflicts against the remote base branch _before_ running
    validation tests and pushing their feature branch.
  - **SDLC Documentation**: Updated `SDLC.md` to formally outline the new
    Advanced Concurrency Protocols.

## [2.20.0] - 2026-04-02

### Added

- **"Shift-Left" Agentic Testing Protocol**:
  - Introduced a mandatory validation step where agents must run isolated tests
    on their feature branch before finalizing a task.
  - Implemented **Option B (Agentic Test Receipt)**: Agents execute the
    configured `testCommand` and generate a `[TASK_ID]-test-receipt.json` in the
    decoupled state folder as evidence of a green state.
  - Updated the `sprint-integration` workflow to act as a strict gatekeeper,
    blocking the merge of any branch that lacks a valid "passed" test receipt.
  - This protocol eliminates the "happy path" anti-pattern by ensuring only
    verified code enters the shared sprint branch, matching CI-like standards in
    a local-first environment.

### Changed

- **Modernized Validation Commands**:
  - Updated `validationCommand` and `testCommand` in `.agentrc.json` to leverage
    **pnpm turbo** for faster, cached execution.
  - Default `validationCommand`: `pnpm turbo run lint`.
  - Default `testCommand`: `pnpm turbo run test`.
- **Workflow Hardening**:
  - Updated `sprint-finalize-task` to enforce the new testing requirement and
    receipt generation.
  - Updated `sprint-integration` to verify receipt existence and status before
    commencing merges.
- **SDLC Documentation**:
  - Formally documented the Shift-Left testing requirements and the
    "cryptographic-like" evidence of the test receipt in `SDLC.md`.

## [2.19.0] - 2026-04-02

### Changed

- **Unified Webhook Failure Logging**:
  - Deprecated the legacy `WEBHOOK_FAILURE.md` file requirement.
  - Updated `sprint-finalize-task`, `sprint-integration`, and `sprint-close-out`
    workflows to mandate logging notification failures directly to the
    structured `agent-friction-log.json` file (JSONL format).
  - This change aligns webhook telemetry with the project's broader
    "agent-friction" observability protocol, improving error traceability and
    reducing per-sprint documentation clutter.

## [2.18.3] - 2026-04-02

### Added

- **Configurable Task State Root**:
  - Introduced `taskStateRoot` in `.agentrc.json` to allow custom paths for
    decoupled task state files.
  - Set the default path to `temp/task-state/` (in the project root) to keep the
    repository clean and avoid polluting Git history with transient state.
  - Updated `instructions.md`, `SDLC.md`, and the `sprint-finalize-task`
    workflow to dynamically resolve the task state path.
  - Implemented conditional Git tracking: state files in `/temp/` are
    local-only, while those in project directories (e.g., `docs/sprints/`)
    continue to be committed for cross-agent synchronization.

### Changed

- **Simplified Playbook State Tracking**:
  - Removed intermediate `[- [~]]` (Executing) and `[- [/]]` (Committed)
    statuses from the sprint playbook entirely.
  - The playbook now only tracks `[- [ ]]` (Not Started) and `[- [x]]`
    (Complete).
  - All intermediate states are now exclusively managed by decoupled JSON state
    files located in `taskStateRoot`.
  - Refactored `verify-prereqs.js` to parse both the playbook `[x]` markers and
    the decoupled `committed` state files when evaluating dependencies, ensuring
    concurrent feature branches don't prematurely block execution.
  - Simplified the visually generated Mermaid DAG, condensing it to only
    `⬜ Not Started` and `🟩 Complete` nodes.

## [2.18.2] - 2026-04-02

### Fixed

- **Parallel Task Generation**:
  - Overhauled `groupRegularTasks` in `generate-playbook.js` to correctly emit
    independent, parallelizable tasks as distinct Chat Sessions.
  - Removed logic that inadvertently grouped same-layer tasks into single
    sequential windows based on shared scope (e.g., `root`), which was falsely
    representing parallel work as sequential in the Mermaid graph and execution
    prompts.

## [2.18.1] - 2026-04-02

### Added

- **Automated Manifest Enrichment**:
  - Introduced `enrichManifest` function to `generate-playbook.js` to
    automatically inject required personas and skills for bookend tasks.
  - Reduces boilerplate in `task-manifest.json` and prevents validation errors
    for missing mandatory fields in Integration, QA, Code Review, Retro, and
    Close Sprint tasks.

## [2.18.0] - 2026-04-02

### Changed

- **Extracted Base Branch Configuration**:
  - Centralized the primary development branch (default: `main`) into
    `.agentrc.json`.
  - Extracted the sprint documentation root (`sprintDocsRoot`: `docs/sprints`),
    sprint number padding (`sprintNumberPadding`: 3), validation command
    (`validationCommand`: `npm run lint`), and notification webhook
    (`webhookUrl`) into the configuration.
  - Updated all core workflows (sprint planning, setup, execution, and closure)
    to dynamically resolve paths using these configuration variables.
- **Improved Branch Naming Consistency**:
  - Updated `sprint-integration` and `sprint-close-out` workflows to expect and
    manage branches with the `task/` prefix (e.g.,
    `task/sprint-[SPRINT_NUMBER]/[TASK_ID]`), aligning with the established
    conventions in `instructions.md`.
- **Introduced Cross-Platform Execution Scripts**:
  - Created `.agents/scripts/notify.js` to handle webhook JSON payloads
    programmatically, replacing OS-dependent `curl` commands.
  - Created `.agents/scripts/detect-merges.js` to ensure reliable conflict
    marker detection across all files, replacing `git grep`.
  - Updated `sprint-integration`, `sprint-close-out`, and `sprint-finalize-task`
    to execute these local Node.js scripts.
  - Created `.agents/scripts/verify-prereqs.js` to deterministically evaluate
    task dependencies and chat predecessors by parsing the `playbook.md`.
- **Decoupled Task State Management**:
  - Refactored `sprint-finalize-task.md` to exclusively use
    `task-state/[TASK_ID].json` files for status tracking, removing manual
    `playbook.md` editing to eliminate race conditions during concurrent
    execution.
- **Clarified Testing Responsibilities**:
  - Updated `epic-testing.md` and `audit-quality.md` to explicitly demarcate
    that Software Engineers (SWEs) are responsible for unit and integration
    testing during development, while the QA persona focuses exclusively on E2E
    automation and documentation during integration.
- **Hardened Final Sprint Integration**:
  - Added a mandatory **Final Integration Audit** (Step 3) to the
    `sprint-close-out` workflow. This step enforces a check for unmerged task
    branches and prevents sprint closure if remediation work is detected.
  - Updated the `sprint-integration` workflow to explicitly recommend rerunning
    the integration process whenever new feature or remediation branches are
    created after the initial integration.

## [2.17.3] - 2026-04-02

### Added

- **Configurable Friction Thresholds**:
  - Extracted hardcoded agent-friction and anti-thrashing thresholds into
    `.agentrc.json` under `frictionThresholds`.
  - Thresholds for consecutive errors, stagnation steps, and repetitive command
    detection are now fully configurable.
  - Updated `instructions.md`, `SDLC.md`, and project READMEs to reference the
    dynamic configuration values.

## [2.17.2] - 2026-04-01

### Changed

- **Standardized QA Workflow Naming**:
  - Renamed the `plan-qa-testing` workflow to `sprint-testing` across all
    protocols, documentation, and tooling.
  - Aligned the QA phase with the `sprint-[action]` naming convention used by
    other core workflows.
  - Updated the `project-manager` and `qa-engineer` personas, SDLC
    documentation, and the playbook generation script to utilize the new
    workflow command.

## [2.17.1] - 2026-04-01

### Added

- **Workspace & File Hygiene Protocol**:
  - Introduced a mandatory global instruction in `instructions.md` to store all
    temporary files, scratch scripts, and intermediate outputs in a root
    `/temp/` directory.
  - Automatically excluded the `/temp/` directory from Git to prevent repository
    pollution and history bloat.

## [2.17.0] - 2026-04-01

### Added

- **Architecture Decisions & Code Patterns Context**:
  - Elevated `docs/decisions.md` (ADRs) and `docs/patterns.md` to core context
    requirements in `instructions.md`.
  - Added sample references for these files in `.agents/sample-docs/`.
  - Updated `sprint-gather-context` to explicitly read these artifacts before
    sprint execution.
  - Updated `sprint-code-review` to verify new code against established
    patterns.
  - Updated `sprint-retro` to close the feedback loop by formally documenting
    newly emerged rulings and architectural decisions into these files.

## [2.16.0] - 2026-04-01

### Added

- **Roadmap Review Workflow**:
  - Introduced the `/sprint-roadmap-review` workflow (formerly `scope-roadmap`)
    to assist Product Managers with sprint grooming and feature decomposition in
    `docs/roadmap.md`.
  - Updated the `product` persona and SDLC documentation to integrate the new
    roadmap scoping command into Phase 1 of the development lifecycle.
  - Renamed all audit-related workflows from `[feature]-audit.md` to
    `audit-[feature].md` for better discoverability and sorting.
  - Renamed all sprint-related workflows to follow the `sprint-[action]` pattern
    (e.g., `close-sprint.md` → `sprint-close-out.md`, `generate-prd.md` →
    `sprint-generate-prd.md`).
  - Updated internal artifact filenames, headers, and slash commands across the
    entire protocol to ensure consistency.

## [2.15.0] - 2026-04-01

### Added

- **Configurable Efficiency Guardrails**:
  - Introduced **Instruction Density** as the core complexity metric, replacing
    file counts. Configurable via `maxInstructionSteps` in `.agentrc.json`
    (default: 5 logical steps).
  - Updated the **Anti-Thrashing Protocol** with clear error and research
    thresholds to prevent agent stagnation.
  - Added a dedicated **🛡️ Efficiency & Guardrails** section to all project
    READMEs and SDLC documentation to improve protocol transparency.

### Changed

- **Version Bump**: Incremented project version to `2.15.0`.

## [2.14.0] - 2026-04-01

### Added

- **Repetitive Task Capture & Automation Recommendations**:
  - Introduced the `AutomationCandidate` telemetry type in
    `agent-friction-log.json` to identify boilerplate and repetitive agent
    tasks.
  - Updated the **Sprint Retrospective** template and workflow to systematically
    analyze execution logs for automation opportunities.
  - Provided a dedicated **Protocol Automation & Optimization Recommendations**
    section in the retro report to surface protocol improvements without
    polluting the project roadmap.

### Changed

- **Version Bump**: Incremented project version to `2.14.0`.

## [2.13.0] - 2026-04-01

### Added

- **Master Planning Alignment Audit**:
  - Introduced a mandatory **Alignment & Consistency Audit** (Step 4) in the
    `plan-sprint` orchestrator.
  - The `architect` persona now performs cross-artifact reviews of the PRD, Tech
    Spec, and Playbook to ensure logical unity, strict 3-digit padding
    adherence, and mandatory bookend protocol compliance.

### Changed

- **Hardened Git & Sprint Protocols**:
  - **Strict Branch Naming**: Mandated the `task/sprint-[XXX]/[ID]` branch
    naming convention in global `instructions.md` and `finalize-sprint-task` to
    eliminate graph visual clutter.
  - **Standardized Status Commits**: Enforced the
    `chore(sprint): update task [ID] status to [STATUS]` commit template for all
    lifecycle events.
  - **Decoupled State Tracking**: Implemented a "decoupled" status tracking
    mechanism. Agents now write lifecycle updates to individual
    `task-state/[ID].json` files to prevent merge conflicts and history
    pollution on the primary sprint branch.
- **Version Bump**: Incremented project version to `2.13.0`.

## [2.12.0] - 2026-03-31

### Added

- **Agent Friction Telemetry**:
  - Introduced a mandatory **Agent Friction Logging** protocol to capture
    consecutive tool validation errors, command execution failures, and prompt
    ambiguities in a per-sprint `agent-friction-log.json` file.
  - Updated the `sprint-setup` workflow to automatically initialize an empty
    JSONL telemetry file during sprint directory creation.
  - Structured logs (Timestamp, Tool, Error, Context) enable systemic auditing
    of agentic "struggle points" to inform protocol and tool refinements.

### Changed

- **Version Bump**: Incremented project version to `2.12.0`.

## [2.11.0] - 2026-03-31

### Changed

- **Playbook Generator Optimizations**:
  - **Transitive Dependency Reduction**: Overhauled `generate-playbook.js` with
    a Floyd-Warshall transitive reduction algorithm. The Mermaid graph and
    task-level `Prerequisite Check` blocks now automatically strip redundant
    edges, significantly reducing visual clutter and agent prompt bloat.
  - **Hardened Standard Sprint IDs**: Enforced strict **3-digit zero-padding**
    (e.g., `040.1.1`) for all task identifiers to ensure deterministic
    alphanumeric sorting across the sprint lifecycle.
  - **Unique Model Fallbacks**: Implemented a mandatory uniqueness constraint
    for task models. If a manifest provides a single model, the generator now
    automatically assigns a diverse second-choice model from a different family
    (e.g., Claude -> Gemini) to prevent rate-limit deadlocks.
  - **Domain Emoji Accuracy**: Fixed session-to-icon mapping logic to correctly
    align `@repo/api`, `@repo/mobile`, and `@repo/web` workspaces with their
    respective legend tokens.
- **Version Bump**: Incremented project version to `2.11.0`.

## [2.10.0] - 2026-03-31

### Added

- **`sprint-setup` Workflow**: Introduced a new automated workflow to handle
  sprint branch creation and directory initialization, resolving race conditions
  during sprint kickoff.
- **Master Planning Orchestration**: Integrated `sprint-setup` as the first
  mandatory step (Step 0) in the `plan-sprint` orchestrator.

### Changed

- **Standardized Sprint Numbering**:
  - Overhauled `generate-playbook.js` to enforce **3-digit padding** (e.g.,
    `sprint-040`) for all directory paths, task IDs, and branch checkouts.
  - Implemented **Robust Directory Resolution** in the generation script to
    gracefully handle both padded and unpadded directory inputs with automatic
    fallback.
- **Version Bump**: Incremented project version to `2.10.0`.

## [2.9.4] - 2026-03-31

### Changed

- **Automated Protocol Maintenance**:
  - **Submodule Refresh**: Integrated a mandatory `.agents` submodule refresh
    step into the `close-sprint` workflow. The terminal sprint agent will now
    automatically pull the latest protocols from the pinned `dist` branch,
    ensuring consistency and cleaning up phantom Git changes.
  - **Playbook Finalization**: Added a terminal step to `close-sprint` to ensure
    the closure task itself is marked as Complete in the playbook and Mermaid
    diagram, providing a 100% finished artifact.
- **Version Bump**: Incremented project version to `2.9.4`.

## [2.9.3] - 2026-03-31

### Changed

- **Hardened Git & Branch Protocols**:
  - **Naming Enforcement**: Standardized the `sprint-[NUM]/[TASK_ID]` branch
    naming convention in `finalize-sprint-task` with explicit instructions to
    use forward slashes, preventing glob discovery failures.
  - **Self-Cleaning Integration**: Added a mandatory "Self-Cleanup" step to the
    `sprint-integration` workflow to ensure the integration task's own feature
    branch is purged after completion.
  - **End-to-End Orchestration**: Linked the `sprint-testing`,
    `sprint-code-review`, and `sprint-retro` workflows to `finalize-sprint-task`
    to ensure bookend tasks correctly push branches and track status.
  - **Catch-All Branch Audit**: Updated `close-sprint` to perform an aggressive
    remote branch scan that catches and deletes branches using non-standard
    naming conventions (e.g., dash-separated instead of slash-separated).
- **Version Bump**: Incremented project version to `2.9.3`.

## [2.9.2] - 2026-03-31

### Changed

- **Hardened Webhook Notifications**:
  - **Cross-Platform Compatibility**: Standardized the `curl` payload syntax in
    `finalize-sprint-task`, `sprint-integration`, and `close-sprint` workflows
    to ensure reliable execution across Bash and PowerShell/CMD.
  - **Increased Visibility**: Injected mandatory notification steps into the
    `sprint-integration` and `close-sprint` workflows to track major sprint
    milestones.
  - **Failure Auditing**: Requirement for agents to log `WEBHOOK_FAILURE.md` in
    the event of network/configuration errors, preventing silent notification
    drops.
- **Version Bump**: Incremented project version to `2.9.2`.

## [2.9.1] - 2026-03-31

### Changed

- **Harden Playbook Generation Logic**:
  - **Categorization Improvements**: Patched `selectIcon` to explicitly support
    `isCloseSprint` (Ops icon) and prioritized DevOps/Infra keyword matching to
    prevent monorepo "Web" mention false-positives.
  - **Regex Security**: Implemented word-boundary (`\b`) matching for all domain
    keywords to prevent accidental substring hits (e.g., "props" triggering
    "ops").
  - **Dual Model Enforcement**: Every task now guarantees both a **First
    Choice** and **Second Choice** model, with intelligent, mode-aware fallbacks
    (Planning -> Pro Low, Fast -> Flash) if the manifest provides only one.
  - **Visual Refinement**: Updated task headers to use a pipe (`|`) delimiter
    for cleaner separation between Mode, First Choice, and Second Choice models.
  - **Sequential Dependency Logic**: Fixed a bug where tasks in a sequential
    group (e.g., `39.1.2`) were missing their predecessor (`39.1.1`) as a
    mandatory prerequisite in the `AGENT EXECUTION PROTOCOL`.
- **Version Bump**: Incremented project version to `2.9.1`.

## [2.9.0] - 2026-03-31

### Added

- **`devops/git-flow-specialist` Skill**: A comprehensive repository health
  skill that centralizes branch safety, base alignment, and conventional commit
  rules. Includes **Emergency Recovery Protocols** for accidental commits to
  main, unresolved merge markers, and diverged branches.
- **`/close-sprint` Workflow**: A new terminal bookend step that promotes the
  sprint branch to `main`, enforces a completeness gate (all tasks must be
  `[x]`), cleans up sprint branches, and runs a final conflict marker scan.

### Changed

- **Hardened Sprint Generation Pipeline**:
  - Updated `generate-playbook.js` to inject a mandatory **Environment Reset**
    step at the start of every task, forcing base branch alignment (Fix 1).
  - Injected `devops/git-flow-specialist` as a mandatory requirement for all
    Integration and Code Review tasks (Fix 4).
  - Added `isCloseSprint` bookend stage to the generation script and task
    manifest schema, ensuring the close-sprint workflow is automatically wired
    as the final step in every sprint playbook.
- **Workflow Guardrails**:
  - `finalize-sprint-task`: Added a **Branch Guard** to prevent accidental
    pushes to `main` (Fix 2) and explicit base branching (Fix 5).
  - `sprint-integration`: Added a mandatory **Conflict Marker Scan** with
    zero-tolerance for residual `<<<<<<<` markers (Fix 3).
  - `verify-sprint-prerequisites`: Added **Branch Validation** to ensure agents
    are on the correct sprint base (Fix 6).
  - **Pre-Commit Hardening**: Integrated mandatory `npm test` execution into the
    Husky pre-commit hook to match GitHub CI standards and prevent regressions.
- **Skill Retirement**: Retired and removed the
  `architecture/conventional-commits-enforcer` skill (consolidated into
  `git-flow-specialist`).
- **Version Bump**: Incremented project version to `2.9.0`.

## [2.8.1] - 2026-03-31

## [2.8.0] - 2026-03-30

### Added

- **Dynamic Mermaid Legend**: The sprint playbook execution flow diagram now
  includes a categorical legend for chat session icons (🗄️ DB, 🌐 Web, 📱
  Mobile, 🧪 Test, 📝 Docs, 🛡️ Ops, ⚙️ Gen).
- **Mandatory Bookend Validation**: Implemented strict persona and skill
  assertions in `generate-playbook.js` for Integration, QA, Code Review, and
  Retro tasks.

### Changed

- **Redefined Chat Icons**: Simplified the chat session icon set to 6 meaningful
  categories with automatic keyword-based selection logic.
- **Improved Dependency Logic**:
  - Reduced redundant prerequisites for sequential tasks within the same Chat
    Session (Linearized `1 -> 2 -> 3` logic).
  - Automated bookend pipeline wiring (Integration → QA → Code Review → Retro)
    in the Mermaid DAG.
- **Hardened Execution Protocol**: Added node-specific Mermaid class
  instructions (e.g., `set the Mermaid class for node C1`) with idempotency
  hints `(if not already)` to prevent state-tracking ambiguity.
- **Version Bump**: Incremented project version to `2.8.0`.

## [2.7.0] - 2026-03-30

### Added

- **Sprint Retro Action Item Capture**:
  - Mandated the capture of action items identified in retrospectives into the
    `roadmap.md` file to ensure they are tracked.
  - Updated the `sprint-retro` workflow step 4 to include sub-tasks for marking
    completed items and capturing new ones.

### Changed

- **Persona Alignment**: Updated the **Product Manager** persona to explicitly
  own the roadmapping of retro action items.
- **Documentation**: Synchronized `SDLC.md` and `README.md` to reflect the full
  end-to-end retrospective process.
- **Version Bump**: Incremented project version to `2.7.0`.

## [2.6.0] - 2026-03-30

### Added

- **Per-Sprint Branch Protocol**:
  - Implemented a standardized branching model where all sprint tasks occur on
    `sprint-N/chat-session-X` branches.
  - Updated `verify-sprint-prerequisites` and `sprint-integration` to support
    the new branch hierarchy.

### Changed

- **SDLC Hardening**: Refined integration and finalization workflows to enforce
  branch naming consistency and dependency across branches.
- **Version Bump**: Incremented project version to `2.6.0`.

## [2.5.1] - 2026-03-30

### Added

- **Shell & Terminal Protocol (Windows Compatibility)**:
  - Introduced a mandatory protocol for Windows (PowerShell) environments to use
    `;` as a statement separator instead of `&&`.
  - Updated `instructions.md` with Section 2: "Shell & Terminal Protocol
    (Windows Compatibility)".
  - Provided clear examples for command chaining (e.g.,
    `git add . ; git commit -m "..."`).

### Changed

- **Version Bump**: Incremented project version to `2.5.1` across
  `package.json`, `.agents/VERSION`, and documentation.

## [2.5.0] - 2026-03-30

### Added

- **4-State Playbook Status Model**:
  - Expanded sprint playbook tracking from 3 states to 4 states to capture the
    full agent task lifecycle:
    - ⬜ **Not Started** (`- [ ]`, `not_started`) — Task hasn't begun.
    - 🟨 **Executing** (`- [~]`, `executing`) — Agent is actively working.
    - 🟦 **Committed** (`- [/]`, `committed`) — Feature branch pushed, awaiting
      integration.
    - 🟩 **Complete** (`- [x]`, `complete`) — Merged/integrated and verified.
  - Introduced amber Mermaid `classDef executing` styling for the new state.
  - Added **Mark Executing** as the first step in every Agent Execution Protocol
    block, injected by `generate-playbook.js`.

### Changed

- **Breaking: Status Contract Migration**:
  - Renamed Mermaid class `in_progress` to `committed` across all playbook
    artifacts.
  - The `- [/]` marker now means "Committed" (branch pushed) instead of the
    previous "In Progress" interpretation.
  - Updated Mermaid legend to display all 4 states.
- **Workflow Updates**:
  - `finalize-sprint-task`: Now transitions Executing → Committed (4-State
    Track). Added a state progression reference table.
  - `sprint-integration`: Updated to transition Committed → Complete, replacing
    the old `in_progress` → `complete` references.
  - `verify-sprint-prerequisites`: Added explicit state reference table
    clarifying that only `[x]` (Complete) satisfies dependencies.
- **Sample Playbook**:
  - Updated golden sample to showcase all 4 states (C1=complete, C2=committed,
    C3=executing, C4-C7=not_started).

## [2.4.0] - 2026-03-30

### Added

- **Golden SDLC Samples**:
  - Introduced a comprehensive `.agents/sample-docs/` directory containing
    benchmark PRDs, Technical Specs, Roadmaps, and Architecture documents.
  - Included a complete "locked-in" Sprint 001 sample with a functional task
    manifest and playbook.

### Changed

- **SDLC Visualization**:
  - Overhauled the core SDLC Mermaid diagram in `SDLC.md` to a Left-to-Right
    (`LR`) layout to better represent chronological phase transitions.
- **Sprint Test Plan Relocation**:
  - Migrated sprint-specific test plans from
    `docs/test-plans/sprint-test-plans/` to a more contextual
    `docs/sprints/sprint-[##]/test-plan.md` location.
  - Updated the `qa-engineer` persona and `sprint-testing`/`qa-audit` workflows
    to adhere to the new directory structure.
- **Documentation Hardening**:
  - Standardized all internal documentation with relative links, replacing
    absolute file system paths.
  - Updated `README.md` and `SDLC.md` to provide clearer onboarding guidance
    referencing the new "Golden Samples."

## [2.3.2] - 2026-03-30

### Fixed

- **Mermaid Default Styling**:
  - Switched from `style default` to an explicit `classDef not_started` model
    for initial node coloring. This ensures all nodes default to light gray
    without creating orphaned "default" nodes in the diagram.
- **Mermaid Script Robustness**:
  - Updated `generate-playbook.js` to automatically assign the `not_started`
    class to every node upon creation.

## [2.3.1] - 2026-03-30

### Fixed

- **Webhook Notification Format**:
  - Refined the `finalize-sprint-task` workflow to explicitly require a JSON
    payload with a `message` parameter, ensuring compatibility with Make.com
    webhooks.

### Changed

- **UI Simplification**:
  - Removed redundant "💬" chat emoji from Chat Session headers and Mermaid
    diagram labels for a cleaner, professional look.

## [2.3.0] - 2026-03-30

### Added

- **Feature Branching & 3-State Tracking**:
  - Implemented a zero-conflict Git orchestration model using isolated feature
    branches for concurrent Chat Sessions.
  - Introduced **3-State Playbook Tracking**: Tasks now transition from Pending
    (`- [ ]`) to Pushed/Ready (`- [/]`) and finally to Complete (`- [x]`).
  - Added **Real-time Progress Visualization**: Automated blue (`in_progress`)
    and green (`complete`) highlighting for Mermaid diagram nodes in the
    playbook.
- **Sprint Integration Workflow**:
  - Added a new automated `isIntegration` bookend task that merges feature
    branches and performs bulk playbook state synchronization before QA.

## [2.2.1] - 2026-03-30

### Added

- **Strict Dependency Rules**:
  - Updated JSON Schema and workflow documentation to strictly mandate
    direct-only dependencies, preventing transitive bloat in the playbook.
- **Bookend Optimization**:
  - Added persona and skill guidance specifically for the automated QA, Code
    Review, and Sprint Retrospective bookend sessions.

## [2.2.0] - 2026-03-30

### Added

- **Explicit Dependency Injection**:
  - The playbook generation script now deterministically tracks dependent task
    numbers and injects them precisely into the `AGENT EXECUTION PROTOCOL`.
  - Added a self-referencing `Playbook Path` header to the top of every
    generated playbook for easier agent discovery.
- **Dynamic Prerequisite Logic**:
  - Tasks with no dependencies now automatically omit the "Prerequisite Check"
    step to streamline execution prompts.
- **Expanded Bookend Tracking**:
  - Split the "Code Review & Retro" session into two dedicated Chat Sessions:
    `Code Review` (Sequential) and `Sprint Retrospective` (PM-led, always last).

### Changed

- **Workflow Simplification**:
  - Moved detailed dependency verification logic into the
    `verify-sprint-prerequisites` workflow, reducing prompt bloat in the
    playbook.
  - Added repository `scope` annotations to Sequential sessions (not just
    Concurrent ones) to ensure clear boundary enforcement.
  - Manifest schema now allows omitting `instructions` for bookend tasks (QA,
    Review, Retro) since they use auto-injected workflow commands.
- **Topological Sorting Improvements**:
  - Dependencies are now sorted numerically in task prompts for better
    scannability.

## [2.1.1] - 2026-03-30

### Added

- **Graceful "Technical Chore" Fallbacks**:
  - Updated `prd-template.md` and `technical-spec-template.md` to officially
    support `(N/A - Technical Operations Chore)` or `None required` for purely
    technical/backend sprints. This prevents LLM hallucinations in non-UI tasks.

### Changed

- **Strict Playbook Formatting**:
  - Updated `task-manifest.schema.json` to mandate `\n-` markdown list
    formatting for task instructions.
  - Updated `generate-sprint-playbook` workflow to enforce bulleted instruction
    scoping for better agent readability.
- **Robust Path Handling**:
  - Fixed `generate-playbook.js` to preserve leading zeros in sprint numbers
    (e.g., `037`) when resolving directory paths.

## [2.1.0] - 2026-03-30

### Added

- **Script-Assisted Playbook Generation**:
  - Introduced `.agents/scripts/generate-playbook.js`, a deterministic Node.js
    script to generate sprint playbooks from a structured JSON manifest.
  - Introduced `.agents/schemas/task-manifest.schema.json` to define the
    contract for playbook generation.
  - Updated `generate-sprint-playbook` workflow to use the new two-phase
    generation pipeline (JSON manifest output -> script execution).
  - Added automated topological sorting for task dependencies and intelligent
    chat session grouping by workspace scope.
  - Added comprehensive unit tests for the playbook generation logic.

### Changed

- **Submodule Distribution Alignment**: Moved the playbook generation script
  into the `.agents/` directory to ensure it is correctly distributed to
  consumer projects via git submodules.
- **Workflow Improvements**: Updated `generate-sprint-playbook` and
  `sprint-playbook-template` to support the new generation model and provide
  better execution rule guidance.

## [2.0.0] - 2026-03-29

### Major Architectural Overhaul

- **Persona Expansion (12-Role Architecture)**:
  - Expanded from 4 to 12 specialized personas to eliminate role conflation:
    `architect`, `engineer`, `engineer-web`, `engineer-mobile`, `product`,
    `ux-designer`, `qa-engineer`, `devops-engineer`, `sre`, `security-engineer`,
    `technical-writer`, and `project-manager`.
  - **Automatic Referral Protocol**: Standardized **Scope Boundaries** across
    all personas, enabling agents to automatically detect out-of-scope tasks and
    switch to the appropriate persona without user intervention.

- **Structured Configuration Centralization**:
  - Created a dedicated `.agents/config/` directory to house all JSON
    configuration files.
  - **Model Selection (`.agentrc.json`)**: Extracted model tiers and chaining
    logic for better maintainability.
  - **Tech Stack (`.agentrc.json`)**: Extracted all project-specific technology
    references (ORM, DB, API, UI, etc.) to ensure protocol portability across
    different tech stacks.
  - **Agent Config (`.agentrc.json`)**: Centralized operational limits and
    auto-run permissions.

- **Expanded Sprint Lifecycle**:
  - Introduced mandatory **Sprint Code Review** (Chat Session 5) and **Sprint
    Retrospective** (Chat Session 6) into the core workflow.
  - Added 6 new internal sprint workflows: `gather-sprint-context`,
    `verify-sprint-prerequisites`, `finalize-sprint-task`, `sprint-testing`,
    `sprint-code-review`, and `sprint-retro`.

- **Generic & Portable Templates**:
  - Refactored `technical-spec-template.md` and `prd-template.md` to be
    tech-agnostic, dynamically pulling project details from `.agentrc.json`.
  - Standardized `Output Artifacts` sections across all personas for consistent
    artifact ownership.

### Documentation

- **README Overhaul**: Updated `.agents/README.md` and root `README.md` to
  reflect the new 12-persona structure, categorized workflows table, and
  centralized config folder.

## [1.13.5] - 2026-03-29

### Workflow Enhancements

- **Agent Notification Webhook**:
  - Updated the `generate-sprint-playbook` workflow to include a mandatory
    notification step in the `AGENT EXECUTION PROTOCOL`.
  - Agents will now attempt to call a webhook URL defined as
    `AGENT_NOTIFICATION_WEBHOOK` in the `AGENTS.md` file upon completing a
    sprint step.
  - Implemented graceful failure logic if the variable is not set.

## [1.13.4] - 2026-03-29

### Workflow Enhancements

- **Enhanced Model Selection Guidance**:
  - Overhauled the `generate-sprint-playbook` workflow with detailed model
    personas (Architects, Workhorses, Sprinters, Specialists).
  - Introduced explicit **Planner-Executor-Reviewer** chaining logic to optimize
    agentic performance across Claude 4.6 and Gemini 3.1 models.
  - Added specific guidance for utilizing **Opus (Thinking)** as an escalation
    model and **Flash** for the "inner loop" of development.

## [1.13.3] - 2026-03-28

### Workflow Enhancements

- **Standardized Sprint Retrospectives**:
  - Introduced `.agents/templates/sprint-retro-template.md` to ensure
    consistent, metric-driven retrospectives.
  - Updated the `generate-sprint-playbook` workflow (via
    `sprint-playbook-template.md`) to explicitly mandate retro generation using
    the new template.
  - Standardized retro sections for Scorecard, Architectural Debt, and Action
    Items.

## [1.13.2] - 2026-03-27

### Workflow Enhancements

- **Sprint Test Plan Customization**: Updated `generate-sprint-playbook` to
  ensure sprint-specific test plans are stored in the
  `test-plans/sprint-test-plans/` folder instead of the generic
  `docs/test-plans/` directory.
- **Improved QA Persona Alignment**: Enhanced the QA Automation Engineer persona
  instructions to strictly use sprint-numbered test plan filenames.

## [1.13.1] - 2026-03-27

### Workflow Enhancements

- **Audit Output Standardization**: Standardized all audit workflows to append
  `-results.md` to their output filenames (e.g., `sre-audit-results.md`,
  `accessibility-audit-results.md`).
- **Improved Contextual Clarity**: Updated documentation to reflect these new
  output patterns, ensuring agents produce consistently named artifacts across
  all audit types.

## [1.13.0] - 2026-03-27

### Protocol Refinements

- **Concurrent Sprint Prerequisite Logic**:
  - Overhauled the `generate-sprint-playbook` workflow to correctly handle
    Fan-Out (concurrent) chat sessions.
  - Replaced the ambiguous "previous chats" check with explicit mandatory
    dependency lists in task templates.
  - Updated the `AGENT EXECUTION PROTOCOL` to eliminate out-of-order execution
    blocks in parallel development tracks (e.g., Web vs. Mobile).

## [1.12.0] - 2026-03-26

### Protocol Hardening

- **Improved Sprint Playbook Generation**:
  - Moved the `AGENT EXECUTION PROTOCOL` to the top of task blocks for improved
    agent visibility and adherence.
  - Introduced a mandatory **Sample Data Maintenance** step for Chat Session 4
    (QA) to ensure dev data (seeds, mocks) stays in sync.
  - Strengthened protocol language to strictly enforce prerequisites and state
    updates.

## [1.11.0] - 2026-03-26

### Refinements & Standardization

- **Audit Workflow Harmonization**: Synchronized 7 new audit workflows with the
  standardized `devops-audit` and `qa-audit` structure. All audits now include
  mandatory Dimension/Category, Impact, Current State, Recommendation, and
  copy-pasteable **Agent Prompts** for safe remediation.
- **Improved Read-Only Guardrails**: Reinforced the non-mutating nature of audit
  workflows to ensure purely diagnostic behavior.

### Fixes

- **ESLint Compliance**: Resolved `no-console` warnings in the `athlete-portal`
  scripts (specifically `self-healing-agent.ts`) that were blocking Husky
  pre-commit hooks.

## [1.10.0] - 2026-03-26

### Workflow Enhancements

- **Audit & Automation Expansion**: Introduced 7 new comprehensive workflows:
  - `privacy-audit`: Data privacy and PII compliance checking.
  - `clean-code-audit`: Maintainability and technical debt analysis.
  - `security-audit`: Vulnerability scanning and OWASP alignment.
  - `performance-audit`: Deep architectural and stack-wide bottleneck analysis.
  - `generate-release-notes`: Automated synthesis of git commits into
    user-facing changelogs.
  - `dependency-update-audit`: Security and bloat auditing for modern package
    managers.
  - `ux-ui-audit`: Design system consistency and UX best-practice reviews.

### Domain Skills

- **Ecosystem Expansion**: Added 14 new foundational skills to the
  `.agents/skills/` directory:
  - **Frontend**: `astro`, `tailwind-v4`, `google-analytics-v4`.
  - **Backend**: `cloudflare-workers`, `turso-sqlite`, `clerk-auth`,
    `stripe-payments`, `highlevel-crm`.
  - **QA**: `vitest`, `playwright`, `accessibility-audit`.
  - **Architecture**: `subagent-orchestration`, `structured-output-zod`,
    `markdown`.

## [1.9.0] - 2026-03-25

### Workflow Enhancements

- **Hardened Test Execution**: Updated `run-test-plan` workflow to prevent
  repository mutations:
  - Mandated the creation of a local `*-RESULTS.md` copy for all test results
    instead of inline updates to original files.
  - Explicitly prohibited automatic commits, staging, or check-ins of test
    results or temporary scripts.
  - Enforced strict local-only persistence for artifact review.

## [1.8.0] - 2026-03-25

### Workflow Enhancements

- **Protocol & Formatting Hardening**: Overhauled `generate-sprint-playbook` to
  enforce strict output standards:
  - Introduced the **"No Outer Wrapper"** rule, mandating raw Markdown output
    instead of fenced code blocks for the entire playbook.
  - Implemented the **"No-Summarization Rule"** to ensure the
    `AGENT EXECUTION PROTOCOL` is copied word-for-word into every task without
    modification.
  - Standardized **Chat Session Headers** with sequence indicators and icons.
  - Integrated a required **Mermaid diagram** into the playbook template to
    visualize the Fan-Out architecture.
  - Refined task scoping and template structure for improved agent readability.

## [1.7.0] - 2026-03-25

### Workflow Enhancements

- **Integrated QA Lifecycle**: Hardened `generate-sprint-playbook` by coupling
  test plan generation with execution:
  - Mandated a dedicated Chat Session (Session 4) for updating
    `docs/test-plans/*.md` with new features before running them.
  - Expanded the **QA Automation Engineer** persona to include manual test plan
    authoring and documentation tasks.
  - Defined explicit **Dual-Purpose Testing** standards (semantic locators and
    SQL assertions) for robust validation.
  - Refined model routing to prefer **Claude Sonnet 4.6 (Planning)** for
    producing high-quality QA documentation.

## [1.6.0] - 2026-03-25

### Workflow Enhancements

- **Fan-Out Architecture**: Overhauled `generate-sprint-playbook` with a robust
  multi-agent orchestration model:
  - Introduced explicit Chat Session modeling (Backend, UI, QA, Retro) for
    parallelized agent execution and data contract locking.
  - Added strict Model Routing and Persona Assignment rules to optimize for
    specialized task execution.
  - Implemented a mandatory `Agent Execution Protocol` within task templates to
    enforce dependency checking, state updates, and hook-based validation.
  - Standardized QA tasks to leverage existing test plans via `/run-test-plan`
    instead of ad-hoc test generation.

## [1.5.0] - 2026-03-25

### Core Improvements

- **Sprint Playbook Checks**: Introduced mandatory prerequisite validation and
  final sprint audits:
  - Added `PREREQUISITE CHECK` to all playbook task templates to prevent
    out-of-order execution.
  - Added `FINAL SPRINT AUDIT` to the retro workflow to verify completion
    against PRDs.
  - Updated `generate-sprint-playbook` to explicitly list task dependencies.
- **Update Documentation**: Restored comprehensive submodule update strategies
  (Bash, PowerShell, and `package.json`) to the root `README.md` and
  de-duplicated the `.agents/README.md` user guide.

## [1.4.1] - 2026-03-25

### Fixes

- **Slash Command Discovery**: Flattened the `workflows/` directory back to the
  root level. This restores native Antigravity IDE auto-registration for all `/`
  commands which was inadvertently broken by subdirectory categorization in
  v1.3.0.
- **CI/CD Validation**: Hardened the `dist` branch publication process to
  strictly validate the presence of the new `rules/` and `.agentrc.json` files.

## [1.4.0] - 2026-03-25

### Core Improvements

- **Modular Global Rules**: Introduced the `.agents/rules/` directory containing
  foundational, domain-agnostic standards:
  - `git-conventions.md`: Conventional Commits and branch naming.
  - `api-conventions.md`: JSON formatting, error shapes, and status codes.
  - `testing-standards.md`: Arrange-Act-Assert patterns and naming.
  - `database-standards.md`: Naming conventions and soft-deletion policies.
  - `security-baseline.md`: Zod validation and PII protection.
  - `ui-copywriting.md`: Sentence case and empathetic tone guidelines.
- **Local Overrides**: Added support for `.agents/instructions.local.md` and
  `config.local.json` to allow personal developer preferences.
- **Structured Config**: Introduced `.agents/.agentrc.json` for programmatic
  agent guardrails.

### Documentation

- **User Guide Updates**: Documented the new rules and localization features in
  `.agents/README.md`.
- **System core**: Updated `instructions.md` to bootstrap the new rules and
  config system.

## [1.3.0] - 2026-03-25

### Core Improvements

- **Structural Organization**: Categorized all `skills` (into `frontend`,
  `backend`, `security`, `qa`, `architecture`) and `workflows` (into `audits`,
  `sdlc`, `testing`) to support future expansion.

### Documentation

- **User Guide Updates**: Overhauled `.agents/README.md` with new directory
  structures and categorized tables for skills and workflows.
- **Instructional Updates**: Updated `.agents/instructions.md` to support the
  new categorized skill paths.

## [1.2.0] - 2026-03-25

### Documentation

- **Personal Stack**: Added details on the agent-first personal development
  stack (Google AI Ultra, Antigravity IDE, Wispr Flow) in the root `README.md`.

## [1.1.1] - 2026-03-25

### Core Improvements

- **Workflow Renaming**: Standardized sprint planning workflows from `plan-*` to
  `generate-*` for clarity.
- **Git Integration**: Added mandatory git commit steps to all sprint playbook
  tasks to ensure progress is saved and pre-commit hooks are enforced.

## [1.1.0] - 2026-03-25

### Key Improvements

- **Automated Sprint Planning**: Restructured `SDLC` folder into automated
  `/plan-sprint` workflows.
- **Consolidated Instructions**: Merged `system-prompt.md` into
  `instructions.md` for a single system core.
- **Streamlined Structure**: Flattened `.agents/` directory by moving templates
  to root.

## [1.0.0] - 2026-03-25

### Initial Release

- **Initial Stable Release**: Standardized Agent Protocols for LLM-based coding
  assistants.
- **Global Instructions**: Foundational rules for context-first, plan-first, and
  security-first agent behavior.
- **Persona System**: Role-specific constraints for AI agents (Architect,
  Engineer, Product, SRE).
- **Domain Skills**: Modular tech-stack guardrails (SQLite/Drizzle, Cloudflare
  Workers, Astro, Expo, etc.).
- **SDLC Workflows**: Standardized sprint planning, PRD, and technical spec
  templates.
- **Slash Command Audits**: Integrated workflows for accessibility,
  architecture, devops, and SRE reviews.
- **Consumer Distribution**: Submodule-based delivery via the `dist` branch.
- **Cross-Platform Support**: Added PowerShell compatibility for manual
  submodule update commands.

---

## Appendix: Version History Summaries (from roadmap.md)

The following summaries were previously maintained in `docs/roadmap.md` and are
archived here for historical reference.

### Version 4.x — Autonomous Efficiency & Scalability

- ✅ **Agentic Plan Caching (APC):** Test-time memory architecture to extract
  structured intent from successful executions, bypassing expensive generative
  dependencies for semantically similar tasks.
- ✅ **Speculative Execution & Cache-Aware Scheduling:** Global prompt cache
  mapping deterministic operation inputs to previously computed outputs.
- ✅ **Perception-Action Event Stream:** Decoupled core logic from the
  environment via an event-stream abstraction where agents read history and
  produce atomic actions.
- ✅ **Isolated Multi-Agent Parallelization**: Eliminated Git lock race
  conditions during concurrent executions via `git worktree` isolation.
- ✅ **Strict Workflow Patterns**: Integrated Evaluator-Optimizer and Prompt
  Chaining pattern enforcement into the core orchestration loop.
- ✅ **Cryptographic Provenance:** Digitally signed agent-generated test
  receipts via asymmetric PKI for immutable chain of custody.
- ✅ **Universal Protocol Standardization:** Merged all agent configuration into
  a unified `.agentrc.json` standard at the project root.

### Version 3.x — Optimization & Refinement

- ✅ **Exploratory Testing Integration**: Enhanced `sprint-testing` with
  mandatory exploratory step and configurable command.
- ✅ **Context Caching Prompt Architecture**: Restructured playbook execution
  prompts to separate static rules from volatile task state for LLM API caching.
- ✅ **Automated Context Pruning ("Gardener")**: Background archiving workflow
  to curate stale patterns into `docs/archive/`.
- ✅ **Dynamic Context Boundaries (Local RAG)**: Zero-dependency TF-IDF engine
  for semantic retrieval and context gathering.
- ✅ **FinOps & Token Budgeting**: `maxTokenBudget` with soft-warning and
  hard-stop protocols.
- ✅ **Zero-Touch Remediation Loop**: Automatic transition from failed
  integration to hotfix loop.
- ✅ **Dynamic Golden-Path Harvesting (Agentic RLHF)**: Automated harvesting of
  zero-friction instruction-to-diff mappings for few-shot prompt reinforcement.
- ✅ **Semantic Risk & Blast-Radius Gates**: AI-driven semantic classification
  of destructive operations and architectural anomalies.
- ✅ **Adversarial Red-Teaming (Tribunal)**: On-demand `/run-red-team` workflow
  for high-assurance code hardening.
- ✅ **Self-Healing Protocols (Retro-Augmentation)**: Agent-ready optimization
  snippets generated from friction logs.
- ✅ **Granular HITL Gates**: `riskGates` keyword scanning during planning for
  mandatory human approval.
- ✅ **Global Telemetry Reporting (Observer MVP)**: `aggregate-telemetry.js` for
  structured macroscopic reports on efficiency and tool failures.

### Version 2.x — Continuous Evolution

- ✅ **Hybrid Integration & Blast-Radius Containment**: Ephemeral integration
  candidates and `/sprint-hotfix` workflows.
- ✅ **Advanced Concurrency Protocols**: `focusAreas` for static prediction of
  high-risk file overlaps and runtime rebase wait-loop.
- ✅ **Shift-Left Agentic Testing**: Pre-merge testing on feature branches with
  cryptographic-like test receipts.
- ✅ **Decoupled Task State Tracking**: Migrated from Git-tracked playbook
  checkmarks to decoupled JSON state files.
- ✅ **Passive Telemetry & Diagnostic Tools**: `diagnose-friction.js` for
  failing command interception and auto-remediation.
- ✅ **Framework Handshakes**: Hardened personas to explicitly require ruleset
  ingestion before code execution.

### Version 1.x — Foundations

- ✅ **Core Architecture**: Standardized framework including Global
  Instructions, Persona constraints, and domain-specific Skills.
- ✅ **Automated Sprint Planning Pipeline**: Deterministic generation of PRDs,
  Technical Specs, and Playbooks via slash commands.
- ✅ **Fan-Out Orchestration**: Multi-agent parallel execution via distinct Chat
  Sessions.
- ✅ **Modular Global Rules**: Domain-agnostic standards for Git, APIs,
  databases, and UI copywriting.
- ✅ **Submodule Distribution**: `dist` branch mechanism for consumer
  consumption.
