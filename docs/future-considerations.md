# Future Model Audit: Mandrel Under a 10x Coding Model

Date: 2026-05-17 (last reviewed 2026-05-19)

> **Action legend.** Each finding below carries one of two action tags:
>
> - 🚀 **Implement now** — an obvious win or high-value cleanup that pays
>   off under today's models. Schedule it like any other backlog item.
> - 🔭 **Monitor** — primary motivation is a materially stronger model.
>   Park it until the next model-tier release moves the cost/benefit,
>   then re-evaluate.
>
> Findings already shipped between the audit date and the last-reviewed
> date are collapsed into the "Implemented Since Audit" section near the
> end and removed from the numbered list.

## Executive Summary

This audit assumes a new coding model is roughly 10x as capable as the best
models available today: materially better at long-context reasoning, planning,
multi-file implementation, tool use, structured output, and self-review. Under
that assumption, Mandrel should become less of an instruction cage and more of a
thin orchestration harness around durable external guarantees.

The highest-value parts of Mandrel remain useful because they do not compensate
for model weakness. They provide independent guarantees:

- GitHub Issues, Labels, Projects, branches, pull requests, and status checks as
  an external source of truth.
- Deterministic schemas, validators, branch protections, and CI gates.
- Worktree or sandbox isolation for concurrent edits.
- Lifecycle ledgers and structured comments for resumability, auditability, and
  operator visibility.
- Security, testing, and release policies that express human risk tolerance.

The parts most likely to become obsolete or restrictive are the procedural
prompt scaffolds that micromanage how an agent thinks or reports:

- Repeated STOP/HITL rituals for normal planning quality review.
- Hard limits on instruction steps, ticket counts, and artificial decomposition
  size.
- Heavy persona/skill prose loaded as context instead of compact policy.
- Strict sub-agent return parsing repair code written around weak structured
  compliance.
- Audit fan-out and code-review rituals that replicate what a stronger model or
  native IDE feature could perform in one pass.
- Compatibility shims, legacy config aliases, and model-specific workflow prose
  that make the harness feel larger than the guarantees it provides.

Recommendation: evolve Mandrel toward a **policy-and-state kernel**. Keep the
deterministic scripts, schemas, state transitions, ledgers, branch protections,
quality gates, and external audit trail. Compress prompt documents into concise
policies. Make planning, decomposition, review, and audit depth adaptive by
risk and scope instead of fixed ceremony.

## Review Lens

I classified surfaces into four categories:

- **Keep**: Still useful even with very strong models because it protects
  external state, security, concurrency, reproducibility, or human governance.
- **Simplify**: Still useful, but much lighter with a stronger model.
- **Retire**: Exists mainly to patch current model weaknesses and should be
  removed or made optional.
- **Reframe**: Keep the capability, but change its role from procedural
  instruction to declarative policy or machine-validated contract.

## High-Confidence Findings

### 1. Prompt and Instruction Surface Is Too Procedural

**Status:** Simplify / Reframe
**Action:** 🔭 Monitor — today's models still rely on this procedural scaffold; the right time to compress is when the model can self-select context.

**Primary paths:**

- `.agents/instructions.md`
- `.agents/personas/*.md`
- `.agents/skills/core/*/SKILL.md`
- `.agents/skills/stack/*/*/SKILL.md`
- `.agents/templates/agent-protocol.md`

Mandrel currently encodes a large amount of behavioral process in prose:
persona routing, skill discovery, context-reading rituals, anti-thrashing,
FinOps, branch hygiene, testing discipline, and workflow-specific STOP rules.
This is appropriate for current models, but a 10x model should need fewer
step-by-step reminders and more compact, authoritative policy.

Recommended direction:

- Keep a short global policy file for non-negotiables.
- Keep domain rules as canonical references, but compress them into checkable
  constraints where possible.
- Treat skills as optional playbooks, not mandatory context blocks for every
  related task.
- Prefer machine-readable metadata for when a skill applies, instead of asking
  the model to read and self-select large markdown files.

Specific simplifications:

- Retire hard prose like "MUST read every context file before any task" in favor
  of a scoped context contract: required artifacts by task type, with a
  validator that confirms the context envelope was built.
- Collapse overlapping guidance between instructions, personas, skills, rules,
  and workflow helpers.
- Replace "STOP and ask" defaults with risk-based escalation. A stronger model
  can proceed on narrow, reversible assumptions and document them.
- Keep security and destructive-action constraints strict; these represent
  operator risk appetite, not model capability.

