# Architecture

This document describes the internal architecture of Agent Protocols — a
framework of instructions, personas, skills, and SDLC workflows that govern AI
coding assistants. It is the authoritative reference for how the system is
structured, how components interact, and where to find each subsystem.

> **For the end-to-end workflow narrative** — how the commands compose, label
> transitions, HITL touchpoints — see [`.agents/SDLC.md`](../.agents/SDLC.md).
> This file covers the *architecture* (modules, interfaces, data flow) that
> the workflow runs on top of. The slash-command reference index lives in
> [`workflows.md`](workflows.md).

---

## High-Level Overview

Agent Protocols follows an **Epic-Centric GitHub Orchestration** model where
GitHub Issues, Labels, and Projects V2 serve as the Single Source of Truth
(SSOT). The framework decomposes product initiatives (Epics) into executable
agent tasks, dispatches them across parallel waves, and integrates the results —
all without local state files.

```mermaid
graph TB
    classDef human fill:#f9d0c4,stroke:#333,stroke-width:2px,color:#000
    classDef agent fill:#c4f9d0,stroke:#333,stroke-width:2px,color:#000
    classDef infra fill:#c4d9f9,stroke:#333,stroke-width:2px,color:#000
    classDef data fill:#ececec,stroke:#333,stroke-width:1px,stroke-dasharray: 5 5,color:#000

    H["👤 Human Operator"]:::human
    IDE["Agentic IDE"]:::agent

    subgraph Framework [".agents/ — Distributed Bundle"]
        direction TB
        INS["instructions.md"]:::infra
        PER["Personas"]:::infra
        RUL["Rules"]:::infra
        SKL["Skills (core/ + stack/)"]:::infra
        WFL["Workflows (slash commands)"]:::infra
        SCR["Scripts Engine"]:::agent
        SCH["Schemas"]:::data
        TPL["Templates"]:::data
    end

    subgraph GitHub ["GitHub Platform"]
        direction TB
        ISS["Issues & Labels"]:::data
        SUB["Sub-Issues API"]:::data
        PRJ["Projects V2"]:::data
    end

    H -->|"Creates Epic"| ISS
    H -->|"/epic-plan"| IDE
    IDE --> INS
    INS --> PER & RUL & SKL
    IDE --> SCR
    SCR -->|"API calls"| ISS
    SCR -->|"Links hierarchy"| SUB
    SCR -.->|"Validates"| SCH
```

---

## Repository Layout

The repository has a clear separation between the **distributed product**
(`.agents/`) and **development tooling** (root-level files).

```text
agent-protocols/
├── .agents/                  ← Distributed bundle (the "product")
│   ├── instructions.md       ← Primary system prompt (all agent rules)
│   ├── VERSION               ← Semantic version
│   ├── SDLC.md               ← End-to-end workflow guide
│   ├── README.md             ← Consumer documentation
│   ├── default-agentrc.json  ← Default config template
│   │
│   ├── personas/             ← Role-specific behavior files
│   ├── rules/                ← Domain-agnostic coding standards
│   ├── skills/               ← Two-tier skill library
│   │   ├── core/             ←   Universal process skills
│   │   └── stack/            ←   Tech-stack guardrails
│   ├── workflows/            ← Slash-command workflows
│   ├── scripts/              ← Deterministic JavaScript tooling
│   │   ├── lib/              ←   Shared modules & interfaces
│   │   ├── providers/        ←   Ticketing provider implementations
│   │   └── adapters/         ←   Execution adapter implementations
│   ├── schemas/              ← JSON Schema for structured output
│   └── templates/            ← Prompt and planning templates
│
├── .agentrc.json             ← Runtime configuration (dogfooding)
├── .github/workflows/        ← CI/CD pipeline (ci.yml)
├── docs/                     ← Project documentation
├── tests/                    ← Framework test suite
│   └── lib/                  ←   Library-specific unit tests
├── temp/                     ← Ephemeral runtime artifacts (git-ignored)
├── biome.json                ← Biome linter/formatter config
├── package.json              ← npm tooling + dev dependencies
└── AGENTS.md                 ← Repository-level onboarding
```

---

## Core Subsystems

### 1. Instruction Layer

The instruction layer defines **what agents are** and **how they must behave**.

| Component     | Path                           | Purpose                                                                                                                                         |
| ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| System Prompt | `.agents/instructions.md`      | Master behavioral contract — guardrails, FinOps, shell protocol, philosophy, quality discipline, Git conventions.                                |
| Personas      | `.agents/personas/*.md`        | Role-specific constraint files (architect, engineer, qa-engineer, etc.) that override default behavior when activated.                          |
| Rules         | `.agents/rules/*.md`           | Domain-agnostic coding standards (API conventions, git conventions, security baseline, testing, etc.).                                          |
| Skills        | `.agents/skills/{core,stack}/` | Two-tier library of callable capabilities.                                                                                                       |

#### Persona Routing

```mermaid
graph LR
    classDef active fill:#c4f9d0,stroke:#333,color:#000

    T["Task Ticket"] --> L{"persona label?"}
    L -->|"architect"| A["architect.md"]:::active
    L -->|"engineer"| E["engineer.md"]:::active
    L -->|"qa-engineer"| Q["qa-engineer.md"]:::active
    L -->|"missing"| D["engineer.md (default)"]:::active
```

#### Skill Architecture

Skills use a **two-tier layout**:

- **`core/`** — Universal, process-driven skills (debugging, TDD, security,
  code review, context engineering, etc.)
- **`stack/`** — Technology-specific skills organized by category:
  - `architecture/` — Monorepo strategies, system design
  - `backend/` — Server frameworks, API patterns
  - `frontend/` — UI frameworks, CSS systems
  - `qa/` — Testing frameworks (Playwright, Vitest)
  - `security/` — Hardening patterns

