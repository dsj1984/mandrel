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
12. **Dist structure checks** for submodule consumers.

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

## Part 2 — Product-Readiness Backlog (If/When Mandrel Is Productized)

Last triaged: 2026-05-30 (against `.agents/VERSION` 1.40.0).

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

- `.agents/SDLC.md` states the framework is "Claude Code-first" and runs Story
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

---

### Candidate epic E-B — Distribution & release productization

**Findings:** 3, 18 (remainder).

#### Finding 3 — Distribution is not productized

Evidence:

- Root `package.json` has no `bin`, `files`, `publishConfig`, or `workspaces`,
  and empty `description`/`keywords`/`author`. (Intentional: it is the framework
  repo, distributed via the `dist` submodule branch, not a published package.)
- `create-mandrel/package.json` is version `0.0.0` and is not a root workspace.
- `create-mandrel/index.js` hardcodes `https://github.com/dsj1984/mandrel.git`.
- `.github/workflows/ci.yml` "publishes" only by copying `.agents/` to `dist`;
  it does not publish npm packages.

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

- `release-please` manages the root package and `.agents/VERSION`; `dist` sync
  copies `.agents/` after main merge; major bumps are intentionally capped
  (`always-bump-minor`).
- Paid products additionally need: a formal version/support policy, deprecation
  policy, rollback guidance, cross-version config-compatibility tests, automated
  migration checks for breaking changes, and operator-facing release notes
  (beyond commit-derived changelog entries).

---

### Candidate epic E-C — Deterministic QA harness

**Finding:** 5.

Today `run-qa-harness.md` is by design a **prose** workflow: the host LLM drives
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

#### Finding 11 — Configuration surface is large and hard to productize

Evidence: `.agents/full-agentrc.json` is ~274 lines of low-level knobs; the
`starter-agentrc.json` seed is ~21 lines — a large gap between first-look and
full surface.

Remediation direction: product config profiles (solo/local, team/GitHub,
enterprise, QA-only, audit-only); generated per-stack examples; `mandrel doctor`
/ config-explain commands; versioned config migrations with actionable upgrade
messages.

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

Evidence: the README assumes Git submodules, GitHub remotes, `gh`, and slash
commands; `.agents/README.md` is framework-author oriented; docs are scattered;
there are no screenshots, demo videos, tutorials, sample repos, comparison
pages, pricing pages, or a "first successful run" path.

Remediation direction: a product landing README (who it's for, outcomes,
constraints, 15-minute demo path); sample repos + scripted demos; scenario
guides (plan an epic, deliver a story, run QA, recover a blocked run, update
Mandrel); symptom-first troubleshooting. Includes the cheap "declare the scope"
messaging that says Mandrel is Claude-Code-first and GitHub-first by design
(the underlying facts from Findings 1 & 2).

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
3. **E-C QA harness** and **E-B distribution** — parallel product builds.
4. **E-D enterprise** and **E-E platform matrix** — gate on first enterprise
   prospect.