### 2. Persona Files Become Advisory, Not Routing-Critical

**Status:** Simplify
**Action:** 🔭 Monitor — persona injection still measurably reduces role drift on current models.

**Primary paths:**

- `.agents/personas/engineer.md`
- `.agents/personas/architect.md`
- `.agents/personas/project-manager.md`
- `.agents/personas/qa-engineer.md`
- `.agents/personas/security-engineer.md`
- `.agents/personas/technical-writer.md`

Personas compensate for current models drifting between roles. A much stronger
model can infer the role from the task, repository, and artifact being edited.
The persona files remain useful as review lenses, but their current automatic
referral and scope-policing behavior will likely feel restrictive.

Recommendation:

- Convert personas into concise review checklists or role lenses.
- Stop injecting full persona prose into execution prompts by default.
- Keep explicit persona labels for audit/review assignment, not for every
  implementation task.
- Preserve security and release personas as optional high-risk review modes.

### 3. Skill Library Should Become a Capability Index Plus Compact Policies

**Status:** Simplify / Reframe
**Action:** Split in two:
- 🚀 **Implement now** — generate a `skills.index.json` manifest (or
  frontmatter-only index) and add a 5-12 bullet "policy capsule" to each
  `SKILL.md`. Pure tooling that helps current models too: cheaper
  selection and faster hydration. No behavioral change to the runtime.
- 🔭 **Monitor** — actually changing the hydrator to *stop* loading full
  skill bodies by default, and to route skill selection through the
  manifest. Waits until the model can self-select context confidently.

**Primary paths:**

- `.agents/skills/core/`
- `.agents/skills/stack/`
- `.agents/README.md`
- `.agents/scripts/lib/orchestration/context-hydration-engine.js`

The skill split between deterministic scripts and prompt+judgment is sound. The
problem is payload size and repeated procedural instruction. A 10x model will
not need long explanations of TDD, debugging, code review, frontend
accessibility, or common stack patterns on every task.

Recommendation:

- Keep `SKILL.md` files as human-readable docs, but generate a compact
  `skills.index.json` or frontmatter-only manifest for runtime selection.
- Add a "policy capsule" to each skill: 5-12 enforceable bullets plus links to
  deeper examples.
- Avoid hydrating entire skills into task prompts unless the task is high-risk
  or the user explicitly asks for the full playbook.
- Move stack-specific non-negotiables into validators or lint checks where
  feasible.

### 4. Planning Flow Has Too Many Fixed HITL Gates

**Status:** Simplify
**Action:** 🚀 Implement now — risk-based gating is valuable regardless of model strength. Phase 7 cross-validation (aec99d1c) and explicit `filesAssumption` (fda76f21) already moved in this direction; the remaining work (collapse idea refinement / clarity / Epic rendering into one proposal step, convert `maxTickets` from hard cap to reviewability budget) is operator-experience cleanup.

**Primary paths:**

- `.agents/workflows/epic-plan.md`
- `.agents/workflows/helpers/epic-plan-spec.md`
- `.agents/workflows/helpers/epic-plan-decompose.md`
- `.agents/SDLC.md`
- `.agents/scripts/epic-plan-spec.js`
- `.agents/scripts/epic-plan-decompose.js`
- `.agents/skills/core/epic-plan-spec-author/SKILL.md`
- `.agents/skills/core/epic-plan-decompose-author/SKILL.md`

The planning workflow currently has multiple mandatory confirmation points:
idea refinement, duplicate review, rendered Epic body, clarity rewrite, PRD /
Tech Spec / Acceptance Spec review, decomposition, and handoff. A 10x model
should produce a coherent plan and decomposition in fewer passes.

Keep:

- Durable PRD, Tech Spec, and Acceptance Spec artifacts for non-trivial Epics.
- Schema validation before GitHub persistence.
- Duplicate search, but as a background warning with confidence scores.
- Declarative `epic.yaml` and reconcile semantics for re-planning.

Simplify:

- Combine idea refinement, clarity scoring, and Epic body rendering into one
  model-authored plan proposal step.
- Make the PRD / Tech Spec / Acceptance Spec review gate risk-based. Require
  operator confirmation for high-risk, public API, data migration, security, or
  billing work; auto-proceed for small, reversible, low-risk changes.
- Preserve the three linked planning artifacts, but allow single-shot authoring
  followed by scripted split and validation.
- Reconsider `maxTickets` as a hard model-output cap. It should become a
  reviewability budget with explicit override, not a decomposition rule.

### 5. Four-Tier Ticket Hierarchy Is Often Overhead