Each skill contains a `SKILL.md` file with constraints and an optional
`examples/` directory.

---

### 2. Orchestration Engine

The orchestration engine is the **runtime brain** — a set of JavaScript ESM
scripts that automate the entire SDLC from planning through integration. The
operator-facing surface is split by hierarchy level into four narrow skills:
`/epic-plan`, `/epic-execute`, `/wave-execute`, `/story-execute`, with
`/epic-close` bookending the lifecycle. Story sub-agents launch through the
Agent tool inside the operator's Claude session — there is no subprocess
spawn pathway and no GitHub Actions runner.

#### Component Diagram

```mermaid
graph TB
    classDef script fill:#e8d5f5,stroke:#333,color:#000
    classDef lib fill:#d5e8f5,stroke:#333,color:#000
    classDef iface fill:#f5e8d5,stroke:#333,color:#000

    subgraph Scripts ["Orchestration Scripts"]
        EP["epic-plan.js"]:::script
        TD["ticket-decomposer.js"]:::script
        DI["dispatcher.js"]:::script
        ER["epic-runner.js"]:::script
        SI["story-init.js"]:::script
        SC["story-close.js"]:::script
        EC["epic-close.js"]:::script
        CH["context-hydrator.js"]:::script
        NO["notify.js"]:::script
        UTS["update-ticket-state.js"]:::script
    end

    subgraph Lib ["Shared Library (lib/)"]
        CR["config-resolver.js"]:::lib
        PF["provider-factory.js"]:::lib
        AF["adapter-factory.js"]:::lib
        GH["Graph.js (DAG)"]:::lib
        DP["dependency-parser.js"]:::lib
        GMO["git-merge-orchestrator.js"]:::lib
        GU["git-utils.js"]:::lib
        LG["Logger.js"]:::lib
    end

    subgraph Interfaces ["Abstract Interfaces"]
        ITP["ITicketingProvider"]:::iface
        IEA["IExecutionAdapter"]:::iface
    end

    subgraph Implementations ["Concrete Implementations"]
        GHP["providers/github.js"]:::script
        MA["adapters/manual.js"]:::script
    end

    DI --> CR & PF & AF & GH & DP & CH
    EP --> CR & PF
    TD --> CR & PF & DP

    PF --> ITP
    AF --> IEA
    ITP -.->|"implements"| GHP
    IEA -.->|"implements"| MA
```

#### Key Scripts

| Script                   | Responsibility                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `epic-plan.js`           | Generates PRD + Tech Spec; decomposes Epic body into Feature → Story → Task tickets. |
| `ticket-decomposer.js`   | Recursively decomposes specs into the 4-tier hierarchy.                              |
| `dispatcher.js`          | Builds dependency DAG, computes execution waves, dispatches tasks.                   |
| `epic-runner.js`         | Drives the wave loop end-to-end (invoked by `/epic-execute`).                        |
| `story-init.js`          | Initialises a Story worktree, transitions Tasks to `agent::executing`.               |
| `story-close.js`         | Validates, merges, reaps, and cascades on Story completion. Trimmed to a 189-line CLI shell over `lib/orchestration/story-close/{merge-runner,cleanup-reconciler,comment-bodies}` in Epic #946 (v5.31.1). |
| `epic-close.js`          | Closes the Epic: docs freshness, code review, version bump, merge to `main`, retro. |
| `context-hydrator.js`    | Assembles self-contained prompts (protocol + persona + skills + hierarchy + task).   |
| `update-ticket-state.js` | Syncs ticket status via GitHub labels (`agent::ready` → `agent::done`).              |
| `notify.js`              | Dispatches notifications via @mention and webhook channels.                          |
| `health-monitor.js`      | Updates real-time Epic health and tool success rates in GitHub.                      |

#### Dispatch Engine Submodules

`lib/orchestration/dispatch-engine.js` is a coordinator that composes six
cohesive submodules. Consumers (`dispatcher.js`, tests) import `dispatch`,
`resolveAndDispatch`, `collectOpenStoryIds`, `detectEpicCompletion`, and the
`AGENT_*` / `RISK_HIGH_LABEL` / `TYPE_TASK_LABEL` constants from the
coordinator path.

| Submodule                     | Responsibility                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `dispatch-pipeline.js`        | Resolve context, fetch Epic, reconcile state, build DAG, scaffold branch, run worktree GC. |
| `wave-dispatcher.js`          | `dispatchWave`, `dispatchNextWave`, per-task dispatch, `collectOpenStoryIds`.              |
| `risk-gate-handler.js`        | Risk labels are metadata only; no runtime gate.                                            |
| `health-check-service.js`     | Epic Health issue ensure.                                                                  |
| `epic-lifecycle-detector.js`  | Epic-completion detection + bookend lifecycle fire.                                        |
| `dispatch-logger.js`          | Shared lazy logger proxy used by every submodule.                                          |

#### Presentation Layer Submodules

`lib/presentation/manifest-renderer.js` is a façade composing:

| Submodule                 | Responsibility                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `manifest-formatter.js`   | Pure Markdown / CLI rendering (`formatManifestMarkdown`, `printStoryDispatchTable`). No fs access. |
| `manifest-persistence.js` | File I/O — writes dispatch and story manifests to `temp/`.                                         |

The data-shape owner (`lib/orchestration/manifest-builder.js`) is unchanged.
Only the façade file is part of the stable public surface — downstream
consumers continue to import `renderManifestMarkdown`,
`renderStoryManifestMarkdown`, `persistManifest`, `printStoryDispatchTable`,
`postManifestEpicComment`, and `postParkedFollowOnsComment` from
`lib/presentation/manifest-renderer.js`.

#### Orchestration Context + ErrorJournal

The epic-runner and plan-runner thread an explicit typed context through every
submodule:

| Context                | Path                            | Consumers                                                       |
| ---------------------- | ------------------------------- | --------------------------------------------------------------- |
| `OrchestrationContext` | `lib/orchestration/context.js`  | Shared base — provider, settings, logger, `errorJournal`.       |
| `EpicRunnerContext`    | `lib/orchestration/context.js`  | Every `epic-runner/*` submodule accepts `ctx` as first arg.     |
| `PlanRunnerContext`    | `lib/orchestration/context.js`  | `epic-plan-spec.js` / `epic-plan-decompose.js` drivers.         |

The `errorJournal` field on each context is an `ErrorJournal` instance
(`lib/orchestration/error-journal.js`) that writes structured JSONL to
`temp/epic-<id>-errors.log`. Sites that previously did silent
`catch (err) { logger.warn(...) }` in `epic-runner.js`, `blocker-handler.js`,
and `bookend-chainer.js` also call `errorJournal?.record({ phase, error,
context })` so the error surface is auditable after a run completes. See
[`docs/patterns.md`](patterns.md) for the pattern and the
`errorJournal?.record(...)` idiom.

`lib/orchestration/epic-runner/progress-reporter.js` emits a periodic
`epic-run-progress` structured comment on the Epic, driven by
`orchestration.epicRunner.progressReportIntervalSec`.

#### Resilience layers

| Module                                              | Role                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/orchestration/epic-runner/commit-assertion.js` | Post-wave guard — a "done" wave whose stories produced zero commits on `origin/story-<id>` is reclassified as `halted` instead of silently passing.   |
| `lib/orchestration/friction-emitter.js`             | Rate-limited (`storyId` + marker hash, 60s cooldown) `friction` emitter wrapping `provider.postComment`.                                              |
| `lib/orchestration/epic-runner/column-sync.js`      | Drives the Projects v2 Status column from `agent::` labels (best-effort). Missing project rows surface as friction, not as `unknown`.                 |

`CommitAssertion`'s default git adapter falls back to a `resolves #<storyId>`
grep on `origin/epic/<id>` when `origin/story-<id>` has already been deleted
by `story-close` — closing the window where a successfully-merged Story was
misreported as a zero-delta failure.

#### Throughput primitives

| Module                                                     | Role                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/util/concurrent-map.js`                               | `concurrentMap(items, fn, { concurrency })` bounded-concurrency fanout. Adopted in `wave-gate`, wave-end `commit-assertion`, and `ProgressReporter`. |
| `providers/github/cache-manager.js`                        | `getTicket(id, { maxAgeMs })` treats entries older than the caller's max age as cache misses; `primeTicketCache` after every `getTickets(epicId)`.   |
| `lib/orchestration/epic-runner/state-poller.js`            | Bulk `GET /issues?labels=agent::*&state=open` path replaces per-ticket probes when the tracked-story set is large; per-ticket fallback on errors.    |
| `lib/util/phase-timer.js` + `phase-timer-state.js`         | Records `{ phase, elapsedMs }` spans across the `story-init` → sub-agent → `story-close` boundaries. Posts `phase-timings` comments on Story close.  |
| `ProgressReporter.setPlan({ waves })`                      | With a plan set, each fire renders every wave + story (queued / in-flight / done / blocked) with a `Wave` column. Reads `phase-timings` to render p50/p95. |

#### Tunable concurrency caps

The three `concurrentMap` adoption sites are configurable via
`orchestration.concurrency`, resolved from `.agentrc.json` and threaded
through `ctx.concurrency` by `lib/orchestration/concurrency.js`:

| Key                | Default        | Semantics                                                                                                                       |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `waveGate`         | `0` (uncapped) | `wave-gate` retains the `Promise.all` fanout when omitted; a positive integer routes through `concurrentMap` with that cap.     |
| `commitAssertion`  | `4`            | Wave-end `CommitAssertion.check` concurrent git-read cap.                                                                       |
| `progressReporter` | `8`            | Progress-reporter concurrent `provider.getTicket` cap.                                                                          |

`resolveConcurrency(source)` reads either `orchestration.concurrency` or a
pre-narrowed concurrency sub-block, coerces per-field, and falls back to
`DEFAULT_CONCURRENCY` for missing or malformed values. Consumers tuning caps
use `.agents/scripts/aggregate-phase-timings.js` to read `phase-timings`
structured comments across Stories, aggregate p50/p95 per phase, and print
recommended caps.

#### Direct CLIs (no MCP server)

The framework ships no MCP server. Every orchestration capability is a
direct Node CLI under `.agents/scripts/`, with `lib/orchestration/ticketing.js`
as the authoritative SDK for runtime callers. Operators see the simplification
at first-run time (no MCP-server bootstrap step) and at secrets-resolution
time (`GITHUB_TOKEN` and `NOTIFICATION_WEBHOOK_URL` read only from
`process.env`).

---

### 3. Provider Abstraction Layer

All ticketing interactions are mediated through the **`ITicketingProvider`**
abstract interface, enabling future portability beyond GitHub.

```mermaid
classDiagram
    class ITicketingProvider {
        <<abstract>>
        +getEpics(filters) Promise
        +getEpic(epicId) Promise
        +getTickets(epicId, filters) Promise
        +getSubTickets(parentId) Promise
        +getTicket(ticketId) Promise
        +getTicketDependencies(ticketId) Promise
        +createTicket(parentId, ticketData) Promise
        +addSubIssue(parentId, childId) Promise
        +updateTicket(ticketId, mutations) Promise
        +postComment(ticketId, payload) Promise
        +createPullRequest(branchName, ticketId) Promise
        +ensureLabels(labelDefs) Promise
        +ensureProjectFields(fieldDefs) Promise
    }

    class GitHubProvider {
        -owner: string
        -repo: string
        -token: string
        +getEpics(filters) Promise
        +getEpic(epicId) Promise
        ...all interface methods
    }

    ITicketingProvider <|-- GitHubProvider
