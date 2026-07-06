# Mandrel Roadmap

> **Not a scheduled roadmap.** This file is the single home for Mandrel's
> standing forward-looking analyses. Nothing here is a committed plan — every
> entry is deferred work, preserved so the analysis is not lost. An item
> **graduates out** when it is filed as an Epic/Story and ships; the durable
> *analysis* behind it stays as reference.
>
> **Last reviewed:** 2026-06-13 against framework version 1.62.0.

## 🧭 Legend

| Tag             | Meaning                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔜 **Next**     | Actionable now under today's frontier model — schedule like any backlog item.                                                                                   |
| 🌅 **Someday**  | Parked / Monitor. The motivation is a stronger model, better inference economics, or an external trigger. Re-price at the next tier or when the trip-wire fires. |
| 🚪 **Gated**    | Blocked on the one open product decision — *"productize or stay internal?"* (Part 2). Build nothing here until that call is made.                                |
| 🔒 **Keep**     | An invariant guarantee or guardrail. Not work — it is what must *not* be removed or relaxed as the harness shrinks.                                              |

The three named **Parts** below are stable reference anchors cited from code
and rules (`capability.js`, `planning-risk.js`,
[`git-conventions.md`](../.agents/rules/git-conventions.md), the `audit-*`
workflows). Their **titles** are load-bearing; the content inside them is
renumbered freely. Issue numbers are point-in-time citations, not maintained
across renumbers.

## 🗺️ Roadmap at a glance

### 🔜 Next

1. **Personas → review checklists** — convert full persona prose to concise
   role lenses; stop injecting full prose into execution prompts by default.
   *(Part 1 · M1.)*
2. **Trim the chat-relay carried tail** — delete the relay / relay-suppression
   plumbing now that the structured comment is the canonical progress surface.
   *(Part 1 · M2.)*
