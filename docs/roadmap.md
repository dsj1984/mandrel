# Mandrel Roadmap

> **Not a scheduled roadmap.** This file consolidates Mandrel's standing
> forward-looking analyses into one place. None is a committed plan — all
> are deferred-work catalogs, preserved so the analysis is not lost. Work
> graduates out of here when it is filed as an epic.
>
> - **Part 1 — Model-Evolution Audit** asks how the harness should evolve as
>   coding models get materially stronger (keep / simplify / retire / reframe).
> - **Part 2 — Product-Readiness Backlog** catalogs what would be required *if
>   and when* Mandrel is productized for external customers; it is gated on a
>   "productize or stay internal?" decision and blocks no internal use today.
> - **Part 3 — Dynamic-Workflow Orchestration** is the durable home for the
>   orchestrated-audit evidence and the per-lens cost/precision gate verdicts.
> - **Part 4 — Frontier-Model Calibration (2026-06-09)** re-prices Part 1's
>   🔭 Monitor items now that a frontier-tier model is the daily driver, and
>   scopes the **story-size recalibration** for epic planning/decomposition.
>   Its "tackle now" cluster has graduated: Stories #3863/#3864 shipped and
>   the recalibration shipped as Epic #3865 — one uniform relaxed sizing
>   profile plus a model-judged risk verdict that routes review depth and
>   audit lenses (§ 4.3).

## Part 1 — Model-Evolution Audit: Mandrel Under a 10x Coding Model

