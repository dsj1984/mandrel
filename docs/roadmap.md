# Mandrel Roadmap

> **Two sections.** (1) **v2.0.0** — **shipped**: collapse the
> ticket model to a single type (Story) and the delivery surface to a single
> path, with everything that rides along. This section is the design
> record for that cutover (kept for operators upgrading from 1.x).
> (2) **Someday** — strictly aspirational items and monitors that re-price
> on ~10x shifts in model capability, platforms, or economics. Operational
> dependency trip-wires live in the appendix. Prior roadmap analyses (the
> model-evolution audit, the product-readiness backlog, the orchestration
> evidence) are compressed here; their full text is preserved in git history
> (`docs/roadmap.md` @ `mandrel-v1.94.0`).
>
> **Last reviewed:** 2026-07-15 against framework version 2.0.0.

## 1. v2.0.0 — The Story collapse (shipped)

### Why

v1.94.0 made single-delivery the default: an epic-sized plan now ships as a
**spec-only Epic with zero child tickets**, delivered in one guarded session.
That end-state exposed the remaining fork: a spec-only Epic *was structurally a
Story with a bigger body*, yet the codebase still carried two ticket types and
two parallel stacks to serve them —

- two planning paths (`plan-epic.md` + `plan-story.md`, plus the scope-triage
  `epic|story` verdict and the bidirectional escalation seams between them);
- two delivery executors (`deliver-epic-single.md` vs
  `single-story-deliver.md`) doing nearly the same job, plus the fan-out
  wave engine as a third shape;
- two branch models (`epic/<id>` integration branch vs `story-<id>` → PR);
- two body schemas, two lease guards, two close/init/phase script families.

v2.0.0 removes the fork at the root: **one ticket type, one delivery engine,
one branch model.** This is a **hard cutover with no backward compatibility**
(per the project's contract-cutover policy) — v1 epics in flight must land
before upgrading.

### Decided design (operator decisions, 2026-07-13)

1. **One ticket type: Story — and Stories are large.** The spec lives **in
   the Story body** — the folded Tech Spec pattern the Epic body uses today,
   scaled to the Story's complexity (a trivial Story carries a paragraph; a
   complex one carries the full spec sections). What v1 called an Epic
   becomes one large Story: frontier models with 1M+ context windows execute
   epic-sized capabilities in a single guarded session — v1.94.0's
   single-delivery default already proved this shape; v2 renames the
   container. Every Story is **independently executable and independently
   shippable**, with optional `depends_on` edges for ordering.
2. **Default-single split policy.** `/plan` does **not** split into multiple
   Stories unless (a) the pieces have **near-zero overlap** — genuinely
   independent capabilities that happen to share a seed idea — or (b) there
   is an **architectural seam** (different deployables, a migration vs. the
   feature that consumes it). Decomposition of coupled work happens **inside
   the one Story** as the spec's Delivery Slicing table — checkpointed
   slices within one session (the M4 mechanism), not sibling tickets. The
   v1 sizing profile (`DEFAULT_TASK_SIZING` — `softFiles: 15`,
   `hardFiles: 30`, advisory acceptance mass) **goes away or is replaced
   outright**: per-Story file/AC ceilings are meaningless when a Story is
   session-capacity-sized. Whatever split advisory replaces it is keyed to
   **model capacity** (what one guarded session can deliver and self-verify
   at the current tier), not file counts — designed fresh in the v2 design
   pass, not carried over.
3. **No integration branch.** Every Story PRs directly to `main`
   (`story-<id>` → PR → required checks → squash). The `epic/<id>` branch,
   `--no-ff` wave merges, and the epic→main PR die. Dependent Stories deliver
   sequentially in dependency order, each landing before the next starts.
4. **No epic-level acceptance.** Acceptance criteria belong to the Stories
   that implement them, checked per-Story by the existing per-AC-cluster
   critic machinery. At **plan time**, a deterministic validator asserts
   every acceptance criterion maps to exactly one Story — and under the
   split policy this is a **split rejector**, not an orphan-handler: an AC
   that cannot be assigned to a single Story is evidence the split coupled
   what should have stayed one Story, and the persist refuses it.