```

**Resolution**: `provider-factory.js` reads `orchestration.provider` from
`.agentrc.json` and instantiates the matching concrete class.

**Internal layout**: `providers/github.js` is a thin façade over focused
modules under `providers/github/`: `ticket-mapper.js` (REST/GraphQL payload →
ticket shape), `graphql-builder.js` (named query + mutation strings),
`cache-manager.js` (per-instance ticket cache backed by `lib/CacheLayer`), and
`error-classifier.js` (GraphQL error → category). The façade re-exports every
symbol consumers previously imported.

---

### 4. Execution Adapter Layer

The **`IExecutionAdapter`** interface separates _what to run_ (Dispatcher) from
_how to run it_ (Adapter), enabling pluggable agentic runtimes.

```mermaid
classDiagram
    class IExecutionAdapter {
        <<abstract>>
        +executorId: string
        +dispatchTask(taskDispatch) Promise
        +getTaskStatus(dispatchId) Promise
        +cancelTask(dispatchId) Promise
        +describe() string
    }

    class ManualDispatchAdapter {
        +executorId = "manual"
        +dispatchTask() prints instructions
    }

    IExecutionAdapter <|-- ManualDispatchAdapter
```

**Resolution**: `adapter-factory.js` reads `orchestration.executor` from
`.agentrc.json` (default: `"manual"`).

---

### 5. Configuration System

Configuration follows a **layered resolution** pattern with operational
settings organised into a **grouped contract**:

```mermaid
graph LR
    classDef cfg fill:#fff3cd,stroke:#333,color:#000

    A[".agentrc.json"]:::cfg -->|"Priority 1"| R["config-resolver.js"]
    L[".agentrc.local.json"]:::cfg -->|"Priority 1.5 (gitignored)"| R
    B["Built-in Defaults"]:::cfg -->|"Priority 2"| R
    C[".env file"]:::cfg -->|"Env overlay"| R
    R --> P["agentSettings.paths"]
    R --> CMD["agentSettings.commands"]
    R --> Q["agentSettings.quality"]
    R --> LM["agentSettings.limits"]
    R --> O["orchestration block"]
```

The runtime AJV schemas in `lib/config-schema.js` and
`lib/config-settings-schema.js` are the source of truth; the static mirror at
`.agents/schemas/agentrc.schema.json` exists for editor tooling and human
readers, kept in sync by a drift test.

#### Key Configuration Sections

| Section                  | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `agentSettings.paths`    | Required filesystem roots (`agentRoot`, `docsRoot`, `tempRoot`).        |
| `agentSettings.commands` | Validate / lint / test / typecheck / build commands; `null` disables.  |
| `agentSettings.quality`  | Maintainability + CRAP + lint baselines and `prGate.checks`.            |
| `agentSettings.limits`   | Resource ceilings + `friction.*` anti-thrashing thresholds.             |
| `orchestration`          | Provider, GitHub block, worktree isolation, runners, retry tuning.      |

Each grouped block is read through a typed accessor (`getPaths(config)`,
`getCommands(config)`, `getQuality(config)`, `getLimits(config)`) — there are
no flat-key reads anywhere in the resolver or its consumers.

> See [`docs/configuration.md`](configuration.md) for the canonical
> reader-facing reference: every key, default, and required-vs-optional flag,
> the root-dogfood-vs-distributed-template diff table, and baseline
> conventions (canonical `/baselines/` vs per-wave drift snapshots under
> `.agents/state/`). Project-specific technology context lives under the
> **Tech Stack** section below — intentionally not in `.agentrc.json`.

**Security**: The config resolver blocks shell metacharacter injection
(`; & | \`` `` $()`) in all string values that flow into subprocesses, and the
schema enforces non-empty strings on every command field.

---

### 6. Dependency Graph Engine

The `Graph.js` module provides the mathematical foundation for task scheduling:

| Function                  | Algorithm                                  | Complexity |
| ------------------------- | ------------------------------------------ | ---------- |
| `buildGraph()`            | Adjacency list construction                | O(N)       |
| `detectCycle()`           | DFS 3-color cycle detection                | O(V+E)     |
| `assignLayers()`          | Memoized layer assignment                  | O(V+E)     |
| `computeWaves()`          | Layer-grouped wave partitioning            | O(V+E)     |
| `topologicalSort()`       | Kahn's algorithm (deterministic tie-break) | O(V+E)     |
| `transitiveReduction()`   | DFS-based edge pruning                     | O(V·(V+E)) |
| `autoSerializeOverlaps()` | Focus-area conflict serialization          | O(N²+V·E)  |
| `computeReachability()`   | Memoized DFS transitive closure            | O(V·(V+E)) |

The auto-serialization pass prevents file-level merge conflicts by injecting
synthetic dependency edges between tasks with overlapping `focusAreas`.

---

## Data Flow: Epic Lifecycle

```mermaid
sequenceDiagram
    participant H as Human
    participant P as /epic-plan
    participant EP as epic-plan.js
    participant TD as ticket-decomposer.js
    participant D as /epic-execute
    participant DI as dispatcher.js
    participant CH as context-hydrator.js
    participant A as Agent (IDE)
    participant GH as GitHub

    H->>GH: Create Epic issue
    H->>P: /epic-plan #EPIC
    P->>EP: Generate PRD + Tech Spec
    EP->>GH: Create linked context issues
    EP->>TD: Decompose into tasks
    TD->>GH: Create Feature → Story → Task hierarchy

    H->>D: /epic-execute #EPIC
    D->>DI: Build DAG, compute waves
    DI->>GH: Create epic/ and story/ branches
    DI->>CH: Hydrate task context
    CH-->>DI: Self-contained prompt
    DI->>A: Dispatch story (Agent-tool sub-agent)
    A->>GH: Update labels (agent::executing → done)