Date: 2026-05-21 (last reviewed 2026-06-09 — frontier-model review; action
tags below were re-priced, see [Part 4 § 4.1](#41-still-parked-monitor-findings-part-1))

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

Carried tails (open remainders of findings that shipped and were deleted
per the numbering convention):

- Push remaining stack-specific non-negotiables into validators or lint
  checks rather than skill prose — the capsule-only hydration cutover
  (Story #3863) deliberately did not build new validators; capsules carry
  the non-negotiables for now.
- Trim chat-relay instructions in `epic-deliver.md` / `story-deliver.md`
  now that the canonical progress surface is a structured comment — the
  open remainder of the return-extraction deletion (Story #3864).

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

#### 3. Worktree and Branch Isolation Still Matter

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

#### 4. Anti-Thrashing and FinOps Should Be Softer

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

These should be removed or made opt-in once future-model assumptions hold
(the skill-hydration and return-extraction entries that used to live here
shipped — Stories #3863 / #3864 — and were removed):

1. **Mandatory full persona hydration** for common tasks. Replace with
   concise role lenses and on-demand deep docs — the persona-side parallel
   of the shipped capsule-only skill cutover (Finding #2).

### Functionality Greatly Simplified

These remain useful but should become smaller:

1. **Context hydration**: continue tightening structured, prioritized
   context envelopes; full skill bodies are no longer hydrated (capsule-only
   since Story #3863).
2. **Personas and skills**: concise lenses and policies, not full behavioral
   scripts loaded into the model.
3. **Code review**: adaptive evidence-first review with structured findings,
   not a mandatory identical six-pillar ritual every time (adaptive depth
   shipped in Epic #3865; depth now routes off the judged risk envelope).
4. **Telemetry**: keep aggregate signals; reduce control-flow dependence on
   friction counters. (Numeric step limits and `friction.*` thresholds are
   already gone from `lib/config/limits.js`; the remainder is keeping it
   that way as new signals land.)

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

The audit's original five-phase roadmap has shipped
(Epics #2649, #2648, #2647, #2646, #2645, #2586). The remaining
forward-looking work clusters
into three areas:

#### Reduce Prompt Weight Further

- Push remaining stack-specific non-negotiables into validators or lint
  checks rather than skill prose (carried tail of the shipped capsule-only
  cutover, Story #3863 — see Finding #1).
- Trim chat-relay instructions in `epic-deliver.md` / `story-deliver.md`
  now that the canonical progress surface is a structured comment (carried
  tail of Story #3864 — see Finding #1).

#### Soften Procedural Defaults

- Convert persona prose into concise review checklists (Finding #2).
- Treat anti-thrashing / FinOps as observability rather than control
  flow when inference economics permit (Finding #4).

### Priority Recommendations

1. **Keep the deterministic kernel.** Do not remove schemas, CI, branch
   protection, lifecycle ledgers, worktree isolation, or state-transition
   scripts just because the model is stronger.
2. **Shrink the instruction layer further.** Compact policy capsules now
   exist and the hydrator loads capsule-only (Story #3863 shipped that flip);
   the next move is the parallel persona-hydration cut (Finding #2).
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

Last triaged: 2026-06-11 against framework version 1.59.0 (status refresh:
every filed epic from the 2026-05-30 and 2026-06-02 triages has now resolved.
Eight **delivered**; [#3439](https://github.com/dsj1984/mandrel/issues/3439)
(GitHub-optional / no-mutation lite profile) was **closed unbuilt as
`NOT_PLANNED` on 2026-06-07** — its lite-mode and provider-interface
segregation slices were never delivered and have reverted to the deferred
backlog below. No filed epic remains open; prior triages 2026-06-02 and
2026-05-30).

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

### Already delivered (do not re-scope here)

Two triages (2026-05-30 and 2026-06-02) carved the immediately-actionable,
internally-valuable slices into nine epics. **Eight delivered**
(all closed 2026-06-05): #3386 (truth & correctness), #3387 (3-tier doc
cutover), #3388 (config integrity), #3389 (dev-hygiene), #3435
(`mandrel doctor` + installer/content partition), #3436 (npm distribution —
supersedes E-B's core), #3437 (auto-update & version lifecycle), #3438
(consent-first install & onboarding). The ninth,
[#3439](https://github.com/dsj1984/mandrel/issues/3439) — GitHub-optional /
no-mutation (lite) profile, re-scoped 2026-06-03 to include the
provider-interface segregation slice — was **closed `NOT_PLANNED`
(2026-06-07) without being built**; its scope reverts to the deferred
remainders under Finding 2 / E-A and Finding 10 / E-D below.

Findings 3, 4, 7, 8 are fully resolved by the delivered epics and do not
appear below. Findings 2, 6, 9, 10, 11, 14, 16, 18 were partially filed;
only their **deferred remainders** appear below — the "filed slice" notes
on each finding record where the delivered portion went.

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

**Filed then dropped (2026-06-02 → 2026-06-07):** the Projects-V2 /
branch-protection decoupling — an Issues-only "no-mutation" (lite) mode —
was filed as [#3439](https://github.com/dsj1984/mandrel/issues/3439) and,
following the architecture review below, re-scoped to also perform the
**provider-interface segregation slice**: splitting `ITicketingProvider` into a
core ticketing contract plus optional, nullable `IProjectBoardProvider` /
`IRepoConfigProvider` capability accessors, with lite mode expressed as a GitHub
provider missing those two capabilities. **#3439 was closed `NOT_PLANNED` on
2026-06-07 without being built** — none of that landed (no capability-seam
split, no lite mode), so the entire slice is back on this deferred list. The
full provider-abstraction remainder (a provider conformance suite, a non-GitHub
provider implementation, the labels-as-state lifecycle layer, and the
VCS/delivery-axis split below) likewise stays gated on the productize decision.

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
- **Sequencing decision (2026-06-03, since voided).** The board / repo-config
  **interface segregation** (blocker #4's cheap half — the gateways are already
  isolated) was slated to be done first inside #3439, because lite mode needed
  the capability seam anyway. That epic was abandoned (`NOT_PLANNED`,
  2026-06-07), so even this cheap half is **unstarted** and joins the deferred
  remainder. The expensive remainder — an abstract labels-as-state lifecycle
  layer (#2), the VCS/delivery-axis split (#1, #3, #6), string IDs (#5), a
  provider conformance suite, and any non-GitHub implementation — stays
  **gated** on the
  productize decision (this Finding 2 / E-A).

---

### Candidate epic E-B — Distribution & release productization

**Finding:** 18 (remainder). Finding 3 (distribution not productized) is
fully resolved — #3436 ships the framework as the `@mandrelai/agents` npm
package and #3437 covers the update lifecycle.

#### Finding 18 (remainder) — Release process is not ready for paid support

Context: `release-please` manages the root package version, and major bumps
are intentionally capped (`always-bump-minor`).

Deferred remainder (productize-gated): a formal version/support policy,
deprecation policy, rollback guidance, and operator-facing release notes
beyond commit-derived changelog entries. (Cross-version config-compat tests
and automated migration checks shipped with #3437.)

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
[#3438](https://github.com/dsj1984/mandrel/issues/3438) (delivered). The
minimal/no-mutation (Issues-only) profile was filed as
[#3439](https://github.com/dsj1984/mandrel/issues/3439) but **closed
`NOT_PLANNED` (2026-06-07) without being built**, so it is deferred again.
Deferred remainder: the minimal/no-mutation profile, plus enterprise docs for
required permissions.

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
`ignore-scripts=true`; npm releases publish with signed Sigstore provenance
(`publishConfig.provenance: true`, via #3436).

Deferred remainder (procurement gates): no `SECURITY.md`, vulnerability-
disclosure process, SBOM, dependency-license report, or enterprise
data-handling documentation. Add these plus a hardening guide and
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
3. **E-C QA harness** — parallel product build. (**E-B distribution
   delivered** — #3436 / #3437; only the Finding 18 paid-support remainder
   is left under E-B.)
4. **E-D enterprise** and **E-E platform matrix** — gate on first enterprise
   prospect.

---

## Part 3 — Dynamic-Workflow Orchestration: Evidence & Per-Lens Cost Gate

Recorded: 2026-06-05 (Epic #3597, Story #3615).

This part is the durable home for the orchestrated-path evidence and the
per-lens cost/precision gate verdicts produced while generalizing the
dynamic-workflow audit pattern (piloted on `audit-clean-code` under
Story #3278) to the four read-only, dimensionally-decomposable lenses —
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

### 3.3 Remaining orchestration surface (added 2026-06-09)

Seven audit lenses are still **sequential-only** with no
`.claude/workflows/*.workflow.js` artifact: `audit-dependencies`,
`audit-devops`, `audit-sre`, `audit-privacy`, `audit-seo`, `audit-ux-ui`,
`audit-lighthouse`. That is not a backlog by default — several are
externally bound (`audit-lighthouse` drives a browser; `audit-seo` /
`audit-ux-ui` are page-walk-shaped) or not cleanly dimensionally
decomposable, so sequential may stay the *correct* default. Any
generalization must clear the same § 3.2 per-lens cost/precision gate, lens
by lens; do not batch-convert.

Beyond audits, `runAuditOrchestration`'s fan-out → adversarial cross-check →
synthesis shape has one obvious next application: **epic-plan
decomposition** (parallel per-Feature Story drafting + an adversarial
consolidation pass). That candidate is scoped in
[Part 4 § 4.5](#45-orchestration-beyond-audits-spike-candidate) rather than
here, because its payoff is coupled to the story-size recalibration.

## Part 4 — Frontier-Model Calibration: Story Scope & Decomposition

Recorded: 2026-06-09, against framework version 1.54.0 (status refreshed
2026-06-11).

Part 1 was written against a hypothetical: "what changes when the model is
~10x stronger?" This part records the first review run **on** a
frontier-tier model rather than in anticipation of one. Its "tackle now"
cluster has since shipped — the three re-priced findings all landed (hydrator
flip #3863, sub-agent return-repair shrink #3864, and the story-scope /
risk-routing recalibration #3865). What remains forward-looking:
the still-parked Monitor findings (§ 4.1), the guardrails that constrain any
future scope relaxation (§ 4.4), and one unblocked spike candidate (§ 4.5).

### 4.1 Still-parked Monitor findings (Part 1)

> Finding numbers here are **point-in-time** against the audit as of
> 2026-06-09, per the Part 1 numbering convention. The three rows re-priced
> to ✅ Shipped (hydrator flip #3863, sub-agent return-repair #3864, adaptive
> code-review depth #3865) have since been deleted from Part 1 and the
> survivors renumbered (worktree is now Finding #3, anti-thrashing #4). The
> rows below stay on 🔭 Monitor.

| Finding | Status | Why it stays parked |
| ------- | ------ | ------------------- |
| #2 — personas → review checklists | 🔭 Monitor (**next up**) | Sequence after the capsule-only hydration flip's effect is measured: it changes how much persona prose matters; measure role drift on the frontier tier before converting. |
| #1 — instruction-surface compression | 🔭 Monitor | Compress opportunistically as #2 lands; a standalone rewrite epic is still premature. |
| worktree/branch isolation | 🔭 Monitor (Keep) | Unchanged — concurrency physics, not model capability. |
| anti-thrashing / FinOps | 🔭 Monitor (remainder only) | Numeric step limits already dropped from `lib/config/limits.js`; remainder waits on inference economics. |

### 4.2 Residual sizing levers (post-recalibration)

The small-story-bias analysis that drove the recalibration is complete — its
primary drivers (the per-Story file/acceptance ceilings and the
Feature-fan-out cap) were relaxed by Epic #3865 (§ 4.3). Three softer levers
were **not** touched and remain the only knobs left if a future review ever
wants to push Story scope wider still:

- `maxTickets: 60` reviewability budget (`lib/config/limits.js` + decomposer
  prompt) — attacks story *count*, already aligned with larger stories.
- Planning-context budget (`maxBytes: 50000`,
  `lib/orchestration/planning-context-budget.js`) — summarizes PRD/Tech Spec
  before decomposition, so less spec detail nudges toward conservative
  slicing.
- `delivery.maxTokenBudget: 300000` per-Story hydration cap
  (`lib/config/limits.js`) — large Story bodies risk section elision at
  delivery time.

None is currently a binding constraint, and the sizing constants are SSOT
and prompt-synced (the decomposer prompt interpolates `DEFAULT_TASK_SIZING`
rather than hardcoding it), so any further relaxation stays a one-line
constant change rather than a prompt rewrite.

### 4.3 Story-scope recalibration — shipped as Epic #3865

**Status:** ✅ **Shipped** — Epic
[#3865](https://github.com/dsj1984/mandrel/issues/3865) "Capability-Sized
Stories & Model-Judged Risk Routing" (2026-06-09). Recorded here only because
§ 4.4 and § 4.5 build on its two design decisions:

- **One uniform sizing profile — sizing decoupled from risk.** Every Epic, at
  any risk level, plans under one relaxed `DEFAULT_TASK_SIZING`
  ([`ticket-validator-sizing.js`](../.agents/scripts/lib/orchestration/ticket-validator-sizing.js)):
  `softFiles: 8`, `hardFiles: 30`, `softAcceptanceCount: 10`,
  `maxAcceptance: 14`, `SOFT_STORIES_PER_FEATURE: 7`. `wide` (with a reason)
  remains the only beyond-ceiling path. Story size measures uniform delivery
  capacity; risk routes *rigor*, not scope.
- **Risk is model-judged; the keyword regex is deleted.** `AXIS_RULES` is
  gone; the planner authors a `risk-verdict.json` (validated against
  [`risk-verdict.schema.json`](../.agents/schemas/risk-verdict.schema.json))
  and the pure helper `deriveRiskEnvelope` derives gate routing
  deterministically. The judged envelope routes code-review depth **and**
  post-delivery audit lenses — high-risk work gets deeper review/audit, not
  smaller Stories.

### 4.4 Guardrails that must NOT relax

- **Worktree/branch isolation and the wave model stay as-is** (Part 1's
  worktree finding) — larger Stories increase per-Story wall-clock, which
  the existing concurrency cap already governs.
- **Hard ceilings stay hard** — they move up; they do not become advisory.
  `wide` remains the only beyond-ceiling path and keeps requiring a reason.
- **Adaptive review depth must stay coupled to Story scope.** A wide Story
  under fixed-depth review would be strictly worse than today; depth must
  keep routing off the judged risk envelope (§ 4.3) so larger Stories never
  get shallower review.
- **Rigor follows risk, never scope.** High-risk work gets deeper review and
  auto-run audit lenses, never silently lighter treatment; the model-judged
  verdict stays schema-validated and the harness still owns the gate decision
  deterministically. `rules/security-baseline.md` inviolability is untouched.

### 4.5 Orchestration beyond audits (spike candidate)

**Status:** 🔭 Monitor — spike-sized, now unblocked: § 4.3 (Epic #3865)
has shipped, so decomposition quality can be re-baselined on the new
uniform sizing profile before this spike is scoped.

The Part 3 pattern (parallel fan-out → adversarial cross-check →
synthesis) maps onto **epic-plan decomposition**: draft Stories per Feature
in parallel sub-agents, then run an adversarial consolidation pass that
applies the single-consumer merge rule, capability grouping (#3858), and
the holistic consolidation checks (#3799) across the whole plan at once.
Today's Phase-8 consolidation runs in one context; a fan-out version would
trade tokens for plan quality the same way the audit lenses do.

Hold it to the same discipline as Part 3: a measured cost/precision gate
(plan-quality delta vs token multiple) before it becomes a default, and the
sequential path remains the capability-degraded fallback. The prerequisite
is met — re-baseline decomposition quality on the new uniform sizing profile
first, since over-slicing was the dominant plan defect and may disappear
without orchestration.
