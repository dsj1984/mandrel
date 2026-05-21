# Future Model Audit: Mandrel Under a 10x Coding Model

Date: 2026-05-21 (last reviewed 2026-05-21)

> **Action legend.** Each finding below carries one of two action tags:
>
> - 🚀 **Implement now** — an obvious win or high-value cleanup that pays
>   off under today's models. Schedule it like any other backlog item.
> - 🔭 **Monitor** — primary motivation is a materially stronger model.
>   Park it until the next model-tier release moves the cost/benefit,
>   then re-evaluate.

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
- Hard limits on instruction steps and artificial decomposition size.
- Heavy persona/skill prose loaded as context instead of compact policy.
- Strict sub-agent return parsing repair code written around weak structured
  compliance.
- Audit and code-review rituals that replicate what a stronger model or
  native IDE feature could perform in one pass.

Recommendation: continue evolving Mandrel toward a **policy-and-state kernel**.
Keep the deterministic scripts, schemas, state transitions, ledgers, branch
protections, quality gates, and external audit trail. Compress prompt documents
into concise policies. Make planning, decomposition, review, and audit depth
adaptive by risk and scope instead of fixed ceremony.

## Review Lens

Surfaces fall into four categories:

- **Keep**: Still useful even with very strong models because it protects
  external state, security, concurrency, reproducibility, or human governance.
- **Simplify**: Still useful, but much lighter with a stronger model.
- **Retire**: Exists mainly to patch current model weaknesses and should be
  removed or made optional.
- **Reframe**: Keep the capability, but change its role from procedural
  instruction to declarative policy or machine-validated contract.

## High-Confidence Findings