```

---

## Epic Runner

The epic runner (`.agents/scripts/lib/orchestration/epic-runner.js`) composes
the orchestration primitives into an unattended execution loop. Invoked via
`/epic-execute <epicId>` inside the operator's Claude session. There is no
remote-trigger surface — the runner only ever runs locally, in the operator's
session, with Story sub-agents launched through the Agent tool.

### State machine (Epic labels)

```text
                    operator runs /epic-execute
                   ┌───────────────────────────┐
                   │                           ▼
  (any state) ──► agent::ready ─────────► agent::executing
                                               │
                                               │ wave-N halts on blocker
                                               ▼
                                        agent::blocked  ──── operator flips back ───┐
                                               │                                    │
                                               │ ───────────────────────────────────┘
                                               ▼
                        final wave completes ──► agent::review
                                                    │
                                 epic::auto-close?  │
                               (snapshot at dispatch)
                                                    │ yes
                                                    ▼
                                               /epic-close
                                          (auto-invokes helpers:
                                           epic-code-review.md,
                                           epic-retro.md)
                                                    │
                                                    ▼
                                               agent::done
```

### Submodules

| Module              | Role                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `wave-scheduler`    | Iterates waves from `Graph.computeWaves()`; never spawns workers.                                   |
| `story-launcher`    | Fans out up to `concurrencyCap` `/story-execute <storyId>` Agent-tool sub-agents in one message.    |
| `state-poller`      | Polls Epic + child-Story labels; emits blocker / cancel / closed events.                            |
| `checkpointer`      | Upserts the `epic-run-state` structured comment; handles resume.                                    |
| `blocker-handler`   | The sole runtime pause point; halts on `agent::blocked`, waits to resume.                           |
| `notification-hook` | Fire-and-forget webhook; never blocks execution.                                                    |
| `bookend-chainer`   | Invokes `/epic-close` on auto-close (which in turn auto-invokes the code-review + retro helpers).   |
| `wave-observer`     | Emits `wave-N-start` / `wave-N-end` structured comments each boundary.                              |
| `column-sync`       | Drives the Projects v2 Status column from `agent::` labels (best-effort).                           |

### HITL touchpoints

One runtime pause point — `agent::blocked` on the Epic. All other labels
(`risk::high`, `epic::auto-close`) are snapshots or metadata; mid-run changes
are ignored. Branch protection on `main` replaces `risk::high` runtime gating
for destructive-action containment.

---

## Ticket Hierarchy

The framework uses a 4-tier GitHub Issue hierarchy with label-based typing and
`blocked by #NNN` dependency wiring:

```text
Epic (type::epic)
├── PRD (context::prd)
├── Tech Spec (context::tech-spec)
├── Feature (type::feature)
│   ├── Story (type::story)
│   │   ├── Task (type::task)     ← Atomic agent work unit
│   │   │   ├── - [ ] subtask 1
│   │   │   └── - [ ] subtask 2
│   │   └── Task (type::task)
│   └── Story (type::story)
└── Feature (type::feature)
```

### State Machine

Each Task progresses through a label-driven state machine:

```mermaid
stateDiagram-v2
    [*] --> agent_ready: Created by decomposer
    agent_ready --> agent_executing: Dispatcher picks up
    agent_executing --> agent_review: Agent completes
    agent_review --> agent_done: Review passes
    agent_done --> [*]

    agent_executing --> agent_ready: Hotfix rollback
```

### Cascade Behavior

When a child ticket transitions to `agent::done`, `cascadeCompletion()` walks
upward through the hierarchy and closes parents whose children are all done.
The cascade is **not** uniform across tiers — the table below is the
authoritative contract:

| Parent tier                                     | Auto-closes via cascade? | How it closes                             |
| ----------------------------------------------- | ------------------------ | ----------------------------------------- |
| Story (`type::story`)                           | Yes                      | Last Task → `agent::done` cascades.       |
| Feature (`type::feature`)                       | Yes                      | Last Story → `agent::done` cascades.      |
| Epic (`type::epic`)                             | **No** — cascade stops.  | `/epic-close` only.                       |
| Planning (`context::prd`, `context::tech-spec`) | **No** — cascade stops.  | Operator close after Epic is finalized.   |

**Why Features auto-close but Epics and Planning don't.** A Feature is a
purely hierarchical grouping — no standalone branch, no merge step, no
release artefacts. When its last child Story closes, the Feature is complete
by definition; a manual Feature-close step would be pure ceremony. Operators
who need Feature-level acceptance-criteria verification should encode it in
the final child Story, not add a manual gate. Epics, by contrast, close via
`/epic-close` which owns branch merges, version bumps, and release tags —
cascade must not pre-empt that machinery. Planning tickets (PRD, Tech Spec)
are narrative artefacts the operator closes once the Epic is finalized.

Implementation: [`.agents/scripts/lib/orchestration/ticketing.js`](../.agents/scripts/lib/orchestration/ticketing.js)
— `cascadeCompletion()` explicitly skips `type::epic`, `context::prd`, and
`context::tech-spec` parents; every other parent tier is eligible. The
`fromState` lookup inside `transitionTicketState()` has a deliberate
try/catch — a network flake reading the prior state label must not block a
legitimate transition; failures emit a `debug`-level log instead of swallowing
silently.

---

## Workflow System

The shipped slash commands (under `.agents/workflows/`) fall into six
categories — planning, execution, closure, audits, git operations, and
setup/meta. The canonical reference is [`workflows.md`](workflows.md); the
workflow narrative that wires them together lives in
[`.agents/SDLC.md`](../.agents/SDLC.md).

### Worktree Isolation

When `orchestration.worktreeIsolation.enabled` is `true`, each dispatched
story runs inside its own `git worktree` at `.worktrees/story-<id>/`. The main
checkout's HEAD never moves during a parallel run; branch swaps, staging
operations, and reflog activity are isolated per-story.