**Status:** Simplify / Reframe — largely covered
**Action:** 🚀 Re-evaluate, then likely close — `/single-story-plan` and
`/single-story-deliver` already provide the lightweight "Story mode" rung
this finding called for. The only open question is whether a still-lighter
"Patch" rung (one issue → one branch → one PR, no Story scaffold) is worth
adding, or whether the single-story pair already covers that workload in
practice. Evaluate against recent single-story usage before opening a new
issue; if the existing pair is sufficient, mark this finding implemented.

**Primary paths:**

- `.agents/SDLC.md`
- `.agents/workflows/epic-plan.md`
- `.agents/scripts/lib/orchestration/ticket-validator.js`
- `.agents/scripts/lib/orchestration/ticket-validator-sizing.js`
- `.agents/schemas/epic-spec.schema.json`

The Epic -> Feature -> Story -> Task hierarchy is valuable for large,
parallelizable initiatives, but too heavy as a universal default. A 10x model
can maintain larger intent and implementation scope without needing every idea
split into small atomic tickets.

Recommendation:

- Introduce adaptive planning modes:
  - **Patch**: one issue, one branch, one PR.
  - **Story**: one Story with structured tasks.
  - **Epic**: full Feature / Story / Task hierarchy.
- Let the planner choose the mode, then validate it against risk, estimated
  file count, dependency count, and expected parallelism.
- Keep DAG validation and dependency parsing for Epic mode.
- Avoid forcing docs-only and refactor-only work through the full acceptance
  spec and hierarchy machinery.

### 6. Per-Task Ritual and Commit Strategy Can Relax

**Status:** Simplify
**Action:** 🔭 Monitor — per-Task granularity is currently load-bearing for resume/bisect. Relaxing depends on stronger holistic-edit coherence in future models.

**Primary paths:**

- `.agents/workflows/story-deliver.md`
- `.agents/workflows/helpers/task-execute.md`
- `.agents/scripts/task-commit.js`
- `.agents/scripts/story-task-progress.js`
- `.agents/scripts/story-close.js`

Strict one-commit-per-Task maximizes resume and bisect granularity, but it also
multiplies churn. Stronger holistic editing may justify fewer commits per Story
while keeping Story-level boundaries and close validation.

Recommendation:

- Add an optional Story-level commit strategy when Tasks are tightly coupled.
- Keep branch assertions, conventional commit checks, and close validation.
- Replace always-on per-Task preview checks with once-per-Story or
  diff-threshold-triggered previews.

### 7. Sub-Agent Return Repair Can Shrink Substantially

**Status:** Simplify
**Action:** 🔭 Monitor — repair heuristics exist because current sub-agents still produce malformed envelopes. Re-evaluate once structured-output compliance is rock-solid in the next tier.

**Primary paths:**

- `.agents/scripts/lib/orchestration/epic-runner/sub-agent-return.js`
- `.agents/scripts/lib/orchestration/wave-record-projection.js`
- `.agents/scripts/epic-execute-record-wave.js`
- `.agents/workflows/epic-deliver.md`
- `.agents/workflows/story-deliver.md`

The sub-agent return parser exists because current sub-agents sometimes return
plain prose, partial status, or malformed JSON after doing real work. A much
stronger model with robust structured-output compliance makes much of this
repair layer less important.

Keep:

- Schema validation of returned envelopes.
- Conservative reconciliation from GitHub state when a child result is missing
  or inconsistent.
- Friction reporting when a child violates the contract.

Simplify:

- Replace free-form JSON extraction heuristics with a single structured-output
  contract.
- Treat malformed terminal returns as rare protocol errors rather than a normal
  recovery path.
- Reduce chat relay instructions when the canonical progress surface is already
  a structured comment.

### 8. Audit Suite Is Over-Decomposed for a Stronger Model

