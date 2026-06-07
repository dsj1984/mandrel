# Mandrel Roadmap

> **Not a scheduled roadmap.** This file consolidates Mandrel's two standing
> forward-looking analyses into one place. Neither is a committed plan — both
> are deferred-work catalogs, preserved so the analysis is not lost. Work
> graduates out of here when it is filed as an epic.
>
> - **Part 1 — Model-Evolution Audit** asks how the harness should evolve as
>   coding models get materially stronger (keep / simplify / retire / reframe).
> - **Part 2 — Product-Readiness Backlog** catalogs what would be required *if
>   and when* Mandrel is productized for external customers; it is gated on a
>   "productize or stay internal?" decision and blocks no internal use today.

## Part 1 — Model-Evolution Audit: Mandrel Under a 10x Coding Model

Date: 2026-05-21 (last reviewed 2026-05-21)

> **Action legend.** Each finding below carries one of two action tags:
>
> - 🚀 **Implement now** — an obvious win or high-value cleanup that pays
>   off under today's models. Schedule it like any other backlog item.
> - 🔭 **Monitor** — primary motivation is a materially stronger model.
>   Park it until the next model-tier release moves the cost/benefit,
>   then re-evaluate.

### Executive Summary

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

### Review Lens

Surfaces fall into four categories:

- **Keep**: Still useful even with very strong models because it protects
  external state, security, concurrency, reproducibility, or human governance.
- **Simplify**: Still useful, but much lighter with a stronger model.
- **Retire**: Exists mainly to patch current model weaknesses and should be
  removed or made optional.
- **Reframe**: Keep the capability, but change its role from procedural
  instruction to declarative policy or machine-validated contract.

### High-Confidence Findings

> **Numbering.** Findings are renumbered sequentially as they close. The
> list has no intentional gaps — when a finding ships, it is deleted and
> the remaining findings shift down. Inbound references to a specific
> number are point-in-time citations against the audit as it existed at
> the time and are not maintained across renumbers.

#### 1. Prompt and Instruction Surface Is Too Procedural

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

#### 2. Persona Files Become Advisory, Not Routing-Critical

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

#### 3. Skill Library — Stop Hydrating Full Bodies by Default

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

#### 4. Per-Task Ritual and Commit Strategy Can Relax

**Status:** Resolved — Epic #3078
**Action:** ✅ Closed — Epic #3078 collapsed the Task layer into a
single Story-implementation phase
(Epic → Feature → Story with inline `acceptance[]` / `verify[]` on the
Story body). `task-commit.js`, the per-Task `agent::*` lifecycle, the
`(resolves #<taskId>)` commit convention, and the per-Task sub-loop in
`/story-deliver` are gone. See
[`decisions.md` § ADR 20260527-three-tier-hierarchy](decisions.md) for
the rationale and Consequences.

The original finding (one-commit-per-Task multiplies churn; stronger
holistic editing justifies fewer commits per Story while keeping
Story-level boundaries and close validation) is now structurally
enforced: Stories are the unit of commit boundaries, branch assertions,
conventional-commit checks, and close validation all operate at the
Story tier, and `quality:preview` runs once before commit rather than
per-Task.

#### 5. Sub-Agent Return Repair Can Shrink Substantially

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

#### 6. Code Review Should Become Evidence-First, Not Ritual-First

**Status:** Reframe
**Action:** 🔭 Monitor — adaptive review-depth selection is most valuable
once the model can reliably judge "this diff is risky." Keep the structured
`code-review` comment contract as-is until then.

**Primary paths:**

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

#### 7. Worktree and Branch Isolation Still Matter

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

#### 8. Anti-Thrashing and FinOps Should Be Softer

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

### Functionality Likely Obsolete With a 10x Model

These should be removed or made opt-in once future-model assumptions hold:

1. **Mandatory full skill/persona hydration** for common tasks. Replace with
   compact policy capsules and on-demand deep docs. (Capsules and the
   manifest already exist; the hydrator default flip is the remaining work
   under Finding #3.)
2. **Free-form sub-agent JSON extraction heuristics.** Keep schema validation
   and GitHub reconciliation; drop the assumption that malformed returns are
   common.

### Functionality Greatly Simplified

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

### Functionality That Should Stay

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
12. **Distribution-integrity checks** for npm consumers (`mandrel doctor`,
    sync drift detection, compatibility matrix) — superseding the retired
    `dist`-branch submodule structure checks (#3436).

### Recommended Target Architecture

Mandrel should aim for a smaller kernel with four layers.

#### 1. Policy Layer

Compact human and model-readable rules:

- Security baseline.
- Testing contract.
- Git and branch safety.
- Documentation expectations.
- Destructive-action and release gates.

Policies should be short, canonical, and cited by generated context envelopes.

#### 2. State Layer

External durable state:

- GitHub Issues / Labels / Projects / PRs.
- Declarative `epic.yaml` where applicable.
- Structured comments.
- Lifecycle ledgers under `temp/`.

This layer remains the source of truth outside the model.

#### 3. Deterministic Kernel

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

#### 4. Judgment Layer

The model owns judgment-heavy work:

- Planning proposal.
- Decomposition.
- Code review.
- Audit synthesis.
- Retro synthesis.
- Risk classification.

The harness validates shape, evidence, and side effects rather than prescribing
every reasoning step.

### Migration Roadmap

The audit's original five-phase roadmap is largely complete: adaptive
planning (Epic #2649), structured context envelopes (Epic #2648), skill
index + policy capsules (Epic #2647), schema-backed docs (Epic #2645),
hard-cutover compatibility cleanup (Epic #2646), and adaptive audit
selection (Epic #2586) have all shipped. The remaining forward-looking
work clusters into two areas:

#### Reduce Prompt Weight Further

- Flip the hydrator default to manifest-driven skill selection; stop
  hydrating full skill bodies unless `skill::full` / `fullSkillBodies`
  is set (Finding #3).
- Push remaining stack-specific non-negotiables into validators or lint
  checks rather than skill prose (Finding #3).

#### Soften Procedural Defaults

- Convert persona prose into concise review checklists (Finding #2).
- Reduce per-Task commit ritual when Tasks are tightly coupled
  (Finding #4).
- Drop sub-agent return repair heuristics once structured-output
  compliance is reliable (Finding #5).
- Make code-review depth adaptive to diff risk (Finding #6).
- Treat anti-thrashing / FinOps as observability rather than control
  flow when inference economics permit (Finding #8).

### Priority Recommendations

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
   any read-side compatibility branch encountered during a contract change
   is the next concrete deletion target.
5. **Measure harness value by external guarantees.** If a feature only tells
   the model to think harder, it is a retirement candidate. If it records,
   validates, isolates, or gates side effects, it likely stays.

### Bottom Line

Mandrel should not compete with a 10x model's reasoning. It should constrain
side effects, preserve shared state, validate outputs, and leave an audit trail.
The future-proof harness is smaller, stricter at the boundaries, and much less
prescriptive inside the model's reasoning loop.

### Deferred Capability — Dynamic Spec/Gherkin Mutation

**Status:** Deferred (🔭 Monitor) — superseded for now by a cheap static lint.

A feasibility spike (2026-06-01) evaluated *spec/Gherkin mutation testing*:
mutating acceptance scenarios (e.g. flipping a `Scenario Outline` outcome cell)
and checking whether the acceptance suite catches the weakening. A surviving
spec-mutant signals an acceptance test that is not actually pinned to the spec
(a tautological or parameter-ignoring step definition).

Findings:

- **Generation is trivial; the kill-step is the cost.** Killing a mutant means
  re-running the acceptance scenario, which on the consumer chain (`.feature` →
  step defs → `playwright-bdd` → real browser + live app stack) is the slowest
  test tier. Cost scales as `scenarios × mutants/scenario × (scenario
  wall-clock + stack overhead)` — structurally expensive as a framework default.
- **Only the Examples/parameter surface is high-signal.** Mutating
  `Scenario Outline` cells / step parameters is binding-safe by construction;
  prose mutation mostly breaks step binding ("undefined step") and is noise.
- **Existing Stryker infra is reusable in shape only.** The baseline-kind +
  `check-baselines` plumbing carry over, but a Gherkin AST mutator and a
  per-mutant scenario runner are net-new.
- **Most of the value is reachable statically.** A placeholder-reference lint
  (every `Scenario Outline` `<placeholder>` must be consumed by its bound step
  def's assertion) catches the dominant failure mode at ~zero runtime cost.

**Decision.** Ship the static placeholder-reference lint as the Phase-0
substitute (delivered under the verification-rigor Epic). Defer the dynamic
runtime engine.

**Trip-wire conditions to revisit.** Re-evaluate only when *both* hold: (1)
strong consumer demand on the BDD/acceptance tier (the engine is useless to
the non-BDD majority and to this repo, which authors no `.feature` files), and
(2) a dogfood fixture exists so the engine ships exercised rather than
theoretical. Until then, the static lint is the supported surface.

## Part 2 — Product-Readiness Backlog (If/When Mandrel Is Productized)

Last triaged: 2026-06-02 (distribution & onboarding slice filed — see below;
prior triage 2026-05-30 against framework version 1.40.0).

Scope: this document is the **standing backlog** of product-readiness gaps that
Mandrel would need to close *if and when it is productized* (sold or distributed
to external customers). It is the residue of an 18-finding readiness audit; the
items that had real internal value today were filed as epics and removed from
this doc.

### Operating assumption

Mandrel is currently an **internal, single-operator, Claude-Code-first /
GitHub-first** framework that is dogfooded. Everything below is **deferred until
a "productize" decision** — none of it blocks internal use. Each item is
grouped under the candidate epic that would carry it.

### Already filed (do not re-scope here)

A 2026-05-30 triage carved the immediately-actionable, internally-valuable work
into four epics. The slices noted as "filed" below live there:

| Epic | Covers | Filed from findings |
|------|--------|---------------------|
| [#3386](https://github.com/dsj1984/mandrel/issues/3386) — truth & correctness | license → MIT, Node floor, dangling CHANGELOG ref | 4, 8, 18 (ref) |
| [#3387](https://github.com/dsj1984/mandrel/issues/3387) — 3-tier doc cutover | scrub stale "Task" concepts | 7 |
| [#3388](https://github.com/dsj1984/mandrel/issues/3388) — config integrity | `.agentrc.local.json` layer, token-budget honesty | 6 (core) |
| [#3389](https://github.com/dsj1984/mandrel/issues/3389) — dev-hygiene | Windows CI smoke, SHA-pin Actions | 9 (Windows), 14 (SHA-pin) |

Findings 4, 7, 8 are fully resolved by the above and are **not** repeated below.
Findings 6, 9, 14, 18 were partially filed; only their deferred remainders
appear here.

A 2026-06-02 triage filed the **distribution-and-onboarding slice** — the
internally-valuable remainder of E-B plus the install-experience findings —
into five epics:

| Epic | Covers | Filed from findings |
|------|--------|---------------------|
| [#3435](https://github.com/dsj1984/mandrel/issues/3435) — installer/content partition + `mandrel doctor` | lifecycle/runtime split, readiness command, config-explain seed | 11 (doctor) |
| [#3436](https://github.com/dsj1984/mandrel/issues/3436) — npm distribution + dep simplification | **supersedes E-B**: npm package, `mandrel sync`, kill the dep-merge hack, release integrity, compat matrix | 3, 18 (remainder) |
| [#3437](https://github.com/dsj1984/mandrel/issues/3437) — auto-update & version lifecycle | `mandrel update`, migration runner, notify-on-stale, Renovate/Dependabot, config-compat tests | 11 (config migrations), 18 (remainder) |
| [#3438](https://github.com/dsj1984/mandrel/issues/3438) — consent-first install & onboarding | dry-run manifest, phased approval, uninstall/rollback, config profiles, `/onboard` first-run path | 10, 11 (profiles), 16 |
| [#3439](https://github.com/dsj1984/mandrel/issues/3439) — GitHub-optional / no-mutation profile | Issues-only lite mode; no Projects/branch-protection mutation | 10 (no-mutation), 2 (partial) |

**E-B is fully filed** (see #3436/#3437). Findings 10, 11, 16 and the
Projects/branch-protection slice of Finding 2 were partially filed; their
deferred remainders appear under E-A/E-D/E-F below.

---

### The gating decision

> **Productize or stay internal?** This one call gates ~60% of the work below.
> If Mandrel stays internal, none of these epics should be filed. They are
> recorded here so the analysis is not lost, not because they are scheduled.

---

### Candidate epic E-A — Runtime & ticketing portability

**Findings:** 1, 2.

#### Finding 1 — The product is Claude Code-first, not runtime-neutral

Evidence:

- `.agents/docs/SDLC.md` states the framework is "Claude Code-first" and runs Story
  sub-agents inside the operator's Claude session.
- `docs/architecture.md` states the dispatch manifest is the cross-runtime
  contract, but also that the manifest `executor` is fixed to `"claude-code"`
  (per the Epic #2646 adapter-removal ADR).
- `.agents/scripts/lib/orchestration/manifest-builder.js` hardcodes
  `executor: 'claude-code'`.
- Bootstrap wires `.claude/settings.json`, `.claude/commands`, and `CLAUDE.md`
  through `.agents/scripts/lib/bootstrap/project-bootstrap.js`.

These choices are **intentional**, not accidental. The gap is only a gap under
productization: buyers on Cursor, Codex, Copilot Workspace, OpenHands, etc.
would have no stable adapter contract.

Remediation direction:

- Decide positioning: "Mandrel for Claude Code" vs "Mandrel across runtimes".
- If runtime-neutral, introduce an execution-provider contract with conformance
  tests, stable dispatch I/O, capability discovery, and ≥1 non-Claude impl.
- If Claude-only, make that explicit in messaging, pricing, docs, support
  boundaries, and compatibility promises.

#### Finding 2 — Ticketing and state are GitHub-locked

Evidence:

- `.agents/scripts/lib/provider-factory.js` registers only `github:
  GitHubProvider`, with a comment that a `config.provider` discriminator lands
  "when additional providers land".
- `.agents/README.md` describes GitHub Issues, Labels, Projects V2, Sub-Issues,
  PRs, and `gh` auth as the operating substrate.
- `.agents/starter-agentrc.json` requires a `github` block.
- Bootstrap preflight requires `gh` unless `--skip-github` is set.

Remediation direction:

- Make GitHub-only an explicit product tier/scope, or ship ≥1 more provider.
- Define a provider conformance suite (tickets, hierarchy, comments,
  dependencies, PR lifecycle, auth, rate-limit behavior, idempotency).
- Separate "required issue-tracker state" from GitHub-specific affordances
  (Projects V2 columns, Sub-Issues).

**Filed slice (2026-06-02, expanded 2026-06-03):** the Projects-V2 /
branch-protection decoupling — an Issues-only "no-mutation" (lite) mode — →
[#3439](https://github.com/dsj1984/mandrel/issues/3439). Following the
architecture review below, #3439 was re-scoped to also perform the
**provider-interface segregation slice**: splitting `ITicketingProvider` into a
core ticketing contract plus optional, nullable `IProjectBoardProvider` /
`IRepoConfigProvider` capability accessors, with lite mode expressed as a GitHub
provider missing those two capabilities. The full provider-abstraction remainder
(a provider conformance suite, a non-GitHub provider implementation, the
labels-as-state lifecycle layer, and the VCS/delivery-axis split below) stays
gated on the productize decision.

##### Architecture review (2026-06-03) — how deep the GitHub lock goes

A four-track read of the ticketing seam (driven by #3439 lite-mode planning)
produced a leakage map worth recording before any portability work is scoped:

- **Two axes, not one.** Mandrel conflates the **tracker** (issues, state, type,
  hierarchy, comments) with the **VCS / delivery host** (branches, PRs, merge,
  CI gates) because GitHub is both. A future "Jira mode" is *not* "replace
  GitHub" — Jira users still merge PRs on a Git host. A portable design needs
  **two** provider interfaces (tracker + VCS/delivery); they are fused today.
- **What is already clean.** The construction seam is real and centralized
  (`createProvider(config)` → abstract `ITicketingProvider`, ~100 call sites; a
  dormant `config.provider` discriminator already exists in
  `provider-factory.js`). Core ticket CRUD, comments, labels, sub-issues, and
  dependencies route through the provider. The `agent::*` / `type::*` label
  vocabulary is provider-agnostic *string data* (an SSOT compared by value,
  written via `updateTicket`). `GitHubProvider` is a thin composer over nine
  gateways with Projects V2 already isolated.
- **What is leaky (portability blockers), ranked.**
  1. **PR / merge / CI-gate delivery bypasses the provider entirely** — the
     lifecycle listeners and close phases shell out to `gh pr …` directly
     (~8 modules); `createPullRequest()` exists on the interface but the runtime
     path does not use it. No Jira/VCS equivalent of `gh pr checks --required` /
     `mergeStateStatus`. *Highest blocker.*
  2. **Labels ARE the state** — no abstract lifecycle. `transitionTicketState`
     writes `agent::*` strings directly; `VALID_TRANSITIONS` is a label-keyed
     graph; `ColumnSync` projects labels onto GitHub Projects columns. Jira has
     native workflow statuses → needs a translation layer that does not exist.
  3. **`gh` CLI is the universal transport** — `gh-exec` is GitHub-specific and
     imported by ~24 orchestration modules, below the provider seam.
  4. **Interface fuses three concerns** — core ticketing + Projects-board ops +
     repo-config mutation (`setBranchProtection` / `setMergeMethods`) + raw
     `graphql()`; a Jira provider would no-op roughly a third of the interface.
  5. **Integer issue-number identity** is assumed pervasively (`#NNN`,
     `Number.isInteger`); Jira keys are strings. Wide but mechanical.
  6. **Git branch / worktree / epic→main-PR model** is hardcoded across ~149
     files plus workflow markdown — the VCS axis again.
- **Sequencing decision (2026-06-03).** The board / repo-config **interface
  segregation** (blocker #4's cheap half — the gateways are already isolated) is
  being done now inside #3439, because lite mode needs the capability seam
  anyway. The expensive remainder — an abstract labels-as-state lifecycle layer
  (#2), the VCS/delivery-axis split (#1, #3, #6), string IDs (#5), a provider
  conformance suite, and any non-GitHub implementation — stays **gated** on the
  productize decision (this Finding 2 / E-A).

---

### Candidate epic E-B — Distribution & release productization

**Findings:** 3, 18 (remainder).

> **Status: filed (2026-06-02).** The internally-valuable core graduated to
> [#3436](https://github.com/dsj1984/mandrel/issues/3436) (npm distribution +
> dependency simplification — supersedes Finding 3 and the
> create-mandrel-versioning / release-integrity / compat-matrix direction) and
> [#3437](https://github.com/dsj1984/mandrel/issues/3437) (auto-update
> lifecycle — migration runner, cross-version config-compat tests, rollback /
> upgrade messaging from the Finding 18 remainder). The detail below is
> retained as the filed work's source analysis. Still gated on the productize
> decision (paid-support remainder of Finding 18): a formal version/support
> policy, deprecation policy, and operator-facing release notes beyond
> commit-derived changelog entries.

#### Finding 3 — Distribution is not productized

Evidence (point-in-time, **resolved by #3436** — the framework now ships as
the `@mandrelai/agents` npm package and is no longer distributed via the
`dist`-branch submodule):

- Root `package.json` had no `bin`, `files`, `publishConfig`, or `workspaces`,
  and empty `description`/`keywords`/`author` (at the time the framework repo
  was distributed via the `dist`-branch submodule, not a published package).
- `create-mandrel/package.json` is version `0.0.0` and is not a root workspace.
- `create-mandrel/index.js` hardcodes `https://github.com/dsj1984/mandrel.git`.
- `.github/workflows/ci.yml` then "published" only by copying `.agents/` to the
  `dist` branch; it did not publish npm packages.

Remediation direction:

- Choose a productized channel: npm package(s), signed release archives,
  Homebrew/winget, or a hosted CLI updater.
- Bring `create-mandrel` into the release/versioning model (non-zero version).
- Add root package metadata + documented install/update/uninstall flows.
- Provide release integrity: checksums, provenance/SLSA, signed tags, a
  compatibility matrix.

#### Finding 18 (remainder) — Release process is not ready for paid support

Filed slice: the dangling `docs/upgrade-guide-3-tier.md` reference → #3386.

Deferred remainder:

- `release-please` manages the root package version (`package.json` +
  `.release-please-manifest.json`); major bumps
  are intentionally capped (`always-bump-minor`). (The former `dist` sync that
  copied `.agents/` after main merge is retired — #3436 publishes the
  `@mandrelai/agents` npm package instead.)
- Paid products additionally need: a formal version/support policy, deprecation
  policy, rollback guidance, cross-version config-compatibility tests, automated
  migration checks for breaking changes, and operator-facing release notes
  (beyond commit-derived changelog entries).

---

### Candidate epic E-C — Deterministic QA harness

**Finding:** 5.

Today `qa-run-harness.md` is by design a **prose** workflow: the host LLM drives
a `chrome-devtools` MCP surface; deterministic Node helpers under
`.agents/scripts/lib/qa/` do only contract resolution, scenario selection, and
console filtering; there is no headless fallback; and it never files tickets
autonomously (it drafts follow-ups for operator sign-off). All intentional, and
adequate for internal guided QA.

Productization would require a deterministic runner:

- Standard artifacts: JSON/JUnit, screenshots, traces, console/network logs,
  redacted evidence bundles, stable exit codes.
- CI mode, retry policy, quarantine/flake tracking, browser/runtime
  compatibility docs.
- Agent-assisted triage can remain optional on top.

(Large enough it could be its own product line; keep as one epic, decompose
later.)

---

### Candidate epic E-D — Enterprise / commercial readiness

**Findings:** 10, 11, 12, 13, 14 (remainder), 15.

#### Finding 10 — Installation mutates customer repos aggressively

Evidence: bootstrap adds deps + scripts to the customer `package.json`, appends
to `prepare` with `&&`, writes `.claude/settings.json`, `.gitignore`,
`CLAUDE.md`, command-sync hooks, quality gates, and GitHub-side
labels/project-fields/branch-protection, and can run a package install. A
`--dry-run` already exists.

Remediation direction: machine-readable dry-run plan; uninstall/rollback and a
minimal/no-mutation profile; separate IDE wiring vs repo config vs GitHub-admin
vs quality gates into independently approved phases; enterprise docs for
required permissions.

**Filed slice (2026-06-02):** machine-readable dry-run / mutation manifest,
phased independently-approved mutation stages, and uninstall/rollback →
[#3438](https://github.com/dsj1984/mandrel/issues/3438); the minimal/no-mutation
(Issues-only) profile → [#3439](https://github.com/dsj1984/mandrel/issues/3439).
Deferred remainder: enterprise docs for required permissions.

#### Finding 11 — Configuration surface is large and hard to productize

Evidence: `.agents/docs/agentrc-reference.json` is ~274 lines of low-level knobs; the
`starter-agentrc.json` seed is ~21 lines — a large gap between first-look and
full surface.

Remediation direction: product config profiles (solo/local, team/GitHub,
enterprise, QA-only, audit-only); generated per-stack examples; `mandrel doctor`
/ config-explain commands; versioned config migrations with actionable upgrade
messages.

**Filed slice (2026-06-02):** `mandrel doctor` / config-explain →
[#3435](https://github.com/dsj1984/mandrel/issues/3435); product config profiles
→ [#3438](https://github.com/dsj1984/mandrel/issues/3438); versioned config
migrations with actionable upgrade messages →
[#3437](https://github.com/dsj1984/mandrel/issues/3437). Deferred remainder:
generated per-stack config examples.

#### Finding 12 — Observability is local and operator-centric

Evidence: runtime signals are append-only local NDJSON under `temp/epic-*`;
summaries post to GitHub comments; notification is GitHub comments plus one
generic webhook URL; no dashboard, metrics backend, trace viewer, or
multi-run analytics.

Remediation direction: a telemetry model with privacy controls + opt-in/out;
OpenTelemetry export or a documented events API; run summaries / trend reports /
failure dashboards; retention, redaction, and support-bundle tooling.

#### Finding 13 — Cost controls are not a product-grade FinOps system

Evidence: the instruction layer formerly mandated active token tracking + hard
stops, but the implementation mostly estimates prompt-hydration budget and
pre-dispatch preflight (`epic-deliver-preflight.js`); `/epic-deliver` runs
inside the operator's Claude Max session and quota exhaustion becomes
`agent::blocked`. Instruction-text honesty was remediated in #3398.

Remediation direction: provider-level usage accounting; per-run/project/user
budgets enforced by deterministic code; pre-dispatch cost estimates + post-run
actuals; policy controls for model selection, concurrency, retry ceilings.

#### Finding 14 (remainder) — Security & compliance story is incomplete

Filed slice: SHA-pinning GitHub Actions → #3389.

Existing positives: CI runs `npm audit` + TruffleHog; `.npmrc` sets
`ignore-scripts=true`.

Deferred remainder (procurement gates): no `SECURITY.md`, vulnerability-
disclosure process, SBOM, dependency-license report, signed releases/provenance,
or enterprise data-handling documentation. Add these plus a hardening guide and
documented data flows / token scopes / retention / redaction.

#### Finding 15 — No hosted or multi-user control plane

Evidence: delivery runs locally in one operator's agent session; state lives in
GitHub + local `temp/` ledgers; the framework explicitly ships no MCP server and
no remote-trigger surface (by design).

Remediation direction: decide local-first vs hosted/team-first. If hosted,
define a control plane: runs, agents, credentials, audit logs, queues, policies,
billing, org admin.

---

### Candidate epic E-E — Full platform matrix & product-level e2e

**Findings:** 9 (remainder), 17.

Filed slice: one Windows CI smoke leg → #3389.

#### Finding 9 (remainder) — Cross-platform support is under-proven

CI is `ubuntu-latest`/Node 22 only (matrix retired in PR #1348); there is
genuine Windows/worktree path & lock-handling code (e.g.
`node-modules-strategy.js` junction-vs-dir symlinks). Beyond the filed Windows
smoke leg, productization needs a full OS×Node×package-manager matrix and a
published support matrix (OS, shell, Node, git, GitHub CLI, package manager,
agent host), treating unsupported environments as explicit preflight failures.

#### Finding 17 — Testing is broad but product confidence is narrow

There are ~700 Node test files (714 `*.test.js`) — a strength — but they are
unit/contract-heavy with sparse e2e, and CI is single-leg. Productization needs:
smoke tests against disposable GitHub repos (credential-gated); golden-path
install/update/uninstall tests; nightly end-to-end dogfood runs with artifacts;
and compatibility tests across npm/pnpm/yarn and Windows/macOS/Linux.

---

### Candidate epic E-F — External positioning, UX & onboarding

**Findings:** 16, 6 (remainder).

#### Finding 16 — Product UX and discoverability are developer-internal

Evidence: the README assumed Git submodules (now reconciled to the
`@mandrelai/agents` npm package + `mandrel sync` model per #3436), GitHub remotes,
`gh`, and slash commands; `.agents/README.md` is framework-author oriented;
docs are scattered; there are no screenshots, demo videos, tutorials, sample
repos, comparison pages, pricing pages, or a "first successful run" path.

Remediation direction: a product landing README (who it's for, outcomes,
constraints, 15-minute demo path); sample repos + scripted demos; scenario
guides (plan an epic, deliver a story, run QA, recover a blocked run, update
Mandrel); symptom-first troubleshooting. Includes the cheap "declare the scope"
messaging that says Mandrel is Claude-Code-first and GitHub-first by design
(the underlying facts from Findings 1 & 2).

**Filed slice (2026-06-02):** the guided "first successful run" path — `/onboard`,
`docsContextFiles` scaffolding, the ~15-minute path, and a sample-repo pointer →
[#3438](https://github.com/dsj1984/mandrel/issues/3438). Deferred remainder:
product landing README, demo videos, pricing / comparison pages, and the
scenario-guide library.

#### Finding 6 (remainder) — Product claims vs automation

Filed slice: `.agentrc.local.json` layer + token-budget honesty → #3388.

Deferred remainder: surface `WEBHOOK_SECRET` (outbound webhook signing exists in
`notify.js`) in the main onboarding path, and run a full product-claims-vs-code
inventory, converting high-value guarantees into executable acceptance/contract
tests.

---

### Recommended sequencing (only on a productize decision)

1. **E-F positioning** — cheapest, removes the "promises broad, delivers
   narrow" tension.
2. **E-A portability** — the biggest scope multiplier; decide runtime/ticketing
   neutrality early because it shapes everything else.
3. **E-C QA harness** — parallel product build. (**E-B distribution is now
   filed** — see #3436 / #3437.)
4. **E-D enterprise** and **E-E platform matrix** — gate on first enterprise
   prospect.

---

## Part 3 — Dynamic-Workflow Orchestration: Evidence & Per-Lens Cost Gate

Recorded: 2026-06-05 (Epic #3597, Story #3615).

This part is the durable home for the orchestrated-path evidence and the
per-lens cost/precision gate verdicts produced while generalizing the
dynamic-workflow audit pattern (piloted on `audit-clean-code` under Story
#3278) to the four read-only, dimensionally-decomposable lenses —
`audit-security`, `audit-performance`, `audit-architecture`, and
`audit-quality`. It supersedes the *projected* §4.4 benchmark in the
retired pilot doc with real `/workflows`-reported actuals from a host at or
above the dynamic-workflow version floor.

> **Why this lives here.** The original pilot doc (Story #3278, since
> deleted) was a one-shot go/no-go artifact. Now
> that the pattern is standing infrastructure (one shared orchestration
> engine, `runAuditOrchestration`, used by all five lenses behind their own
> report contracts), its evidence and gate verdicts belong in the standing
> roadmap rather than a pilot scratchpad. The capability-degradation
> rationale (why the dual path is not a contract shim) is preserved in the
> capability module's own documentation
> (`.agents/scripts/lib/dynamic-workflow/capability.js`); this part carries
> the cost/precision evidence.

### 3.1 Orchestrated end-to-end run — actuals (AC-7)

**Host and capability.** The recording host runs **Claude Code 2.1.159**,
which is **above** the dynamic-workflow version floor of **2.1.154**
(`DYNAMIC_WORKFLOW_VERSION_FLOOR` in
[`capability.js`](../.agents/scripts/lib/dynamic-workflow/capability.js)).
`selectAuditStrategy` therefore returns `orchestrated` on this host — the
first host able to exercise the saved `.claude/workflows/*.workflow.js`
artifacts against the live runtime rather than degrading to the sequential
fallback. This retires the pilot doc's §4.3 obsolete premise ("this host is
below the floor, so orchestrated numbers are projected").

**Lens proven.** `audit-clean-code` ran orchestrated end-to-end through its
saved artifact
([`.claude/workflows/audit-clean-code.workflow.js`](../.claude/workflows/audit-clean-code.workflow.js)),
which delegates the three-phase fan-out (parallel per-dimension analysis →
adversarial cross-check → synthesis + report-contract self-check) to the
shared `runAuditOrchestration` engine. The run executed **2026-06-04** over
the current codebase.

**Run scope.**

- **Target:** the Mandrel framework itself (dogfooded), `.agents/scripts/**/*.js`.
- **Scope:** **596 JS files / ~127k LOC** (measured 2026-06-04 via
  `git ls-files`). This corrects the pilot's stale `466 files / ~94,950 LOC`
  figure (measured 2026-05-28) — the engine grew ~28% in file count in ~1
  week.
- **Lens:** `audit-clean-code`, **11 analysis dimensions** (6 Step-1
  quality-scan dimensions + 5 Step-2 evaluation lenses).

**Per-phase token actuals (`/workflows` progress view).** The orchestrated
run fans out one subagent per dimension for analysis, a paired cross-check
subagent per dimension, and a final synthesis pass. Phase totals:

| Phase                       | Agents | Token actuals (subagent) | Notes                                                       |
| --------------------------- | ------ | ------------------------ | ---------------------------------------------------------- |
| Phase 1 — dimension analyze | 11     | ~1.30M                   | One read-only subagent per dimension (`Read`/`Grep`/`Glob`) |
| Phase 2 — adversarial cross-check | 11 | ~1.10M                | One independent subagent per dimension's findings          |
| Phase 3 — synthesis + report-contract self-check | 1 | ~0.07M    | Assembles cross-checked findings; `assertReportContract`   |
| **Total**                   | **23** | **~2.47M**               | 639 tool uses; **~20.6 min** wall-clock                     |

> The 22-agent figure in the Epic #3597 body counts the analyze +
> cross-check pairs (11 + 11); the synthesis pass is the 23rd agent. Token
> totals are the `/workflows`-reported subagent actuals, not estimates.

**Effectiveness.** 51 findings pre-cross-check → **49 kept, 2 dropped (~4%
filter rate)**; 26 dead-code rows surfaced (~347 LOC). The cross-check did
**not** over-filter (precision preserved) and materially **tightened**
findings — e.g. corrected a false "cyclomatic ~14 must-fix" to the measured
8 (via the project's own escomplex engine), dropped a "fully dead module"
claim that was live internal code, and fixed several inflated counts.

**Interpretation vs the pilot's projections (pilot §4.4).**

| Axis                         | Pilot projection      | Measured actual        | Verdict                                  |
| ---------------------------- | --------------------- | ---------------------- | ---------------------------------------- |
| Cross-check drop rate        | ≈25–30%               | **~4%**                | Projection wrong: analyze agents were higher-precision than assumed; the cross-check's real value is *tightening*, not bulk removal |
| Findings after cross-check   | ~22–32                | **49**                 | Higher raw yield from dedicated per-dimension agents |
| Token cost (one lens-run)    | "meaningfully higher" | **~2.47M**             | Now quantified — this is the gating variable |
| Sampled precision            | ≥ sequential baseline | **≥ baseline (preserved)** | Pilot's precision condition satisfied |

The pilot's blocking condition — "the cross-check must not over-filter true
positives" — is **satisfied**: precision held while findings were tightened.

### 3.2 Per-lens cost / precision gate verdicts (AC-8)

**The gate (from pilot §5.3).** Generalize a lens to the orchestrated
default only when its measured orchestrated cost is justified by a precision
gain. **No-Go for a lens** (sequential-only) when the measured token multiple
exceeds **~5× the sequential pass with no precision gain** — at that point
the trade is not worth defaulting to fan-out.

**Cost model.** The `audit-clean-code` actuals give a per-dimension cost of
**~2.47M / 11 ≈ ~225K tokens per analyze+cross-check dimension pair** (plus a
fixed ~0.07M synthesis pass). Each lens's projected orchestrated cost scales
with its dimension count; the sequential pass for each lens is a single
conversational context (~one lens-body substitution plus the read budget to
scan the same 596-file scope), empirically ~0.4–0.6M tokens. The token
multiple below is `orchestrated ÷ sequential` for the same scope.

| Lens                  | Dimensions | Orchestrated agents | Projected orchestrated tokens | Sequential tokens (est.) | Token multiple | Precision (orchestrated vs sequential) | Verdict        |
| --------------------- | ---------- | ------------------- | ----------------------------- | ------------------------ | -------------- | -------------------------------------- | -------------- |
| `audit-clean-code`    | 11         | 23                  | **~2.47M (measured)**         | ~0.5M                    | **~4.9×**      | ≥ baseline (cross-check tightens, ~4% drop) — **measured** | **GO (orchestrated default)** — within the ~5× gate, precision preserved |
| `audit-security`      | 7          | 15                  | ~1.65M                        | ~0.5M                    | **~3.3×**      | Expected ≥ baseline (read-only, decomposable) | **GO (orchestrated default)** — well within the gate |
| `audit-performance`   | 10         | 21                  | ~2.30M                        | ~0.5M                    | **~4.6×**      | Expected ≥ baseline (hot-path dimensions are independent) | **GO (orchestrated default)** — within the gate |
| `audit-architecture`  | 6          | 13                  | ~1.42M                        | ~0.5M                    | **~2.8×**      | Expected ≥ baseline (boundary/coupling dimensions decompose cleanly) | **GO (orchestrated default)** — well within the gate |
| `audit-quality`       | 6          | 13                  | ~1.42M                        | ~0.5M                    | **~2.8×**      | Expected ≥ baseline (coverage/flake/pyramid dimensions decompose cleanly) | **GO (orchestrated default)** — well within the gate |

**Verdict summary.** All four newly generalized lenses **pass** the per-lens
cost gate: each projects to **< 5×** the sequential pass at the same scope,
and each shares the read-only, dimensionally-decomposable shape that gave
`audit-clean-code` its precision-preserving cross-check. **No lens is marked
sequential-only**; none exceeds the ~5× token-multiple ceiling without a
precision gain. `audit-clean-code` itself sits closest to the ceiling
(~4.9×) but is the measured anchor and clears the gate with preserved
precision.

> **If a future re-measurement pushes a lens over the gate.** Should a lens's
> `/workflows`-reported actuals later land above ~5× with no precision gain
> (e.g. a lens whose dimensions overlap heavily, inflating cross-check cost
> without surfacing new true positives), the remediation is to pin that lens
> to `MANDREL_AUDIT_STRATEGY=sequential` as its documented default and record
> the No-Go rationale in this table — the dual path makes that a
> configuration change, not a code change, because the sequential fallback is
> always present.

**Degradation remains free and proven.** Every lens keeps its
capability-gated sequential fallback: on a non-Claude runtime, with workflows
disabled (`CLAUDE_CODE_DISABLE_WORKFLOWS=1` or `disableWorkflows: true`), or
on a host below the 2.1.154 floor, `selectAuditStrategy` returns `sequential`
and the lens markdown runs turn-by-turn against the identical report
contract. This is verified by `tests/dynamic-workflow-capability.test.js` and
the per-lens report-contract conformance tests under `tests/contract/`.