### The v2 shape

**`/plan`** keeps its 3 steps (interrogate → author → persist) and loses its
router: no scope triage verdict, no `deliveryShape`, no path helpers to choose
between. The author step emits **one Story by default** — the shape decision
collapses into the split policy (design decision 2): N>1 only on near-zero
overlap or an architectural seam, with coupled work decomposed *inside* the
Story as Delivery Slicing rows. Persist creates the Story/Stories, writing
each authored `depends_on` edge as a `blocked by #<id>` body footer in the
rare N>1 case. There is no batch label — `/deliver` takes ids and resolves
the graph from live state (Story #4540).

**`/deliver`** becomes one engine: the M4 single-delivery guarded session,
invoked per Story. `/deliver <storyId...>` sequences the set in dependency
order; N=1 and N=5 use identical machinery.
Init → implement → gates → review → acceptance → PR → land, per Story, with
the M5 hook-based bookkeeping and M7 role-scoped worker unchanged.

### Ceremony model — keeping the guardrails without bloating every Story

The open design area flagged by the operator: epic delivery today carries
extra steps (audit lenses, reconcile, retro, degradation watch) that must not
be lost — but must not run on every one-file Story either. The v2 answer is
that **ceremony attaches to two scopes, both risk-routed**, using machinery
that already shipped in 1.94.0. Under the default-single split policy the
per-run scope is the rare case — the load-bearing scaffold is **inside the
large Story**: the per-AC-cluster critic scaling and the in-session slice
checkpoints (both M4 mechanisms) are what keep a 14-AC Story honest, and
they scale with the Story rather than bloating a trivial one:

| Scope | Ceremony | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Quality gates (lint/test/format/coverage/CRAP/maintainability), branch discipline, heartbeat/watchdog, land-or-block | Non-negotiable floor — exists today, unchanged |
| **Per-Story (risk-routed)** | Review depth; fresh-context vs inline acceptance critic (per AC-cluster, `[1,8]` floor preserved); audit lenses on risk-flagged surfaces | `planning-risk.js` envelope + `ceremony-routing.js` (M7-B) — the plan stamps each Story's risk verdict; routing picks rigor per Story |
| **Per-run (once, N>1)** | Cross-Story audit sweep over the combined diff; retro + friction roll-up; spec-coherence check across siblings | Fires **once at run completion**, keyed to the delivered id set — not repeated per Story |

Invariants that do not relax in v2 (carried from the model-evolution audit):

- **Rigor follows risk, never scope** — the judged risk envelope stays
  schema-validated; the harness owns gate decisions deterministically.
- **`security-baseline.md` is inviolable**; destructive-action HITL gates and
  `agent::blocked` stay the single runtime pause point.
- **Hard sizing ceilings stay hard**; `wide` (with a reason) remains the only
  beyond-ceiling path.
- **Worktree/branch isolation, PR-only promotion to `main` with required
  checks, deterministic validators, lifecycle ledger, structured comments as
  durable artifacts** — all keep.
- **Maker-blind review** — the fresh-context critic isolation survives; only
  its dispatch frequency is risk-routed.

### Deletion inventory (`.agents/scripts`, no-back-compat cut)

Grounded in the 1.94.0 tree. Three fates: **dies** (epic tier), **merges**
(duplicate story/single-story pairs), **re-keys** (epic-scoped → run-scoped).

**Dies — the epic delivery tier (~13k LOC in the four largest lib clusters
alone, plus ~2.2k lines of workflow prose):**

- Routing: `deliver-route.js`, the `delivery.routing.singleDelivery`
  kill-switch and config key (no routing decision remains).
- Workflow prose: `deliver-epic.md` (998 lines), `deliver-epic-single.md`
  (331), `epic-deliver-story.md` (436), `deliver-stories.md` (450) — replaced
  by one `deliver-story` helper evolved from `single-story-deliver.md`.
- Wave/dispatch engine: `dispatcher.js`, `dispatch-engine.js`,
  `dispatch-pipeline.js`, `manifest-builder.js`, `wave-tick.js`,
  `wave-marker.js`, `wave-record-{io,notifications,projection}.js`,
  `epic-execute-record-wave.js` (dependency ordering survives as a simple
  sequencer over `depends_on`; `stories-wave-tick.js` is its seed).
- Epic lifecycle: `epic-deliver-preflight.js`, `epic-deliver-prepare.js`,
  `epic-deliver-note-intervention.js`, `epic-cleanup.js`,
  `epic-run-state-store.js`, `epic-runner/`, `epic-deliver-lease-guard.js`,
  `epic-plan-lease-guard.js` (the story-level lease keeps).
- Epic acceptance/spec reconcile: `epic-reconcile.js`,
  `acceptance-spec-reconciler.js`, `epic-spec-reconciler-{apply,diff,
  discriminator,format,ops}.js` — replaced by the plan-time no-orphan-AC
  validator (new, small).
- Epic branch merge machinery in `finalize/` (arming the epic→main PR); the
  per-Story 5-stage merge state machine **keeps** — it becomes the only one.
- Planning fork: `plan-epic.md` + `plan-story.md` merge into one path helper;
  the scope-triage skill loses its `epic|story` verdict (retire or reduce to
  a sizing note); `deliveryShape` leaves `risk-verdict.json`; the epic ticket
  tree ops in `plan-persist` (`--force` close-and-recreate cascades)
  simplify to flat Story ops.
- Taxonomy/schema: `type::epic` label and the Epic body schema; the
  epic-keyed lifecycle events (`slice.*` naming reviewed — one event family).
- **Persona tier (pulled in from Someday, then deleted cleanly):** the idle
  hydration seam (`context-hydration-engine.js` — invoked by zero workflows)
  is deleted. Stage 5 first reduced persona files to one-line stubs; a later
  cleanup **removes** `.agents/personas/` and the `persona::*` label axis
  entirely. Role framing lives in instructions / rules / skills / optional
  `.agents/agents/` boot contexts. (`qa.personas` auth fixtures are unrelated
  and stay.)

**Merges — duplicate pairs collapse to one:**

- `story-init.js` ↔ `single-story-init.js`
- `story-close.js`/`story-close/` ↔ `single-story-close.js`/`single-story-close/`
- `story-phase.js` ↔ `slice-phase.js`
- `wave-tick.js` ↔ `stories-wave-tick.js` (→ the one sequencer)

**Re-keys — epic-scoped becomes run-scoped (mechanical):**

- ~~`docs-digest.js` (per-epic digest → per-run), `epic-plan-clarity.js`,
  `epic-plan-healthcheck.js`, `epic-audit-prepare.js`/`epic-audit-recheck.js`~~
  (deleted / consolidated in the v2 epic-scripts sweep)
  (→ the per-run audit sweep), `bookkeeping-outbox.js` (per-epic outbox →
  per-run), retro roll-up (`retro/`, `retro-runner.js` — per-run),
  `temp/epic-<id>/` namespace → `temp/run-<id>/`.

**Keeps (unchanged):** worktrees, all quality gates and baselines,
`code-review.js`, `acceptance-clusters.js`/`acceptance-eval.js`,
`ceremony-routing.js`, `review-depth.js`, `planning-risk.js`, role-scoped
agents (`delivery.routing.roleScopedAgents`), validators
(`ticket-validator*`, file-assumption, DAG), structured comments, the
per-Story merge state machine, `mandrel` CLI/sync/doctor, the audit lens
suite.

### What is lost — accepted trade-offs

Recorded so the decision is made with eyes open. **The default-single split
policy (design decision 2) is the primary mitigation for the top three**:
each is a *coupling* loss, and the policy forbids splitting coupled work —
coupled work stays one large Story, where atomicity, integration testing,
and acceptance coverage are intrinsic to the single session/PR. The residue
below applies only to the rare, policy-compliant N>1 runs.

1. **Atomic feature integration and a single revert point.** Largely
   dissolved by the split policy: a coupled feature is one Story → one PR
   → one revert. When a plan legitimately splits, the pieces are independent
   capabilities, so per-piece landing *is* the correct atomicity. Residue:
   feature flags where partial exposure matters across an architectural
   seam.
2. **Pre-main cross-Story integration testing.** Cross-Story interaction
   defects require interacting Stories; near-zero-overlap splits make them
   near-zero by construction. Residue: seam-splits (e.g. migration →
   consumer) — covered by dependency ordering (the consumer builds on the
   landed migration) plus the per-run audit sweep over the combined diff.
3. **Cross-Story acceptance reconciliation.** An AC spanning Stories is now
   *evidence of a policy-violating split*, and the plan-time validator
   **rejects** it rather than reconciling it at delivery time. Inside a
   large Story, acceptance coverage is the per-AC-cluster critic machinery
   (the `[1,8]` floor), which already scales with AC count. Residue:
   plan-time mis-assignment in legitimate N>1 runs, reviewed at gate #2.
4. **A single canonical spec document.** The Epic body was the one durable
   home of the Tech Spec. In v2 the spec is sharded across Story bodies:
   sibling drift is possible while a run is in flight, and post-hoc there is
   no single reference (closed tickets scatter). *Mitigation:* single-Story
   runs (the common case) are unaffected; for N>1 the plan authors
   self-contained bodies and the run-scoped coherence check compares
   siblings.
5. **Feature-level grouping and legibility.** The GitHub sub-issue tree, one
   status view per feature, per-epic retro roll-up. *Mitigation:* the
   `depends_on` edges resolved from live state (Story #4540 retired the
   plan-run label and `--run`); weaker than a native hierarchy.
6. **Epic-scoped amend/re-plan semantics.** `--force` / `--amend` operate on
   a parent-anchored ticket tree today; in v2, amending a multi-Story plan is
   edits across flat Stories with only the run label anchoring them.
7. **Run-scoped crash resume.** `epic-run-state-store.js` dies; resume for a
   multi-Story run must be rebuilt keyed to the run id (per-Story resume
   already exists and covers the common case).
8. **Wave parallelism in its current form.** Concurrent story worktrees
   merging into one epic branch was race-free by construction. In v2,
   parallel independent Stories each racing to `main` contend on rebases;
   the practical default becomes sequential delivery. *Accepted:* measured
   cohorts showed dispatch was strictly serial in practice anyway (4-deep
   dependency chains) — the parallelism being given up was mostly
   theoretical.
9. **Benchmark longitudinal comparability.** Historical cohorts measured the
   epic arms; v2 changes the mandrel arm's shape. *Accepted:* G3 has not
   run — deciding v2 **before** G3 is precisely why the cohort was held, so
   G3 measures the shape that will actually ship.

### Sequencing and riders

- **v2.0.0 before G3.** The G3 brownfield cohort measures the target-state
  framework; running it on the 1.94.0 shape and then cutting v2 would spend
  the cohort on a lame duck. Order: design pass → build (staged PRs, kill
  nothing until its replacement passes the same tests) → release 2.0.0 →
  bench arm update → G3.
- **Riders that land with or before v2.0.0:**
  - OIDC Trusted Publishing for npm ([#3559](https://github.com/dsj1984/mandrel/issues/3559)) —
    actionable now, unrelated to the collapse.
  - The chat-relay carried tail (old M2) is **absorbed**: its remaining live
    text sits in `deliver-epic.md` / `deliver-stories.md` /
    `epic-deliver-story.md`, all deleted above.
  - Doc-freshness fix already found pending: `configuration.md` still
    describes `delivery.routing.singleDelivery` as "shipped inert" (stale
    since M4-B; the key itself dies in v2).
- **Design decisions resolved (2026-07-13), formerly open:**
  1. **Run-scoped ceremony trigger** → a **`/deliver --run <planRunId>`
     epilogue step**, no new watchdog/hook. The deliver invocation that
     sequences a multi-Story run owns the closeout after its last Story's PR
     merges. A single-Story run (the common case) has no run scope — the
     Story's own close is the end. No run-state machinery is built for the
     rare case.
  2. **Story body budget** → reuse the §2 FinOps `maxTokenBudget` +
     section-elision. The folded spec has a soft body target; when the
     authored spec exceeds it, persist **fails closed** (split the Story or
     tighten `## Spec`). Specs stay inline on the Story — never spill to
     `docs/` (temporary or committed). An over-budget Spec is a sizing smell.
  3. **`retro` role def** → **drop it.** The per-run retro is rare and runs
     as a CLI subprocess (`retro-run.js`), not an `Agent` spawn, so there is
     no spawn to attach a role context to. Delete the unwired 1.7KB
     `retro.md`; re-add only if retro ever becomes an agent spawn.

- **Ceremony lock-in (2026-07-14) — no placeholder scaffolding on `v2`:**
  1. **Follow-ups (replaces Epic retro)** → every Story land runs
     `captureStoryFollowUps` (friction → filed/`follow-ups` comment). N>1
     adds `plan-run-epilogue.js` `follow-up-rollup` over the set. Intent is
     actionable issues, not six-section essay retros. `retro-run.js` +
     `agents/retro.md` deleted.
  2. **Spec spill** → **revoked (2026-07-14).** Inline-only: over-budget
     Specs reject at persist. No writes under `docs/specs/`. Shared
     `techspec.md` fold is N===1 only; N>1 requires per-Story `## Spec`.
     Top-level `acceptance[]`/`verify[]` sync into the body (no dual-author
     requirement).
  3. **Run epilogue** → real executor CLI `plan-run-epilogue.js`
     (`audit-roster` · `follow-up-rollup` · `sibling-coherence`). Inert
     planner-only path removed.
  4. **Risk-routed critics/lenses** → critical review + acceptance `block`
     stay blocking; local/audit lenses stay advisory.
  5. **Epic surface** → hard-delete unwired epic-plan skills, orphan CLIs
     (`standalone-feedback-rollup`, `bookkeeping-reconcile`), and
     `helpers/epic-testing.md`. Keep libraries still used by `/plan`.
  6. **`single-story-*` rename** → deferred (cosmetic).
  7. **`slice.*` lifecycle** → deleted (inert). `## Slicing` remains
     in-session prose checkpoints only.

### Build progress (living checklist)

> Work happens on the long-lived **`v2`** branch — never through `/plan` or
> `/deliver` (they are being rewritten). Commit and test after each item;
> **kill nothing until its replacement passes the same tests.** Each stage
> must end green (`npm test`, `lint`, `docs:check`, `check:context-budget`,
> `check-dead-exports`). Deletion inventory grounded against `mandrel-v1.94.0`.

#### Stage 0 — Setup & decisions

- [x] `v2` branch created off `main` (1.94.0)
- [x] Three open design questions resolved (run epilogue · Spec budget · drop `retro` role);
  Spec decision later revised to inline-only fail-closed (no `docs/specs/` spill)
- [x] Staged checklist committed to `roadmap.md`

#### Stage 1 — New v2 machinery (additive; TDD; breaks nothing)

*Data contract first — the validators and planner below all consume it.*

- [x] **v2 Story body contract** — the Story body now carries an optional
  `## Slicing` section (the intra-Story delivery slice plan that replaces
  sibling fan-out) alongside `goal`/`changes`/`acceptance`/`verify`, via the
  canonical `story-body.js` parser/serializer (round-trip safe; pre-v2 bodies
  serialize byte-identically). `task-body-validator.js` tolerates it (optional).
  Over-budget Specs fail closed at persist (inline-only). Tests:
  `story-body.test.js` (+6), `task-body-validator.test.js` (+2).
- [x] Split-policy validator — plan-time **one-owner-AC split rejector**
  (`split-policy-validator.js` + 12 unit tests): rejects any identical AC
  shared across Stories (coupling signal), with optional manifest-coverage
  checking; single-Story plans always pass. `assertAcceptancePartition`
  throwing-wrapper ready for the Stage-3 persist wiring. Additive.
- [x] Spec budget gate — `spec-spill.js` (budget helper; +tests): an
  over-budget folded spec (`estimateTokens` > soft budget) **rejects** at
  persist instead of writing `docs/specs/`. Small specs stay inline. Reuses
  the §2 `estimateTokens` estimator.
- [x] Run-epilogue scaffold — `run-epilogue.js` (+6 tests): a pure, inert
  planner enumerating the per-run closeout steps (audit-sweep · retro-rollup ·
  sibling-coherence) for a multi-Story run; a single-Story run is
  `applicable: false` (no run scope). Stage 4 wires the descriptors into
  `/deliver --run`.

#### Stage 2 — Sizing removal

- [x] Delete/replace `DEFAULT_TASK_SIZING` → `DEFAULT_MODEL_CAPACITY`: per-Story
  file/AC ceilings retired; the validator scores estimated **session mass**
  (authored tokens + `tokensPerAcceptance` / `tokensPerChange` proxies) against
  fractions of `maxTokenBudget`. `wide` still lifts the hard session-mass
  rejection. Review depth decoupled onto `DEFAULT_DIFF_WIDTH` (mechanical diff
  width). Config key `planning.taskSizing` → `planning.modelCapacity`. Prompt /
  skills / schema / docs updated; tests rewritten.

#### Stage 3 — Planning collapse

- [x] `/plan` → single path: deleted `plan-epic.md` / `plan-story.md` /
  `scope-triage-gate.md` / `plan-epic-reference.md`; `plan.md` is the sole
  3-step procedure. Scope-triage skill reduced to a split advisory (no
  `epic|story` routing). `deliveryShape` removed from
  `risk-verdict.schema.json` and plan-context envelopes.
- [x] Author step emits **1 Story by default** (decomposer prompt +
  `systemPrompts.story`); N>1 only under the split policy.
  `assertAcceptancePartition` wired in `plan-persist` via `assemblePlanStories`.
- [x] `plan-persist` → flat Story ops (`story-ops.js` + rewritten
  `run-plan-persist.js`): createIssue Stories with folded `## Spec`
  (inline-only; over-budget rejects), `plan-run::` label when N>1, checkpoint
  on primary Story. Dropped `.agents/schemas/epic-spec.schema.json` (fixture
  retained for Stage-5 reconciler tests).

#### Stage 4 — Delivery collapse

- [x] One engine: evolve `single-story-deliver.md` → `deliver-story`; delete the
  `deliver-epic*` tier prose (`deliver-epic.md` / `deliver-epic-single.md` /
  `epic-deliver-story.md` / `deliver-stories.md` / `epic-audit.md`).
  `/deliver` is a Story-only router that always delegates to
  `helpers/deliver-story.md`.
- [x] Branch model: `story-<id>` → PR → `main`; epic integration branch +
  `--no-ff` wave merges removed from active workflow/instructions prose.
  `single-story-init.js` / `single-story-close.js` remain the live branch/PR
  path (script-pair merge is Stage 5).
- [x] Ceremony wiring: per-Story risk-routed (`ceremony-routing.js` in
  `deliver-story` Step 2 + `acceptance-self-eval`); per-run epilogue via
  `planRunEpilogue` keyed on the delivered id set; N>1 sequencer =
  `resolve-stories.js` + `stories-wave-tick.js` (Story #4540 replaced
  `resolve-plan-run.js`).

#### Stage 5 — Deletion sweep

- [x] Wave/dispatch engine deleted (`dispatcher.js`, `dispatch-*`, `wave-*`,
  `manifest-builder.js`).
- [x] Epic lifecycle/reconcile/lease stratum deleted or stranded behind the
  Story-only run path (`epic-runner/`, `epic-spec-reconciler-*`).
- [x] Duplicate `story` ↔ `single-story` script pairs collapsed onto the live
  Story-only CLIs.
- [x] Epic-scoped temp naming re-keyed toward run scope: `runTempDir` owns
  `temp/run-*`, with `epicTempDir` retained as a thin alias for this pass and
  comments updated on `docs-digest` / bookkeeping surfaces.
- [x] `type::epic` removed from the active taxonomy and issue-form generator;
  context hydrator stratum is gone. (Follow-up: `.agents/personas/` and
  `persona::*` labels deleted entirely — stubs were a dead ceremony.)

#### Stage 6 — Docs, config, gates, release

- [x] `.agents` docs freshness for v2 (workflows, `instructions.md` §5.D hierarchy, the stale `configuration.md` cell)
- [x] Config: drop `delivery.routing.singleDelivery`; land the sizing-config change
- [x] Full gate green + version bump prep for **2.0.0** (version files at
  `2.0.0`; `v2` branch holds the cutover — do **not** merge `v2` → `main`
  from this stage; release-please publish remains an operator step later)

## 2. Someday — aspirational & model-shift monitors

Strictly items that are **aspirational** or that **re-price on a ~10x shift**
in model capability, agent platforms, or inference economics. Operational
dependency trip-wires live in the appendix, not here.

1. **Worktree demotion to an implementation option** — re-price when agent
   platforms ship reliable per-task sandboxes
   ([#4385](https://github.com/dsj1984/mandrel/issues/4385) tracked the
   related capability lift). Until then worktree isolation is concurrency
   physics and keeps.
2. **Remaining sequential-only audit lenses** (`audit-dependencies`,
   `audit-devops`, `audit-sre`, `audit-privacy`, `audit-seo`, `audit-ux-ui`,
   `audit-lighthouse`) — re-price on inference economics. Several are
   externally bound or not dimensionally decomposable; sequential may be the
   correct default forever. Any generalization must clear the measured
   **~5× token-multiple / no-precision-loss gate** lens-by-lens (anchor:
   `audit-clean-code`, 2026-06-04 — 23 agents, ~2.47M tokens, 49/51 findings
   kept). Do not batch-convert.
3. **Multi-Story plan-authoring quality spike** — aspirational, and doubly
   rare under the default-single split policy: when `/plan` legitimately
   authors N>1 Stories, a parallel-draft + adversarial-consolidation pass
   could improve seam quality. Hold to the same measured-delta discipline as
   the audit gate.
4. **Dynamic spec / Gherkin mutation engine** — aspirational; static
   placeholder lint (`check-gherkin-placeholders.js`) is the supported
   surface. **Trip-wire (both):** consumer demand on the BDD tier *and* a
   dogfood fixture.
5. **Productize-or-stay-internal** 🚪 — aspirational/external; the one
   product decision gating the entire readiness backlog (runtime/ticketing
   portability, release maturity, deterministic QA runner,
   enterprise/compliance, platform matrix, external positioning). Nothing in
   it blocks internal use; build none of it until the call is made. Full
   analysis preserved at `docs/roadmap.md` @ `mandrel-v1.94.0` (Part 2).
6. **Beyond v2: the harness as validators-only** — the standing 10x
   question. Each model tier absorbs more of the procedural scaffold; the
   durable kernel is what the model cannot self-provide (external state,
   deterministic validation, isolation, gates, HITL risk appetite). At each
   major model shift, re-run the audit: what remaining prose is now a
   retirement candidate?

## Appendix — standing watches & historical anchors

**Operational dependency trip-wires** (not roadmap work — policy notes kept
here so Someday stays aspirational):

- **`typhonjs-escomplex`** 🔭 — the complexity kernel behind the
  CRAP/maintainability gates is pinned at its terminal `0.1.0` (last release
  2018). Deliberately not swapped: stable, pure JS, no reachable CVE; every
  baseline stamps its resolved version, so any swap is its own project with
  a full baseline recut. **Trip-wire:** a CVE against it, or install/parse
  failure under a future Node major. Renovate is pinned off
  (`renovate.json`).
- **`typescript` peer floor `>=5.0.0`** 🔒 — a permissive floor, not a pin;
  raising it is a consumer-visible break. **Watch:** only relevant if the
  maintainability transpiler config ever adopts a TS-6-removed flag.

**Historical anchors.** Two in-code doc comments cite Part titles from the
pre-2.0 roadmap; their content is compressed above and preserved in git
history (`docs/roadmap.md` @ `mandrel-v1.94.0`):

- **Part 1 — Model-Evolution Audit** (cited by `planning-risk.js`): the
  model-judged risk envelope replaced the keyword classifier; risk routes
  rigor, never scope. Its Keep-invariants are folded into the v2 ceremony
  model above; its standing question survives as Someday item 6.
- **Part 3 — Dynamic-Workflow Orchestration** (cited by `capability.js`):
  the per-lens cost/precision gate and the orchestrated-lens roster; the
  live remainder is Someday item 2.