The `WorktreeManager` (`.agents/scripts/lib/worktree-manager.js`) is the
single authority for worktree `ensure`/`reap`/`list`/`isSafeToRemove`/`gc`.
No other script may call `git worktree` directly. All git calls are
argv-based (no shell interpolation) and validate `storyId` / `branch` before
shelling out. `reap` only reaches `git worktree remove --force` after its
safety gate has already established the Story worktree is removable and the
plain remove path has exhausted Windows lock/cwd retry.

**Internal submodule layout.** `worktree-manager.js` is a façade composing
four cohesive submodules under `.agents/scripts/lib/worktree/`:

| Submodule                  | Responsibility                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lifecycle-manager.js`     | `ensure`, `reap`, `list`, `gc`, `prune`, `sweepStaleLocks`, Windows-lock-aware remove recovery.         |
| `node-modules-strategy.js` | `applyNodeModulesStrategy` + `installDependencies` for `per-worktree` / `symlink` / `pnpm-store`.       |
| `bootstrapper.js`          | Bootstrap-file copy (`.env`), `.agents/` snapshot for submodule consumers, submodule-index scrub.       |
| `inspector.js`             | Pure porcelain parsing, path helpers (`samePath`, `storyIdFromPath`, `isInsideWorktree`), Windows path warnings. |

The submodules are **internal implementation detail**. Downstream projects
must continue to import `WorktreeManager` from `lib/worktree-manager.js`.

Dispatcher integration:

- **Ensure before dispatch**: `dispatch()` calls `wm.ensure(storyId, branch)`
  and threads the resolved worktree path as `cwd` into
  `IExecutionAdapter.dispatchTask`. The `ManualDispatchAdapter` surfaces the
  path as a `cd "<path>"` instruction for the HITL operator.
- **Reap on merge**: `story-close` calls `wm.reap` after a successful merge.
  The reap refuses dirty trees and logs a warning.
- **GC on dispatch start**: `dispatch()` sweeps orphaned worktrees whose
  stories have no remaining live tasks. Refuses to delete unmerged branches.

Setting `orchestration.worktreeIsolation.enabled: false` (or omitting the
block) restores single-tree behavior. The `assert-branch.js` pre-commit guard
and focus-area wave serialization remain in place as defense-in-depth in both
modes.

See [`worktree-lifecycle.md`](../.agents/workflows/worktree-lifecycle.md) for
the operator reference, node_modules strategies, Windows long-path handling,
and escape hatches.

### Execution-model modes

The four-skill execution surface (`/epic-execute`, `/wave-execute`,
`/story-execute`) runs in two execution-model modes that share one codepath
and differ only in whether worktrees are created. The `resolveWorktreeEnabled`
function in `lib/config-resolver.js` selects the mode at startup based on
`AP_WORKTREE_ENABLED` and `CLAUDE_CODE_REMOTE` (precedence in
[`patterns.md`](patterns.md)):

```text
┌──── Local-parallel (worktrees on, default) ─────┐  ┌──── Web-parallel (worktrees off, auto) ─────┐
│                                                  │  │                                              │
│  one machine, one clone of the repo              │  │  N web tabs, each its own sandboxed clone   │
│                                                  │  │                                              │
│  ┌─ main checkout ──────────────────────┐        │  │  ┌─ tab 1 (clone A) ─┐                      │
│  │                                       │        │  │  │  story-680        │                      │
│  │  HEAD never moves while waves run     │        │  │  │  branch HEAD      │                      │
│  │                                       │        │  │  └───────────────────┘                      │
│  │  ┌─ .worktrees/story-680/ ─┐         │        │  │  ┌─ tab 2 (clone B) ─┐                      │
│  │  │  story-680 branch HEAD  │         │        │  │  │  story-681        │                      │
│  │  └─────────────────────────┘         │        │  │  │  branch HEAD      │                      │
│  │  ┌─ .worktrees/story-681/ ─┐         │        │  │  └───────────────────┘                      │
│  │  │  story-681 branch HEAD  │         │        │  │  ┌─ tab 3 (clone C) ─┐                      │
│  │  └─────────────────────────┘         │        │  │  │  story-682        │                      │
│  └───────────────────────────────────────┘        │  │  │  branch HEAD      │                      │
│                                                  │  │  └───────────────────┘                      │
│  Concurrency primitive: git worktree             │  │  Concurrency primitive: separate clones      │
│  Coordination at close: filesystem lock          │  │  Coordination at close: bounded push retry   │
│  Operator launches: N IDE windows                │  │  Operator launches: N web tabs               │
└──────────────────────────────────────────────────┘  └──────────────────────────────────────────────┘
                            ▲                                         ▲
                            │                                         │
                            └────────── shared launch primitive ──────┘
                              operator picks Story id from /epic-plan
                                  dispatch table, one session per id