3. **OIDC Trusted Publishing** — migrate npm publish off `NPM_TOKEN` to trusted
   publishing
   ([#3559](https://github.com/dsj1984/mandrel/issues/3559)). Not gated.
   *(Part 2 · E-B.)*
4. **Re-baseline decomposition quality** on the uniform sizing profile — the
   prerequisite that unblocks the fan-out decomposition spike. *(Part 3.)*
5. **Broaden install-scenario coverage** beyond the install-matrix legs
   ([#3735](https://github.com/dsj1984/mandrel/issues/3735)). Not gated.
   *(Part 2 · E-E.)*

### 🌅 Someday

1. **Instruction-surface compression** — sequence behind M1. *(Part 1 · M3.)*
2. **Stack non-negotiables → validators / lint** — open carried tail of the
   capsule-only hydration cutover. *(Part 1 · M4.)*
3. **Anti-thrashing / FinOps → observability** — gated on inference economics.
   *(Part 1.)*
4. **Worktree demotion to an implementation option** — gated on agent platforms
   shipping reliable per-task sandboxes
   ([#2870](https://github.com/dsj1984/mandrel/issues/2870), watch). *(Part 1.)*
5. **Fan-out epic-plan decomposition spike** — unblocked; runs after the
   re-baseline (🔜 Next). *(Part 3.)*
6. **Generalize the 7 remaining sequential-only audit lenses** — each per-lens
   cost-gated; several may stay sequential by design. *(Part 3.)*
7. **Dynamic spec / Gherkin mutation engine** — trip-wire gated. *(Part 1.)*
8. **Sub-agent capability-limit re-spike** after a Claude Code upgrade
   ([#2870](https://github.com/dsj1984/mandrel/issues/2870)). *(Part 1 · Part 3.)*

### 🚪 Gated — "Productize or stay internal?"

1. The entire **Product-Readiness Backlog** — E-A runtime/ticketing
   portability, E-B paid-support release maturity, E-C deterministic QA runner,
   E-D enterprise/compliance, E-E platform-matrix breadth, E-F external
   positioning. None of it blocks internal use. *(Part 2.)*

> **Shipped since the last review (2026-06-11 → 06-13), for context.** The
> kernel-shrink direction kept landing: the 2-tier hierarchy hard cutover
> (Epic → Story, no Feature tier) and command collapse to `/plan` / `/deliver`;
> the `mandrel init` / `update` / install-contract CLI suite (single-command
> cold start, truthful upgrade loop, `/onboard` folded into `mandrel init`); a
> sixth orchestrated audit lens (`/audit-documentation`); architecture /
> dead-export / import-cycle CI gates wired to fail PRs; native GitHub
> `blocked_by` dependencies from the Story graph; and a ~40-story
> audit-remediation wave clearing real findings from the Part 3 lenses. These
> are recorded here only to explain why items left this file.

## Part 1 — Model-Evolution Audit: Mandrel Under a Frontier Coding Model

First written 2026-05-21 as a thought experiment ("what changes when the model
is ~10x stronger?"); since 2026-06-09 this is reviewed *on* a frontier-tier
model rather than in anticipation of one. The "tackle now" cluster has shipped
(capsule-only hydration #3863, sub-agent return-repair shrink #3864, and the
capability-sized-stories / model-judged-risk recalibration #3865). What remains
is the parked Monitor residue (M1–M4), the invariants that must not relax, and
one deferred capability.

### The thesis

A materially stronger coding model lets Mandrel become **less of an instruction
cage and more of a thin orchestration harness around durable external
guarantees**. The harness's defensible value is what the model cannot provide
for itself: it *records, validates, isolates, and gates side effects*. Anything
that merely tells the model to think harder is a retirement candidate.

Four review verdicts classify every surface: **Keep** (protects external state,
security, concurrency, reproducibility, or human governance), **Simplify**
(still useful but much lighter), **Retire** (exists only to patch model
weakness), **Reframe** (keep the capability, change it from procedural
instruction to declarative policy or machine-validated contract).

### 🔒 Keep — invariant guarantees

These stay even for substantially stronger models, because each is an
independent guarantee, not a model crutch:

1. **GitHub as external SSOT** — ticket hierarchy, labels, PRs, branch
   protection, operator-visible audit history.
2. **Deterministic validators** — config, tickets, dispatch manifests,
   lifecycle events, structured comments, baseline envelopes, risk verdicts.
3. **CI and local quality gates** — lint, format, tests, coverage,
   maintainability, CRAP, dependency audits, secret scanning, and the newer
   architecture-cycle / dead-export / action-pinning gates.
4. **Branch and worktree isolation** for concurrent execution.
5. **Lifecycle ledger** for resumability and side-effect ordering.
6. **Security baseline** ([`security-baseline.md`](../.agents/rules/security-baseline.md))
   and destructive-action HITL gates — these encode operator risk appetite, not
   model capability, and are inviolable.
7. **Provider abstraction** for ticketing / GitHub API isolation.
8. **Declarative re-plan and reconcile** instead of destructive ticket deletion.
9. **PR-only promotion to `main`** with required checks.
10. **Structured comments** as durable workflow artifacts.
11. **BDD / acceptance evidence paths** when user-facing outcomes are in scope.
12. **Distribution-integrity checks** for npm consumers (`mandrel doctor`, sync
    drift detection, compatibility matrix).

### Target architecture — a four-layer kernel

The destination is a smaller kernel: **Policy** (compact, canonical rules cited
by generated context — security, testing, git/branch safety, docs,
destructive-action and release gates); **State** (durable external truth —
GitHub Issues/Labels/Projects/PRs, structured comments, lifecycle ledgers under
`temp/`); **Deterministic Kernel** (config resolution, ticket reconciliation,
DAG scheduling, worktree setup/cleanup, state transitions, validation gates,
baseline checks — Mandrel's main defensible value); and **Judgment** (the model
owns planning, decomposition, code review, audit/retro synthesis, risk
classification, with the harness validating shape, evidence, and side effects
rather than prescribing each reasoning step).

### Established baseline (shipped — context for the guardrails)

Two design decisions from the #3865 recalibration are referenced by the
guardrails and Part 3 and are recorded here as the current baseline:

- **One uniform sizing profile — sizing decoupled from risk.** Every Epic, at
  any risk level, plans under one relaxed `DEFAULT_TASK_SIZING`
  ([`ticket-validator-sizing.js`](../.agents/scripts/lib/orchestration/ticket-validator-sizing.js)):
  `softFiles: 15`, `hardFiles: 30`, `softAcceptanceCount: 10` (acceptance
  mass is advisory-only — the hard `maxAcceptance` ceiling was removed after
  the Epic #4355 decomposition experiment). There is **no** per-Feature
  fan-out cap — the Feature
  tier itself was removed by the 2-tier hard cutover (Story #4041). `wide`
  (with a reason) is the only beyond-ceiling path. Story size measures uniform
  delivery capacity; risk routes *rigor*, not scope.
- **Risk is model-judged.** The keyword-regex classifier is deleted; the
  planner authors a `risk-verdict.json` (validated against
  [`risk-verdict.schema.json`](../.agents/schemas/risk-verdict.schema.json)) and
  the pure helper `deriveRiskEnvelope`
  ([`planning-risk.js`](../.agents/scripts/lib/orchestration/planning-risk.js))
  derives gate routing deterministically. The judged envelope routes
  code-review depth **and** post-delivery audit lenses.

### Forward-looking residue — parked Monitor findings

These are the live remainders of the audit. Each is 🔭 Monitor: park until a
stronger model, better economics, or an external platform moves the
cost/benefit, then re-evaluate.

#### M1 — Personas → review checklists 🔜

**Verdict:** Simplify · **Next up.** Persona files
(`.agents/personas/*.md`, 90–107 lines each) compensate for role drift on
current models; a stronger model infers the role from the task and artifact.
Convert them into concise review checklists / role lenses, stop injecting full
persona prose into execution prompts by default, and keep explicit persona
labels only for audit/review assignment (preserving security/release personas
as optional high-risk review modes). **Why now:** the capsule-only hydration
flip (#3863) changed how much persona prose matters; sequence this once role
drift is measured on the frontier tier — it is the obvious next compression.

#### M2 — Trim the chat-relay carried tail 🔜

**Verdict:** Retire (scoped). The canonical progress surface is now a
structured comment, so the per-Story chat-relay and relay-suppression plumbing
is dead weight. Concrete, verifiable cleanup: live relay text remains at
[`deliver-epic.md`](../.agents/workflows/helpers/deliver-epic.md),
[`deliver-stories.md`](../.agents/workflows/helpers/deliver-stories.md), and
[`epic-deliver-story.md`](../.agents/workflows/helpers/epic-deliver-story.md).
This is the open remainder of the return-extraction deletion (#3864).

#### M3 — Instruction-surface compression 🌅

**Verdict:** Simplify / Reframe. `instructions.md`, the rules, and skill prose
still encode a large procedural scaffold (persona routing, context-reading
rituals, branch hygiene, testing discipline). Compress overlapping guidance
into checkable constraints and prefer machine-readable "when does this apply"
metadata over asking the model to read and self-select large markdown.
**Why parked:** a standalone rewrite epic is premature — compress
opportunistically as M1 lands, since M1 changes how much of this surface is
even loaded.

#### M4 — Stack non-negotiables → validators / lint 🌅

**Verdict:** Reframe. The capsule-only hydration cutover (#3863) deliberately
built no new validators — capsules carry the stack-specific non-negotiables as
prose for now. Push the remaining hard constraints into validators or lint
checks so they are machine-enforced rather than re-read every task. **Why
parked:** no validator exists yet; the loader only extracts capsules, it does
not validate.

#### Also parked (no near-term trigger)

- **Anti-thrashing / FinOps → observability** 🌅 — numeric step limits and
  `friction.*` thresholds are already gone from
  [`limits.js`](../.agents/scripts/lib/config/limits.js); anti-thrashing is now
  qualitative prose. The remainder — relaxing per-turn rituals to job/run-level
  — waits on future inference economics.
- **Worktree demotion to an option** 🌅 — worktree/branch isolation stays
  **Keep** today (concurrency physics, not model capability). Demoting local
  worktrees to an implementation option is contingent on future agent platforms
  shipping reliable per-task sandboxes; track alongside the sub-agent
  capability spike ([#2870](https://github.com/dsj1984/mandrel/issues/2870)).
- **`typhonjs-escomplex` abandonware risk** 🔭 — the complexity kernel behind
  the CRAP and maintainability-index gates
  ([`crap-engine.js`](../.agents/scripts/lib/crap-engine.js),
  [`crap-utils.js`](../.agents/scripts/lib/crap-utils.js)) is pinned at its
  terminal `0.1.0` (last code release 2018-12-21; no new version in ~7.5
  years). It is the one runtime dependency with a real bus-factor problem, but
  it is **deliberately not swapped**: being a 0.x at its final version it never
  silently churns, it is pure JS (no `node-pty`-style native fragility), and it
  carries no reachable CVE. Its resolved version is stamped into every
  committed baseline envelope (`resolveEscomplexVersion()` in `crap-utils.js`,
  consumed by `update-crap-baseline.js` / `update-maintainability-baseline.js`)
  and asserted as a hoisted consumer runtime dep in `install-matrix-assert.js`,
  so **any** replacement (`ts-complex`, another `escomplex` fork, or a bespoke
  AST walker) produces different MI/Halstead/CRAP numbers and invalidates
  every `crap-baseline*` / `maintainability-baseline*` plus the floors in
  `.agentrc.json` (`crap.max: 30`, `maintainability.min: 70`). Treat a swap as
  its own Epic with a full baseline recut, never a dependency bump.
  **Trip-wire to revisit (either triggers):** (a) a CVE is filed against it, or
  (b) it fails to install or parse under a future Node major. Renovate is
  pinned off for this package (`renovate.json`) so it is never auto-bumped;
  monitor only until a trip-wire fires.
- **`typescript` peer floor stays `>=5.0.0`** 🔒 — both the `devDependencies`
  and the optional `peerDependencies` declare `typescript >=5.0.0` even though
  the compiler resolves to 6.x locally. The peer floor is **intentionally a
  permissive floor, not a pin**: consumers on TS 5 *or* 6 stay compatible, and
  raising it would be a consumer-visible break under the hard-cutover policy.
  The dev floor is left at `>=5.0.0` too (the optional raise to `^6.0.0` is
  hygiene-only and was declined here to avoid a lockfile churn and any risk to
  the CRAP/maintainability TS-transpiler step; the project `typecheck` is a
  no-op so there is no typecheck to break either way). Renovate is pinned off
  for this package (`renovate.json`). **Watch:** TS 6 removed long-deprecated
  flags — only relevant if the maintainability transpiler config ever adopts a
  removed option.

### 🔒 Guardrails that must not relax

As the harness shrinks and Stories get wider, these stay hard:

- **Worktree/branch isolation and the wave model stay as-is** — wider Stories
  increase per-Story wall-clock, which the concurrency cap already governs.
- **Hard ceilings stay hard** — they move up, they do not become advisory.
  `wide` remains the only beyond-ceiling path and keeps requiring a reason.
- **Adaptive review depth stays coupled to scope.** A wide Story under
  fixed-depth review is strictly worse than today; depth must keep routing off
  the judged risk envelope so larger Stories never get shallower review.
- **Rigor follows risk, never scope.** High-risk work gets deeper review and
  auto-run audit lenses, never silently lighter treatment; the model-judged
  verdict stays schema-validated and the harness owns the gate decision
  deterministically. `security-baseline.md` inviolability is untouched.

### 🌅 Deferred capability — dynamic spec / Gherkin mutation

A 2026-06-01 feasibility spike evaluated mutating acceptance scenarios (e.g.
flipping a `Scenario Outline` outcome cell) to detect step definitions that are
not actually pinned to the spec. Findings: generation is trivial but the
kill-step (re-running the slowest acceptance tier per mutant) is structurally
expensive as a framework default; only the Examples/parameter surface is
high-signal; and **most of the value is reachable statically**. The static
placeholder-reference lint shipped as the Phase-0 substitute
([`check-gherkin-placeholders.js`](../.agents/scripts/check-gherkin-placeholders.js)).

**Trip-wire to revisit (both must hold):** (1) strong consumer demand on the
BDD/acceptance tier — the engine is useless to the non-BDD majority and to this
repo, which authors no `.feature` files; and (2) a dogfood fixture exists so the
engine ships exercised rather than theoretical. Until then, the static lint is
the supported surface.

## Part 2 — Product-Readiness Backlog 🚪 (If/When Mandrel Is Productized)

Gated on a single product decision; recorded so the readiness analysis is not
lost. Mandrel is today an **internal, single-operator, Claude-Code-first /
GitHub-first** framework that is dogfooded — none of the below blocks internal
use.

> **The gating decision — "Productize or stay internal?"** This one call gates
> the bulk of the work below. If Mandrel stays internal, none of these epics
> should be filed. The framework has already declined to build this
> speculatively: the GitHub-optional / lite-mode epic
> ([#3439](https://github.com/dsj1984/mandrel/issues/3439)) was closed
> `NOT_PLANNED` (2026-06-07) without being built, reverting its slices to the
> deferred remainders below.

**One near-term exception (not gated).** Migrating npm publish to OIDC Trusted
Publishing ([#3559](https://github.com/dsj1984/mandrel/issues/3559)) hardens the
*live* release pipeline (signed Sigstore provenance already ships; this retires
the long-lived `NPM_TOKEN`). It lives under E-B but is actionable now (🔜 Next).

### E-A — Runtime & ticketing portability (Findings 1, 2)

**Finding 1 — Claude Code-first, not runtime-neutral.** The manifest `executor`
is hardcoded to `"claude-code"`
([`manifest-builder.js`](../.agents/scripts/lib/orchestration/manifest-builder.js)),
and Story sub-agents run inside the operator's Claude session — intentional, and
only a gap under productization. *Direction:* decide positioning ("Mandrel for
Claude Code" vs "across runtimes"); if neutral, introduce an execution-provider
contract with conformance tests, stable dispatch I/O, capability discovery, and
≥1 non-Claude implementation.

**Finding 2 — Ticketing and state are GitHub-locked.**
[`provider-factory.js`](../.agents/scripts/lib/provider-factory.js) registers
only `github`, with a dormant `config.provider` discriminator. A 2026-06-03
architecture review found the lock is **two axes, not one** — the tracker
(issues, state, hierarchy, comments) and the VCS/delivery host (branches, PRs,
merge, CI gates) are fused because GitHub is both. The construction seam
(`createProvider`) is clean, and the `agent::*` / `type::*` label vocabulary is
provider-agnostic string data, but the heaviest blockers are: PR/merge/CI-gate
delivery shells out to `gh pr …` below the provider seam; labels **are** the
state (no abstract lifecycle); `gh-exec` is the universal transport; integer
issue identity is assumed pervasively; and the git branch / worktree / epic→main
PR model is hardcoded. *Direction:* make GitHub-only an explicit product scope,
or split tracker vs VCS interfaces, add a provider conformance suite, and ship a
labels-as-state lifecycle layer plus ≥1 non-GitHub provider. The cheap
interface-segregation half (board / repo-config accessors) was orphaned when
epic #3439 closed unbuilt, and reverts here.

### E-B — Distribution & release productization (Finding 18 remainder)

npm distribution and the auto-update lifecycle shipped (#3436 / #3437); the
package is `mandrel`, published with signed Sigstore provenance under a
single-package release-please topology with namespaced `mandrel-vX.Y.Z` tags.
*Deferred remainder (productize-gated):* a formal version/support policy,
deprecation policy, rollback guidance, and operator-facing release notes beyond
commit-derived changelog entries. *Near-term (not gated):* the OIDC
Trusted-Publishing migration ([#3559](https://github.com/dsj1984/mandrel/issues/3559)).

### E-C — Deterministic QA harness (Finding 5)

`qa-run` is by design a **prose** workflow: the host LLM drives a
`chrome-devtools` MCP surface, there is no headless fallback, and it never files
tickets autonomously. New human-led / agent-led QA loops (`qa-assist`,
`qa-explore`) added ledgered, resumable QA but are **not** deterministic CI
runners, so the gap stands. *Direction (large enough to be its own product
line):* a deterministic runner with standard artifacts (JSON/JUnit, screenshots,
traces, redacted evidence bundles, stable exit codes), CI mode, retry/quarantine
policy, and compatibility docs — agent-assisted triage optional on top.

### E-D — Enterprise / commercial readiness (Findings 10–15)

- **Installation footprint (10).** Bootstrap mutates the consumer repo
  (`package.json`, `.claude/`, `.gitignore`, `CLAUDE.md`, GitHub labels/fields/
  branch-protection). Machine-readable dry-run, phased approval, and
  uninstall/rollback shipped (#3438); *deferred:* a minimal/no-mutation profile
  (orphaned by #3439) and enterprise permission docs.
- **Config surface (11).** `mandrel doctor`, config profiles, and versioned
  migrations shipped (#3435 / #3438 / #3437); *deferred:* generated per-stack
  config examples.
- **Observability (12).** Local NDJSON + GitHub comments + one generic webhook;
  *deferred:* a privacy-controlled telemetry model, OpenTelemetry/events API,
  trend/failure dashboards, retention/redaction/support-bundle tooling.
- **Cost controls (13).** Hydration-budget estimates + pre-dispatch preflight
  only; *deferred:* provider-level usage accounting and deterministic
  per-run/project/user budgets.
- **Security & compliance (14).** Positives: CI `npm audit` + TruffleHog,
  `ignore-scripts=true`, signed provenance, and an **enforced third-party
  action-pinning gate**
  ([`check-action-pinning.js`](../.agents/scripts/check-action-pinning.js)).
  *Deferred procurement gates:* no `SECURITY.md`, vulnerability-disclosure
  process, SBOM, dependency-license report, or enterprise data-handling docs.
- **Control plane (15).** Delivery runs locally in one operator's session; the
  framework ships no MCP server or remote-trigger surface by design. *Deferred:*
  decide local-first vs hosted; if hosted, define runs/agents/credentials/audit/
  queues/policies/billing/org-admin.

### E-E — Platform matrix & product-level e2e (Findings 9, 17)

The Windows smoke leg (#3389) and the install-matrix gate (`{npm, pnpm, yarn} ×
{ubuntu, windows}`, 2-leg required + 6-leg nightly) shipped, and the test suite
is large (~786 `*.test.js`). *Residual gap:* macOS legs, a multi-Node-version
axis, a published support matrix (OS/shell/Node/git/CLI/package-manager/host),
disposable-repo e2e smoke, and nightly dogfood runs. Broader install-scenario
coverage is tracked at
[#3735](https://github.com/dsj1984/mandrel/issues/3735) (near-term, 🔜 Next).

### E-F — External positioning, UX & onboarding (Findings 16, 6 remainder)

The README is reconciled to the npm-package + `mandrel sync` model and
onboarding is folded into `mandrel init` (no separate onboard command).
*Deferred remainder:* a product landing README (who it's for, outcomes, a
15-minute demo path), sample repos + scripted demos, scenario guides,
symptom-first troubleshooting, and pricing/comparison pages — plus surfacing
`WEBHOOK_SECRET` (outbound webhook signing exists in
[`notify.js`](../.agents/scripts/notify.js)) in the onboarding path and a full
product-claims-vs-code inventory converting high-value guarantees into
executable acceptance/contract tests.

### Recommended sequencing (only on a productize decision)

1. **E-F positioning** — cheapest; removes the "promises broad, delivers
   narrow" tension.
2. **E-A portability** — the biggest scope multiplier; decide runtime/ticketing
   neutrality early because it shapes everything else.
3. **E-C QA harness** — parallel product build.
4. **E-D enterprise** and **E-E platform matrix** — gate on first enterprise
   prospect.

## Part 3 — Dynamic-Workflow Orchestration: Evidence & Per-Lens Cost Gate

The durable home for the orchestrated-audit evidence and the per-lens
cost/precision gate verdicts. The pattern (parallel per-dimension analysis →
adversarial cross-check → synthesis + report-contract self-check) is standing
infrastructure: one shared engine, `runAuditOrchestration`, behind each lens's
own report contract.

### The per-lens cost / precision gate (governing rule)

Generalize a lens to the orchestrated default only when its measured
orchestrated cost is justified by a precision gain. **No-Go for a lens**
(sequential-only) when the measured token multiple exceeds **~5×** the
sequential pass over the same scope **with no precision gain** — past that, the
trade is not worth defaulting to fan-out.

If a future re-measurement pushes a lens over the gate (e.g. heavily
overlapping dimensions inflate cross-check cost without surfacing new true
positives), pin it to `MANDREL_AUDIT_STRATEGY=sequential` as its documented
default and record the No-Go rationale below — the dual path makes that a
configuration change, not a code change.

### Measured evidence (point-in-time anchor, 2026-06-04)

`audit-clean-code` ran orchestrated end-to-end through its saved artifact
([`audit-clean-code.workflow.js`](../.claude/workflows/audit-clean-code.workflow.js))
on a host above the dynamic-workflow floor (`DYNAMIC_WORKFLOW_VERSION_FLOOR =
2.1.154` in
[`capability.js`](../.agents/scripts/lib/dynamic-workflow/capability.js)).
Over the framework's own `.agents/scripts/**` (≈596 files / ~127k LOC at the
time), 11 analysis dimensions fanned out to **23 agents** (11 analyze + 11
adversarial cross-check + 1 synthesis), **~2.47M tokens**, ~20.6 min wall-clock.
Effectiveness: 51 findings → **49 kept, 2 dropped (~4%)**; the cross-check did
**not** over-filter — its real value was *tightening* (e.g. correcting an
inflated cyclomatic claim, dropping a "dead module" that was live), with
precision preserved. The blocking condition ("the cross-check must not
over-filter true positives") is **satisfied**. *The file-count is stale by
design — this is a historical record, not a forward claim.*

### Orchestrated roster & per-lens verdicts

**Six** lenses are now orchestrated (each with a `.claude/workflows/*.workflow.js`
artifact, all routed through `runAuditOrchestration`); all cleared the ~5× gate
when generalized.

| Lens                  | Dims | Token multiple (orch ÷ seq) | Precision        | Verdict                       |
| --------------------- | ---- | --------------------------- | ---------------- | ----------------------------- |
| `audit-clean-code`    | 11   | **~4.9× (measured)**        | ≥ baseline (~4% drop, tightens) | GO — measured anchor |
| `audit-security`      | 7    | ~3.3× (projected)           | expected ≥ baseline | GO — well within gate      |
| `audit-performance`   | 10   | ~4.6× (projected)           | expected ≥ baseline | GO — within gate           |
| `audit-architecture`  | 6    | ~2.8× (projected)           | expected ≥ baseline | GO — well within gate      |
| `audit-quality`       | 6    | ~2.8× (projected)           | expected ≥ baseline | GO — well within gate      |
| `audit-documentation` | ~5   | — †                         | expected ≥ baseline | GO — generalized #4024     |

> † `audit-documentation` was generalized to orchestrated after the original
> gate analysis (#4024, 2026-06-11). It shares the read-only,
> dimensionally-decomposable shape (~5 dimensions: command/path/contract/
> version/completeness references) and so clears the same gate; it was not
> separately token-re-measured.

**Degradation remains free and proven.** Every lens keeps its capability-gated
sequential fallback: on a non-Claude runtime, with workflows disabled
(`CLAUDE_CODE_DISABLE_WORKFLOWS=1` or `disableWorkflows: true`), or below the
2.1.154 floor, `selectAuditStrategy` returns `sequential` and the lens runs
turn-by-turn against the identical report contract — verified by
`tests/dynamic-workflow-capability.test.js` and the per-lens report-contract
tests under `tests/contract/`.

### 🌅 Remaining orchestration surface

**Seven** audit lenses are still sequential-only with no workflow artifact:
`audit-dependencies`, `audit-devops`, `audit-sre`, `audit-privacy`,
`audit-seo`, `audit-ux-ui`, `audit-lighthouse`. That is not a backlog by
default — several are externally bound (`audit-lighthouse` drives a browser;
`audit-seo` / `audit-ux-ui` are page-walk-shaped) or not cleanly dimensionally
decomposable, so sequential may stay the *correct* default. Any generalization
must clear the per-lens cost/precision gate above, lens by lens — **do not
batch-convert.**

### Beyond audits — fan-out epic-plan decomposition (spike)

The fan-out → adversarial cross-check → synthesis shape maps onto **epic-plan
decomposition**: draft Stories in parallel sub-agents, then run an adversarial
consolidation pass that applies the single-consumer merge rule, capability
grouping, and the holistic consolidation checks across the whole plan at once.
Today's consolidation runs in one context; a fan-out version would trade tokens
for plan quality the way the audit lenses do.

**Status: 🌅 Monitor, now unblocked.** Hold it to the same discipline as the
audit gate (a measured plan-quality delta vs token multiple before it becomes a
default, sequential as the capability-degraded fallback). The prerequisite
(🔜 Next) is to re-baseline decomposition quality on the new uniform sizing
profile first, since over-slicing was the dominant plan defect and may disappear
without orchestration.