> **Numbering.** Original audit numbers are preserved with gaps where closed
> findings were removed. The list intentionally jumps (e.g. #2 → #3 → #6) so
> inbound references by number remain stable. New forward-looking entries
> identified during the trim use the next available gap number.

### 1. Prompt and Instruction Surface Is Too Procedural

**Status:** Simplify / Reframe
**Action:** 🔭 Monitor — today's models still rely on this procedural
scaffold; the right time to compress is when the model can self-select
context.

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
**Action:** 🔭 Monitor — persona injection still measurably reduces role
drift on current models.

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

### 3. Skill Library — Stop Hydrating Full Bodies by Default

**Status:** Simplify
**Action:** 🔭 **Monitor** — change the hydrator to *stop* loading full
skill bodies by default and route skill selection through the generated
manifest, and push remaining stack-specific non-negotiables into validators
/ lint checks rather than skill prose. Waits until the model can self-select
context confidently and until validator coverage catches up.

**Primary paths:**

- `.agents/scripts/lib/orchestration/context-hydration-engine.js`
- `.agents/skills/skills.index.json`
- `.agents/skills/stack/`

The skill library now ships a generated manifest (`skills.index.json`) and a
Policy Capsule per skill, so selection is cheap; the remaining work is the
behavioral cut-over inside the hydrator and the validator coverage that
makes it safe.

Recommendation (Monitor):

- Avoid hydrating entire skills into task prompts unless the task is
  high-risk or the user explicitly asks for the full playbook (today the
  default is still full bodies via `fullSkillBodies` / `skill::full`
  opt-out).
- Move stack-specific non-negotiables into validators or lint checks where
  feasible.

### 6. Per-Task Ritual and Commit Strategy Can Relax

**Status:** Simplify
**Action:** 🔭 Monitor — per-Task granularity is currently load-bearing for
resume/bisect. Relaxing depends on stronger holistic-edit coherence in
future models.

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
**Action:** 🔭 Monitor — repair heuristics exist because current sub-agents
still produce malformed envelopes. Re-evaluate once structured-output
compliance is rock-solid in the next tier.

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

### 9. Code Review Should Become Evidence-First, Not Ritual-First

**Status:** Reframe
**Action:** 🔭 Monitor — adaptive review-depth selection is most valuable
once the model can reliably judge "this diff is risky." Keep the structured
`code-review` comment contract as-is until then.

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

### 12. Worktree and Branch Isolation Still Matter

**Status:** Keep
**Action:** 🔭 Monitor — the "Simplify" sublist (demote local worktrees to
an implementation option) is contingent on future agent platforms shipping
reliable per-task sandboxes. Keep the abstraction as-is until then.

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

### 14. Retire `prose-legacy` Hydration Output Mode

**Status:** Retire
**Action:** 🚀 Implement now — remove
`delivery.hydration.outputMode: 'prose-legacy'`, the
`context-hydration-engine.legacy.js` module, and the `prose-legacy` enum
value together in a single hard-cutover PR. The structured `ContextEnvelope`
shipped under Epic #2648 is the canonical hydration shape; the legacy
prose-flattening path is a temporary read-side compatibility branch that
contradicts the project's no-shim-layer policy
(`.agents/rules/git-conventions.md` § Contract Cutovers — No Shim Layer).

**Primary paths:**

- `.agents/scripts/lib/config/hydration.js`
- `.agents/scripts/lib/orchestration/context-hydration-engine.legacy.js`
- `.agents/skills/core/hydrate-context/SKILL.md`

### 16. Anti-Thrashing and FinOps Should Be Softer

**Status:** Simplify
**Action:** 🔭 Monitor — further relaxation of per-turn FinOps rituals
waits on future inference economics.

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
- Prefer qualitative anti-thrashing guidance over numeric step limits.
- Keep hard stops for destructive actions, security uncertainty, and external
  service failure.
- Relax per-turn FinOps rituals to job-level or run-level limits if future
  inference economics make the current webhook/threshold machinery noisy.

## Functionality Likely Obsolete With a 10x Model

These should be removed or made opt-in once future-model assumptions hold:

1. **Mandatory full skill/persona hydration** for common tasks. Replace with
   compact policy capsules and on-demand deep docs. (Capsules and the
   manifest already exist; the hydrator default flip is the remaining work
   under Finding #3.)
2. **Free-form sub-agent JSON extraction heuristics.** Keep schema validation
   and GitHub reconciliation; drop the assumption that malformed returns are
   common.
3. **`prose-legacy` hydration output mode** and the parallel legacy
   hydration engine. See Finding #14.

## Functionality Greatly Simplified

These remain useful but should become smaller:

1. **Context hydration**: continue tightening structured, prioritized
   context envelopes; stop hydrating full skill bodies by default.
2. **Personas and skills**: concise lenses and policies, not full behavioral
   scripts loaded into the model.
3. **Code review**: adaptive evidence-first review with structured findings,
   not a mandatory identical six-pillar ritual every time.
4. **Telemetry**: keep aggregate signals; reduce control-flow dependence on
   friction counters.
5. **Per-Task execution**: preserve close-validation and state tracking, but
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

The audit's original five-phase roadmap is largely complete: adaptive
planning (Epic #2649), structured context envelopes (Epic #2648), skill
index + policy capsules (Epic #2647), schema-backed docs (Epic #2645),
hard-cutover compatibility cleanup (Epic #2646), and adaptive audit
selection (Epic #2586) have all shipped. The remaining forward-looking
work clusters into two areas:

### Reduce Prompt Weight Further

- Flip the hydrator default to manifest-driven skill selection; stop
  hydrating full skill bodies unless `skill::full` / `fullSkillBodies`
  is set (Finding #3).
- Delete the `prose-legacy` hydration mode and the legacy engine
  (Finding #14).
- Push remaining stack-specific non-negotiables into validators or lint
  checks rather than skill prose (Finding #3).

### Soften Procedural Defaults

- Convert persona prose into concise review checklists (Finding #2).
- Reduce per-Task commit ritual when Tasks are tightly coupled
  (Finding #6).
- Drop sub-agent return repair heuristics once structured-output
  compliance is reliable (Finding #7).
- Make code-review depth adaptive to diff risk (Finding #9).
- Treat anti-thrashing / FinOps as observability rather than control
  flow when inference economics permit (Finding #16).

## Priority Recommendations

1. **Keep the deterministic kernel.** Do not remove schemas, CI, branch
   protection, lifecycle ledgers, worktree isolation, or state-transition
   scripts just because the model is stronger.
2. **Shrink the instruction layer further.** Compact policy capsules now
   exist; the next move is flipping the hydrator default away from full
   skill bodies.
3. **Continue making gates adaptive.** Full ceremony should be reserved for
   work that needs it; the planner-side risk classifier (Epic #2649) is the
   model — extend it rather than reinventing.
4. **Delete legacy shapes on sight.** Hard-cutover is the operator policy;
   the `prose-legacy` hydration mode is the next concrete instance.
5. **Measure harness value by external guarantees.** If a feature only tells
   the model to think harder, it is a retirement candidate. If it records,
   validates, isolates, or gates side effects, it likely stays.

## Bottom Line

Mandrel should not compete with a 10x model's reasoning. It should constrain
side effects, preserve shared state, validate outputs, and leave an audit trail.
The future-proof harness is smaller, stricter at the boundaries, and much less
prescriptive inside the model's reasoning loop.