**Status:** ✅ Fully implemented (Epic #2586, commit 3e7937b4). The
`audit-fan-out` workflow and slash-command are retired; `select-audits.js` +
`audit-orchestrator.js` now select relevant lenses from changed files and
risk. `/audit-to-stories` (e4ab4227) aggregates findings into Stories. The
model-name enum softening called out in the original recommendation is
covered separately under Finding #10's "Soften" list. See "Implemented
Since Audit" at the bottom of this doc.

### 9. Code Review Should Become Evidence-First, Not Ritual-First

**Status:** Reframe
**Action:** 🔭 Monitor — adaptive review-depth selection is most valuable once the model can reliably judge "this diff is risky." Keep the structured `code-review` comment contract as-is until then.

**Primary paths:**

- `.agents/workflows/helpers/epic-code-review.md`
- `.agents/scripts/epic-code-review.js`
- `.agents/scripts/lib/orchestration/code-review.js`
- `.agents/skills/core/code-review-and-quality/SKILL.md`

The current code-review helper asks the model to walk review pillars and produce
severity-grouped findings. That remains a good review shape, but the future
harness should avoid forcing every Epic through identical prose when the model
can infer the right review depth.

Recommendation:

- Keep the structured `code-review` comment as an artifact.
- Keep blocking on critical security, data loss, and broken functionality.
- Make review depth adaptive: tiny docs-only change, light review; shared
  runtime or security change, deep multi-axis review.
- Let the future model perform review directly, then validate that required
  sections, severities, and changed-file coverage exist.

### 10. Quality Gates Remain Load-Bearing

**Status:** Keep
**Action:** 🚀 Implement now (the "Soften" sublist only) — replacing closed model-name enums (`haiku | sonnet | opus`) with open capability tiers, and removing magic-number compact-vs-pretty ratio assertions, are obvious cleanup wins today. d1f1eaff partially addressed model-name daylight; finish the job. The "Keep" gates stay untouched.

**Primary paths:**

- `package.json`
- `.github/workflows/ci.yml`
- `.husky/pre-push`
- `.agentrc.json`
- `docs/quality-gates.md`
- `docs/baselines.md`
- `.agents/scripts/check-baselines.js`
- `.agents/scripts/run-tests.js`
- `.agents/scripts/run-lint.js`
- `.agents/scripts/check-lifecycle-lint.js`
- `tests/`
- `baselines/`

Stronger models do not remove the need for independent verification. Lint,
format, tests, coverage, maintainability, CRAP, lifecycle lint, branch
protection, dependency audit, secret scanning, and CI checks are still useful
because they are objective and repeatable.

Keep:

- CI security scans, including dependency audit and secret scanning.
- Lint and format checks for the distributed `.agents/` bundle.
- Unified baselines, coverage-driven CRAP, maintainability, and schema/kernel
  checks.
- JSON-on-stdout contracts for `--emit-context` CLIs.
- Dist publish structural checks.
- Preflight checks that prevent running tests in known-bad repo states.
- Secret-redaction tests for ledgers, journals, and CLI output.

Soften:

- Strict model-name enums like `haiku | sonnet | opus` in workflow frontmatter
  linting. Use open strings or capability tiers such as `fast`, `balanced`, and
  `heavy`.
- Token-size assertions that pin arbitrary compact-vs-pretty ratios. Keep
  bounded-payload tests, but avoid magic numbers tied to current model cost.

### 11. Lifecycle Bus and Ledger Should Stay

**Status:** Keep
**Action:** 🚀 Implement now (the simplification sublist only) — removing legacy emit shims, collapsing duplicate progress/comment writers, and generating event docs from schemas are pure hygiene wins. Core bus/ledger stays untouched.

**Primary paths:**

- `docs/LIFECYCLE.md`
- `.agents/scripts/lib/orchestration/lifecycle/`
- `.agents/schemas/lifecycle/`
- `.agents/scripts/lib/orchestration/epic-runner/`

The lifecycle bus is one of the most future-proof parts of the harness. It does
not exist because models are weak; it exists because long-running, side-effecting
workflows need ordering, idempotency, recovery, and audit logs.

Keep:

- Typed event schemas.
- Sequential listener ordering where resume semantics depend on order.
- Append-only NDJSON ledger.
- Secret stripping before ledger writes.
- Side-effect firewall and merge lockout lint.
- Resume from durable lifecycle state.

Potential simplification:

- Remove legacy emit shims once all runtime paths are bus-native.
- Collapse duplicate progress/comment writers where the event stream already
  contains the required data.
- Generate event documentation from schemas to avoid docs drift.

### 12. Worktree and Branch Isolation Still Matter

**Status:** Keep
**Action:** 🔭 Monitor — the "Simplify" sublist (demote local worktrees to an implementation option) is contingent on future agent platforms shipping reliable per-task sandboxes. Keep the abstraction as-is until then.

**Primary paths:**

- `.agents/scripts/lib/worktree-manager.js`
- `.agents/scripts/lib/worktree/`
- `.agents/workflows/helpers/worktree-lifecycle.md`
- `.agents/scripts/story-init.js`
- `.agents/scripts/story-close.js`

Better models do not eliminate file-system races, branch collisions, Windows
lock behavior, dirty working trees, or non-fast-forward pushes. Worktree or
sandbox isolation remains important whenever multiple stories run concurrently.

Keep:

- Story-scoped branches.
- Explicit branch assertions before commits.
- Worktree safety checks and pending cleanup registry.
- Non-fast-forward retry for concurrent Epic branch pushes.
- Main branch protection and PR-only promotion.

Simplify:

- If future agent platforms provide reliable sandboxed clones per task, make
  local worktrees an implementation option rather than the default mental model.
- Keep the abstraction but reduce operator-facing worktree prose.

### 13. Execution Adapter Surface Is Underused

**Status:** Reframe
**Action:** 🚀 Implement now — decision made: keep `IExecutionAdapter` as a
thin interface with the Claude Code implementation as the single shipped
adapter, and lift **dispatch manifest emission into the interface contract**
so every adapter (current or future) is required to produce one. Concrete
work:

- Retire `ManualDispatchAdapter` as a runtime path. Either delete it or
  keep a stripped-down version in `examples/` purely as documentation of
  the contract.
- Slim `IExecutionAdapter` to the methods the Claude Code runtime
  actually uses; remove placeholder/unimplemented surface.
- Make `emitDispatchManifest` (or equivalent) a non-optional method on
  the interface, with a single shared implementation that all adapters
  reuse. The manifest is the universal artifact across runtimes.
- Update `docs/architecture.md` and `docs/decisions.md` to describe the
  actual Claude Code-first runtime instead of the historical multi-runtime
  framing.

**Primary paths:**

- `.agents/scripts/lib/IExecutionAdapter.js`
- `.agents/scripts/adapters/manual.js`
- `.agents/scripts/lib/adapter-factory.js`
- `docs/architecture.md`
- `docs/decisions.md`

Mandrel states that the dispatcher is runtime-neutral behind
`IExecutionAdapter`, but the current delivery path is Claude Code-first and
uses in-session Agent-tool fan-out. The shipped `ManualDispatchAdapter` is
mostly a historical reference and status registry; it is not the main runtime
path.

Recommendation:

- Keep the provider abstraction (`ITicketingProvider`) as genuinely useful.
- Reassess `IExecutionAdapter`: either invest in a real future-model adapter
  surface, or demote the manual adapter to a compatibility example.
- For a 10x model, the more important interface may be "execution sandbox"
  rather than "model runtime": local worktree, cloud clone, CI job, or IDE
  sub-agent.
- Remove stale examples naming unimplemented runtimes from comments and docs.

### 14. Context Hydration Should Become Structured and Selective

**Status:** Simplify
**Action:** 🚀 Implement now — structured retrieval beats concatenation today, not just under future models. Emitting a structured context object with named sections, stored ticket IDs/versions/hashes, and section-aware elision improves auditability and reduces hydration cost now. Pair with Finding #3's `skills.index.json` work.

**Primary paths:**

- `.agents/scripts/context-hydrator.js`
- `.agents/scripts/lib/orchestration/context-hydration-engine.js`
- `.agents/skills/core/hydrate-context/SKILL.md`
- `.agents/templates/agent-protocol.md`

The current hydrator assembles a large text prompt from protocol template,
persona, skills, hierarchy bodies, and task instructions, then applies rough
token truncation. A 10x model reduces the risk of long context, but structured
retrieval remains better than concatenation.

Recommendation:

- Emit a structured context object with named sections and priorities.
- Store retrieved ticket IDs, versions, and hashes so the model can cite what it
  used.
- Replace rough token truncation with section-aware elision.
- Prefer task-local acceptance criteria and verification commands over loading
  the full policy library.

### 15. Acceptance Spec Is Valuable but Too Universal

**Status:** Simplify
**Action:** 🚀 Implement now — making the planner choose required / recommended / not-applicable based on visible-behavior risk is operator-time savings today. `acceptance::n-a` already exists; promote it from a manual waiver to a planner decision with a risk-rubric.

**Primary paths:**

- `.agents/workflows/epic-plan.md`
- `.agents/workflows/epic-deliver.md`
- `.agents/scripts/acceptance-spec-reconciler.js`
- `.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js`
- `.agents/rules/gherkin-standards.md`
- `.agents/skills/stack/qa/gherkin-authoring/SKILL.md`

Stable acceptance IDs and reconciliation against feature tags are useful for
user-facing functionality. They are likely overkill for internal refactors,
docs changes, prompt edits, and framework maintenance. The existing
`acceptance::n-a` waiver acknowledges this, but the default still makes
acceptance specs feel mandatory.

Recommendation:

- Make the planner choose one of: required, recommended, or not applicable.
- Require acceptance specs for externally visible behavior, public APIs,
  billing, auth, data migrations, and critical workflows.
- Skip by default for docs-only, cleanup, pure test harness, and internal
  refactor work unless the model flags user-visible risk.
- Keep close-time reconciliation when an acceptance spec exists.

### 16. Anti-Thrashing and FinOps Should Be Softer

**Status:** Simplify
**Action:** 🚀 Implement now (docs cleanup) / 🔭 Monitor (relaxation) — removing stale docs that describe already-removed numeric limits (`maxInstructionSteps`, flat `friction.*`) as active config is an obvious docs-drift fix to do now. Further relaxation of per-turn FinOps rituals waits on future inference economics.

**Primary paths:**

- `.agents/instructions.md`
- `.agents/scripts/lib/config/limits.js`
- `.agents/scripts/diagnose-friction.js`
- `.agents/scripts/lib/observability/tool-trace-hook.js`
- `.agents/scripts/lib/signals/detectors/`

Current anti-thrashing and friction systems are designed around models that get
stuck, repeat commands, or drift through analysis. Stronger models will still
fail, but less often and in different ways.

Recommendation:

- Keep friction telemetry, but treat it as observability, not frequent control
  flow.
- Prefer qualitative anti-thrashing guidance over numeric step limits. The code
  already moved in this direction by dropping `maxInstructionSteps` and
  `friction.*` from the surviving limits surface.
- Keep hard stops for destructive actions, security uncertainty, and external
  service failure.
- Remove stale docs that still describe removed numeric limits as active config.
- Relax per-turn FinOps rituals to job-level or run-level limits if future
  inference economics make the current webhook/threshold machinery noisy.

### 17. Compatibility Shims and Legacy Shapes Are Dragging the Harness

**Status:** Cleanup (hard cutovers only)
**Action:** 🚀 Implement now — operator policy is **no shim layer, no
deprecation ledger, no version-windowed sunsets**. Every change is a hard
cutover. Concrete work:

- Audit `config-resolver.js`, `lib/config/*.js`, `lib/baselines/`,
  `lifecycle/legacy-resume.js`, `wave-session.js`, and the schemas for
  existing compatibility branches; remove them in one pass.
- Codify the policy in `git-conventions.md` (or a sibling rule):
  contract changes ship as hard cutovers; consumers update on the new
  release.
- For any future contract change, the PR diff itself is the migration —
  no parallel old-shape support code.

This is the lowest-risk version of the original recommendation given the
project is a Git-submodule-distributed framework whose consumers pin to
specific versions; they opt into breaks at upgrade time.

**Primary paths:**

- `.agents/scripts/lib/config-resolver.js`
- `.agents/scripts/lib/config/*.js`
- `.agents/scripts/lib/baselines/`
- `.agents/scripts/lib/orchestration/lifecycle/legacy-resume.js`
- `.agents/scripts/lib/orchestration/wave-session.js`
- `.agents/schemas/*`
- `docs/configuration.md`

There are many compatibility references for old config shapes, baseline shapes,
legacy returns, legacy resume, and retired surfaces. These may be necessary for
near-term consumer migration, but they make the harness harder for both humans
and models to reason about.

Recommendation:

- Create a formal deprecation ledger with removal versions.
- Add one migration command per retired surface.
- Remove read-side compatibility after two minor releases or one major release,
  depending on consumer promises.
- Keep schema versions and explicit migrations instead of silent shims.

### 18. Docs Drift Is a Future-Model Risk

**Status:** Fix / Reframe
**Action:** 🚀 Implement now — stale docs are dangerous regardless of model strength (today's models follow them confidently too). All four originally observed drifts were still present as of 2026-05-19; fix them in a single pass and add the generated-from-schema tooling so they cannot regress.

**Primary paths:**

- `docs/configuration.md`
- `docs/architecture.md`
- `.agents/SDLC.md`
- `.agents/workflows/*.md`
- `.agentrc.json`
- `.agents/schemas/agentrc.schema.json`

Several docs describe older shapes or command names while newer files describe
the current state. A 10x model will follow stale docs more confidently.

Examples observed:

- `docs/configuration.md` presents `agentSettings` / `orchestration` as the
  top-level config shape, while `.agentrc.json` and the schema now use
  `project`, `github`, `planning`, and `delivery`.
- Some SDLC text still references `/agents-bootstrap-github`, while the README
  points to `node .agents/scripts/bootstrap.js`.
- `story-deliver.md` links to `epic-execute.md`, while the actual workflow file
  is `epic-deliver.md`.
- Some docs refer to Phase 6 as PR-open-and-stop, while current
  `epic-deliver.md` describes Phase 7 watch, Phase 7.5 auto-merge, and Phase 8
  cleanup.
- `.agents/SDLC.md` still lists Phase 4 as code-review and Phase 5 as retro,
  while `epic-deliver.md` has Phase 4 as audit, Phase 5 as code-review, Phase
  6 as retro, and Phase 7 as finalize.

Recommendation:

- Generate config reference from `.agents/schemas/agentrc.schema.json`.
- Generate lifecycle event tables from `.agents/schemas/lifecycle/`.
- Add doc tests for command names and internal workflow links.
- Mark historical workflow docs explicitly as archived when they no longer
  match current runtime behavior.

## Implemented Since Audit

Tracked here so the numbered list above stays focused on open work.

- ✅ **Finding #8 (Audit fan-out)** — Epic #2586 / commit 3e7937b4 (2026-05-18).
  Retired `audit-fan-out.md` and the slash-command; the twelve audit
  workflows now act as lenses selected by `select-audits.js` +
  `audit-orchestrator.js` based on changed files and risk.
  `/audit-to-stories` (e4ab4227) converts findings into actionable
  Stories.
- 🟡 **Finding #13 partial (model-name daylight)** — commit d1f1eaff
  removed dead `dispatchModel` / `recommendedModel` fields. The broader
  question of whether `IExecutionAdapter` is a real public extension
  point is still open (see Finding #13).
- 🟡 **Finding #4 partial** — fda76f21 added explicit `filesAssumption`
  validation on Task paths and aec99d1c added Phase 7 cross-validation
  of Tech Spec against the codebase. Risk-based gate streamlining is
  still open.

## Functionality Likely Obsolete With a 10x Model

These should be removed or made opt-in once future-model assumptions hold:

1. **Rigid step-count guidance** such as `maxInstructionSteps` references and
   "5-file rule" decomposition for model comprehension. Keep reviewability
   sizing, but do not use arbitrary model-capacity thresholds.
2. **Mandatory full skill/persona hydration** for common tasks. Replace with
   compact policy capsules and on-demand deep docs.
3. **Multi-stage idea refinement for every new Epic.** Strong models can produce
   a plan proposal directly and ask for targeted clarification only when risk or
   ambiguity warrants it.
4. **The 12-way audit fan-out as a default.** Keep targeted audit lenses; retire
   the fixed specialist swarm as the normal path.
5. **Free-form sub-agent JSON extraction heuristics.** Keep schema validation
   and GitHub reconciliation; drop the assumption that malformed returns are
   common.
6. **Manual dispatch adapter as a central architecture concept.** Keep if needed
   for fallback, but stop treating it as the reference execution story.
7. **Compatibility aliases with no sunset.** Future models are better served by
   one clear current contract plus explicit migrations.
8. **Closed Claude model-name enums in workflow frontmatter.** Replace them with
   open strings or model-agnostic capability tiers.
9. **Arbitrary compact JSON size-ratio tests.** Keep bounded payload and
   parseability contracts, but do not encode current token economics as a
   permanent invariant.

## Functionality Greatly Simplified

These remain useful but should become smaller:

1. **Planning and decomposition**: one adaptive planner with risk-based gates,
   not fixed Phase 1-11 choreography for all work.
2. **Context hydration**: structured, prioritized context envelopes instead of a
   large concatenated prompt.
3. **Personas and skills**: concise lenses and policies, not full behavioral
   scripts loaded into the model.
4. **Code review**: adaptive evidence-first review with structured findings,
   not a mandatory identical six-pillar ritual every time.
5. **Acceptance specs**: required for behavior contracts, optional or skipped
   for internal maintenance.
6. **Telemetry**: keep aggregate signals; reduce control-flow dependence on
   friction counters.
7. **Workflow docs**: generated or schema-backed references instead of repeated
   hand-authored phase descriptions.
8. **Per-Task execution**: preserve close-validation and state tracking, but
   allow Story-level batching when Tasks are tightly coupled.

## Functionality That Should Stay

These should remain even for substantially stronger models:

1. **GitHub as external SSOT** for ticket hierarchy, labels, PRs, branch
   protection, and operator-visible audit history.
2. **Deterministic validators** for config, tickets, dispatch manifests,
   lifecycle events, structured comments, and baseline envelopes.
3. **CI and local quality gates** for lint, format, tests, coverage,
   maintainability, CRAP, lifecycle safety, dependency audits, and secret
   scanning.
4. **Branch and worktree isolation** for concurrent execution.
5. **Lifecycle bus and append-only ledger** for resumability and side-effect
   ordering.
6. **Security baseline** and destructive-action HITL gates.
7. **Provider abstraction** for ticketing and GitHub API isolation.
8. **Declarative re-plan and reconcile** instead of destructive ticket deletion.
9. **PR-only promotion to main** with required checks.
10. **Structured comments** as durable workflow artifacts.
11. **BDD and acceptance evidence paths** when user-facing outcomes are in
    scope.
12. **Dist structure checks** for submodule consumers.

## Recommended Target Architecture

Mandrel should aim for a smaller kernel with four layers.

### 1. Policy Layer

Compact human and model-readable rules:

- Security baseline.
- Testing contract.
- Git and branch safety.
- Documentation expectations.
- Destructive-action and release gates.

Policies should be short, canonical, and cited by generated context envelopes.

### 2. State Layer

External durable state:

- GitHub Issues / Labels / Projects / PRs.
- Declarative `epic.yaml` where applicable.
- Structured comments.
- Lifecycle ledgers under `temp/`.

This layer remains the source of truth outside the model.

### 3. Deterministic Kernel

Scripts and schemas:

- Config resolution.
- Ticket reconciliation.
- DAG scheduling.
- Worktree setup and cleanup.
- State transitions.
- Validation gates.
- Baseline checks.
- Lifecycle bus.

This is Mandrel's main defensible value in a future-model world.

### 4. Judgment Layer

The model owns judgment-heavy work:

- Planning proposal.
- Decomposition.
- Code review.
- Audit synthesis.
- Retro synthesis.
- Risk classification.

The harness validates shape, evidence, and side effects rather than prescribing
every reasoning step.

## Migration Roadmap

### Phase 1: Reduce Prompt Weight

- Create compact policy capsules for global instructions, personas, and skills.
- Teach the context hydrator to emit structured sections with priorities.
- Stop hydrating full skill bodies by default.
- Add doc tests for current command names and workflow links.

### Phase 2: Make Planning Adaptive

- Add planning modes: Patch, Story, Epic.
- Make acceptance specs and full hierarchy required by risk profile, not by
  default.
- Combine idea refinement, clarity scoring, and Epic rendering into one proposal
  step.
- Convert `maxTickets` from a hard cap into a warning / reviewability budget.

### Phase 3: Simplify Review and Audit

- Replace fixed audit fan-out with a lens selector.
- Keep structured audit report contracts.
- Make code-review depth proportional to diff risk.
- Remove static model-name assumptions from workflow frontmatter.

### Phase 4: Retire Legacy Compatibility

- Publish a deprecation ledger for old config and baseline shapes.
- Add migration scripts where needed.
- Remove compatibility shims after defined release windows.
- Generate docs from schemas and runtime metadata.

### Phase 5: Reassess Execution Abstractions

- Decide whether `IExecutionAdapter` is a real public extension point.
- If yes, define a future-model adapter contract around sandbox execution,
  structured results, and cancellation.
- If no, demote the manual adapter and simplify architecture docs around the
  actual Claude Code-first runtime.

## Priority Recommendations

1. **Keep the deterministic kernel.** Do not remove schemas, CI, branch
   protection, lifecycle ledgers, worktree isolation, or state-transition
   scripts just because the model is stronger.
2. **Shrink the instruction layer.** Convert long procedural docs into compact
   policy capsules plus links.
3. **Make hierarchy and gates adaptive.** Full Epic ceremony should be reserved
   for work that needs it.
4. **Replace fixed audit swarms with adaptive review.** Stronger models should
   choose relevant lenses, not run every specialist every time.
5. **Clean up docs and legacy shims.** Stale or duplicated contracts become more
   dangerous as model confidence rises.
6. **Generalize model hints.** Do not encode today's vendor tier names as
   permanent workflow schema.
7. **Measure harness value by external guarantees.** If a feature only tells the
   model to think harder, it is a retirement candidate. If it records,
   validates, isolates, or gates side effects, it likely stays.

## Bottom Line

Mandrel should not compete with a 10x model's reasoning. It should constrain
side effects, preserve shared state, validate outputs, and leave an audit trail.
The future-proof harness is smaller, stricter at the boundaries, and much less
prescriptive inside the model's reasoning loop.