```

Both modes share:

- The same `/story-execute` Agent-tool sub-agent contract and the same
  parent-driven dispatch logic out of `/wave-execute`.
- The launch-time dependency guard (`runDispatchManifestGuard`) that refuses
  a story with unmerged blockers.
- Deterministic, operator-driven story assignment — `/story-execute` always
  takes an explicit Story id. There is no per-launch label race.
- The bounded retry on the epic-branch push (`lib/push-epic-retry.js`,
  configured by `orchestration.closeRetry`) so concurrent closes from
  separate clones converge cleanly.

They differ only in:

- **Filesystem layout.** Worktrees create `.worktrees/story-<id>/` siblings
  to the main checkout; web sessions write directly into the cloned workspace
  because the session is already isolated.
- **`node_modules` strategy.** `nodeModulesStrategy` runs only in worktree-on
  mode. Web sessions install once at the workspace root.
- **Path-length warnings.** Windows long-path warnings come from worktree
  paths — they don't fire on web (Linux) or in worktree-off mode generally.
- **GC scope.** `WorktreeManager.gc()` runs at dispatch start in worktree-on
  mode; in worktree-off mode it is a no-op.

---

## Security Architecture

### Input Validation

- **Shell injection protection**: `config-resolver.js` scans all config string
  values against a metacharacter regex (`/([;&|`]|\$\()/`) before they reach
  subprocess calls.
- **Branch name validation**: `dependency-parser.js` enforces safe branch
  component characters (alphanumeric, hyphens, underscores, dots, slashes).
- **Schema validation**: `orchestration` config is validated against an
  embedded JSON Schema via `ajv`. As of Epic #990 (audit remediation),
  the static `.agents/schemas/*.json` mirrors and the runtime AJV
  schemas declare `additionalProperties: false` on the document root of
  `audit-results`, `friction-event`, and `agentrc`; carry `if/then`
  conditional requirements on `healthRefresh.cadence`; and use a closed
  enum for `validation-evidence.gateName`. Payloads with extra keys or
  free-text discriminators now fail validation rather than silently
  passing.

### HITL pause point

The sole runtime pause is `agent::blocked` on the Epic. `risk::high` is
informational/planning metadata only — it ranks work in the dispatch table and
helps reviewers prioritize, but does not pause execution.
`riskGates.heuristics` in `.agentrc.json` drives the ranking heuristics.

### Anti-Thrashing Protocol

The framework enforces two circuit breakers to prevent runaway cost:

- **Error Threshold** (`consecutiveErrorCount`, default 3): Stop after N
  consecutive tool errors.
- **Stagnation Threshold** (`stagnationStepCount`, default 5): Stop after N
  steps without file modifications.

---

## Observability

### Friction Telemetry

Operational difficulties are logged directly to GitHub Task tickets via
`diagnose-friction.js`. This captures tool failures, command errors, and
automation candidates as structured comments.

### Log Levels

`lib/Logger.js` is the single orchestrator logger. Level is selected via
`AGENT_LOG_LEVEL`:

- `silent`  — only `fatal` emits.
- `info`    — default. `info` / `warn` / `error` / `fatal` emit; `debug` is
  suppressed.
- `verbose` — all levels emit, including `debug` trace output. `debug` is
  accepted as a backward-compatible alias for `verbose`.

### Notification System

| Event               | Severity | Channel            |
| ------------------- | -------- | ------------------ |
| `task-complete`     | INFO     | GitHub @mention    |
| `feature-complete`  | INFO     | GitHub @mention    |
| `epic-complete`     | INFO     | @mention + webhook |
| `review-needed`     | ACTION   | @mention + webhook |
| `approval-required` | ACTION   | Webhook            |
| `blocked`           | ACTION   | Webhook            |

`agentSettings.notifications` carries three independent per-channel gates —
`commentMinLevel`, `webhookMinLevel`, `terminalMinLevel` — each mandatory and
each defaulting to `medium`. There is no fallback chain; raising or lowering
one channel never affects the others. Per-Task `agent::executing` transitions
during Story init batch into a single Story-level summary comment regardless
of any filter. Webhook subscribers receive a typed envelope
(`{ text, severity, ticketId, event?, level?, epicId?, phase? }`) so progress
events from `story-run-progress` / `wave-run-progress` / `epic-run-progress`
upserts are routable alongside the existing `state-transition` /
`epic-blocked` / `epic-complete` events.

---

## Testing

The test suite uses the **Node.js native test runner** (`node --test`) with no
external test framework dependencies. Tests live under `tests/` with
`tests/lib/` for library-specific unit tests and `tests/epic-runner/` for
runner-integration tests. Run with `npm test`.

---

## CI/CD Pipeline

A single GitHub Actions workflow (`ci.yml`) runs on every push and PR:

1. **Lint** — Biome (JavaScript) + markdownlint (Markdown).
2. **Format Check** — Biome format verification.
3. **Test** — Full test suite via `npm test`.
4. **Maintainability Check** — `check-maintainability.js` no-regression gate
   on the per-file MI baseline.
5. **CRAP Check** — `check-crap.js` (per-method complexity × coverage risk).
   Diff-scoped on PRs (`--changed-since origin/<base_ref>`); full-repo scan on
   push-to-main so a regression in an untouched file cannot ride in alongside
   an unrelated PR. JSON report uploaded as the `crap-report` artifact.
6. **Baseline-refresh guardrail** — separate `pull_request`-only workflow
   (`.github/workflows/baseline-refresh-guardrail.yml`) that reads the **base
   branch** `.agentrc.json` via `git show origin/<base>:.agentrc.json`,
   re-runs `check-crap` with those values forced via `CRAP_NEW_METHOD_CEILING`
   / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG` env vars, and enforces that any PR
   touching `baselines/crap.json` or `baselines/maintainability.json` carries
   a commit whose subject starts with the configured `refreshTag` (default
   `baseline-refresh:`) and has a non-empty body. Baseline-only PRs receive
   the `review::baseline-refresh` label automatically.
7. **Dist Sync** — On merge to `main`, syncs `.agents/` to the `dist` branch
   for consumer submodule distribution.

### Quality-gate diagram

```text
        ┌───────────────────────────────────────┐
local ▶ │ pre-push (.husky/pre-push):           │
        │   lint → format → MI → audit →        │
        │   test:coverage → check-crap          │
        └───────────────────┬───────────────────┘
                            │
        ┌───────────────────▼───────────────────┐
close ▶ │ close-validation DEFAULT_GATES:       │
        │   lint → test → biome format →        │
        │   check-maintainability → check-crap  │
        │   (each gate skips when SHA-keyed     │
        │    evidence still matches)            │
        └───────────────────┬───────────────────┘
                            │
        ┌───────────────────▼───────────────────┐
CI    ▶ │ ci.yml:                               │
        │   lint+format → MI → test:coverage →  │
        │   check-crap → upload crap-report     │
        │ baseline-refresh-guardrail.yml:       │
        │   base-config → tag check →           │
        │   check-crap (CRAP_*=base) →          │
        │   review::baseline-refresh label      │
        └───────────────────────────────────────┘
```

### Evidence-aware gate caching

Local close-validation, `epic-code-review`, and `/epic-close` Phase 4 wrap
each gate in `evidence-gate.js`. On a successful run the wrapper records
`{ gateName, commitSha, commandConfigHash, timestamp }` in
`temp/validation-evidence-<scopeId>.json` (gitignored). Subsequent invocations
against the same `git rev-parse HEAD` and resolved command config skip in
milliseconds. `--no-evidence` forces a re-run; pre-push and CI ignore the
evidence file entirely so independent verification is never bypassed.

All three sites converge on the same `check-crap.js` binary and the same
`baselines/crap.json` artifact, so a regression caught at any one site fails
the gate identically at the others. The base-enforced re-run in the guardrail
workflow exists so a PR cannot simultaneously raise `newMethodCeiling` AND
ship a method over the base ceiling — the guardrail rejects it under
base-branch values regardless of what the PR-branch config says.

### Local Hooks

- **Husky** + **lint-staged**: Auto-lint and format staged files on commit.

---

## FinOps Model

The framework implements an economic guardrail system for LLM cost management:

### Budget Protocol

- **Soft Warning** at 80% of `maxTokenBudget` → user notification + webhook.
- **Hard Stop** at 100% → execution halt, requires human override.

---

## Distribution Model

Agent Protocols is distributed as a **Git submodule** via the `dist` branch:

```text
Consumer Project/
├── .agents/          ← Git submodule pointing to dist branch
│   ├── instructions.md
│   ├── personas/
│   ├── rules/
│   ├── skills/
│   ├── workflows/
│   ├── scripts/
│   └── ...
├── .agentrc.json     ← Project-specific configuration
└── ...
```

Consumers add the submodule, copy `default-agentrc.json` to their project root
as `.agentrc.json`, and configure their `orchestration` block. Project-specific
technology context lives in `docs/architecture.md` under the **Tech Stack**
section below — not in `.agentrc.json`.

---

## Tech Stack

This section is the authoritative reference for the technology choices the
agent should assume when working in this repository. Keep it **current**: the
agent reads this to decide how to write code, which commands to run, and which
conventions to follow.

> **Template note:** Downstream projects should maintain their own
> `## Tech Stack` section in their own `docs/architecture.md`. Agent Protocols
> does not ship a standalone template — this section doubles as the working
> example.

### Runtime & Language

- **Runtime:** Node.js (ESM, `"type": "module"` in `package.json`)
- **Language:** JavaScript with JSDoc for type hints (no TypeScript build step)
- **Package manager:** npm

### Tooling

- **Linter & formatter:** Biome (`@biomejs/biome`)
- **Markdown lint:** `markdownlint-cli`
- **Markdown format:** Prettier (markdown only)
- **Git hooks:** Husky + `lint-staged`
- **JSON Schema validation:** Ajv + `ajv-formats`
- **In-memory filesystem for tests:** `memfs`
- **Shell argv parsing:** `string-argv`
- **Complexity metrics:** `typhonjs-escomplex` (maintainability baseline
  enforcement)

### Testing

- **Framework:** Node.js native test runner (`node --test`)
- **Test file pattern:** `tests/**/*.test.js`
- **Coverage:** `node --experimental-test-coverage` with thresholds
  enforced in `npm run test:coverage` (lines 85, branches 70, functions 75)

### Key Scripts

- **Orchestration engine:** `.agents/scripts/lib/orchestration/` — dispatch,
  manifest build, story execution, context hydration
- **Ticketing provider abstraction:** `.agents/scripts/lib/ITicketingProvider.js`
  with a shipped GitHub implementation in `.agents/scripts/providers/github.js`
- **Execution adapter abstraction:** `.agents/scripts/lib/IExecutionAdapter.js`
  with a manual adapter in `.agents/scripts/adapters/manual.js`
- **Config resolution:** `.agents/scripts/lib/config-resolver.js` +
  `config-schema.js` (shell-metacharacter injection guards built in)

### Ticketing & CI

- **Ticketing provider:** GitHub (Issues, Labels, Projects V2, Sub-Issues API)
- **CI:** GitHub Actions
- **Distribution:** GitHub Releases (tagged from `main` by `/epic-close`)

### Testing Contract

Consumers of the framework follow a **pyramid-aware** testing contract defined
in `.agents/rules/testing-standards.md`. Every test belongs to exactly one of
three tiers and carries distinct scope, dependency, and assertion rules:

- **Unit** — pure logic, no I/O; assertions on return values and rendered
  output.
- **Contract** — API ↔ DB invariants and schema conformance; this is the sole
  correct home for HTTP status codes, response body shapes, and error-envelope
  assertions.
- **E2E / Acceptance** — `.feature` files authored against
  `.agents/rules/gherkin-standards.md` (the SSOT for the tag taxonomy and
  forbidden patterns) and executed via `/run-bdd-suite`, whose Cucumber
  HTML/JSON report is the canonical evidence artifact consumed by the
  `workflows/helpers/epic-testing.md` helper.

Stack skills `skills/stack/qa/gherkin-authoring` and `skills/stack/qa/playwright-bdd`
provide authoring guidance and runtime wiring respectively; neither redefines
the rule. Scripts in this repository do not themselves run `.feature` files —
they ship the contract that consumer projects implement.

### What the Agent Should **Not** Assume

- There is no monorepo tool (no Turborepo, no pnpm workspaces) — this is a
  single-package repository.
- There is no web, mobile, database, or auth layer — this repo is a framework
  of protocols and scripts, not an application.
- There is no TypeScript compilation step; do not add `tsc` invocations.
- There is no bundler; scripts are executed directly with `node`.
