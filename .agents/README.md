# Agent Protocols — Consumer Reference

This is the detailed reference guide for teams consuming the Agent Protocols
framework via the `.agents/` Git submodule.

## Directory Layout

```text
.agents/
├── VERSION                  # Framework version (read this file, not a count here)
├── SDLC.md                  # End-to-end workflow guide
├── instructions.md          # MANDATORY: Primary system prompt
├── default-agentrc.json     # Copy to project root as .agentrc.json
├── personas/                # 12 role-specific behavior constraints
├── rules/                   # 10 domain-agnostic coding standards
├── schemas/                 # JSON Schemas for structured output validation
├── scripts/                 # v5 orchestration engine (CLI wrappers + SDK)
│   ├── lib/                 # Core libraries, orchestration SDK, providers
│   ├── providers/           # Ticketing provider implementations (GitHub)
│   └── adapters/            # Execution adapters
├── skills/                  # Two-tier skill library
│   ├── core/                # Universal process skills (20 skills)
│   └── stack/               # Tech-stack-specific guardrails (22 skills)
├── templates/               # Context hydration and CI templates
└── workflows/               # Slash-command workflows
    └── helpers/             # Path-included helper modules (not slash commands)
```

---

## System Prompt (`instructions.md`)

**This file is the agent's system prompt.** Configure your AI tool
(`.cursorrules`, Custom Instructions, or system prompt settings) to load its
full content.

The system prompt instructs agents to:

1. **Ingest** the baseline rules from `rules/`.
1. **Route** to the appropriate persona from `personas/`.
1. **Activate** domain guardrails from `skills/`.
1. **Retrieve** live documentation via Context7 MCP.
1. **Enforce** Windows shell compatibility (`;` not `&&`).

> [!IMPORTANT] You MUST configure your AI tool to load `instructions.md` as its
> primary system prompt. Without this, none of the protocols are active.

---

## Configuration (`.agentrc.json`)

All agent scripts resolve settings from a unified `.agentrc.json` at your
project root.

**Setup — run once per project:**

```bash
cp .agents/default-agentrc.json .agentrc.json
```

### Key Settings

The grouped shape lives under `agentSettings.{paths,commands,quality,limits}`
with `orchestration` as its sibling. The most-touched keys:

| Setting                                                | Required | Purpose                                                       |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------- |
| `agentSettings.paths.agentRoot`                        | Yes      | Path to the framework submodule (e.g. `.agents`)              |
| `agentSettings.paths.docsRoot`                         | Yes      | Path to project documentation (e.g. `docs`)                   |
| `agentSettings.paths.tempRoot`                         | Yes      | Path for ephemeral artefacts (e.g. `temp`)                    |
| `agentSettings.baseBranch`                             | No       | Your default branch (`main`, `master`, etc.)                  |
| `agentSettings.commands.test`                          | No       | Your project's test runner                                    |
| `agentSettings.commands.validate`                      | No       | Comprehensive validation suite                                |
| `agentSettings.commands.lintBaseline`                  | No       | Structured linter output for baseline ratcheting              |
| `agentSettings.quality.baselines.{lint,crap,maintainability}.path` | No | Paths to canonical ratchet baselines (default `baselines/*.json`) |
| `agentSettings.quality.crap.enabled`                   | No       | Master switch for the CRAP gate                               |
| `agentSettings.limits.friction.*`                      | No       | Anti-thrashing thresholds                                     |
| `orchestration.provider`                               | Yes      | Ticketing provider (`"github"`)                               |
| `orchestration.github.owner`                           | Yes\*    | GitHub repository owner (\* required when `provider: "github"`) |
| `orchestration.github.repo`                            | Yes\*    | GitHub repository name                                        |

> **Full reference.** Every key, default, and required-vs-optional flag is
> documented in [`docs/configuration.md`](../docs/configuration.md). That file
> is the canonical reader-facing reference; the table above is just the
> high-traffic subset.

### Validation Commands

Quality-check commands live grouped under `agentSettings.commands`:

1. **`commands.validate`** — Comprehensive check (e.g., `run-s lint typecheck`).
1. **`commands.typecheck`** — Strict type-checking (e.g., `tsc --noEmit`). Run
   independently after refactors to verify typing boundaries. Set to `null` to
   disable.
1. **`commands.lintBaseline`** — Structured JSON output for the lint baseline
   ratchet engine. Integrations fail if new warnings are introduced.

> **Resolution order:** `.agentrc.json` at project root → built-in defaults
> (zero-config fallback).

### Local Overrides

Override protocol behavior per-machine with `.agents/instructions.local.md`
(rules) or `.agentrc.local.json` (config). These are automatically gitignored.

### Root dogfood vs distributed template

Two `.agentrc`-shaped files live in this repository and are easy to confuse.
They serve different audiences and legitimately disagree on a small number of
keys.

| File                             | Audience                              | Role                                                                                                                                |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `.agentrc.json` (repo root)      | The framework dogfooding itself       | Live config used when running `/epic-*`, `/wave-execute`, and `/story-execute` workflows against this repo. Exercises the framework end-to-end on its own source tree. |
| `.agents/default-agentrc.json`   | Downstream consumer repos             | The template a consumer copies via `cp .agents/default-agentrc.json .agentrc.json` when bootstrapping. Sane defaults for any repo. |

The two files share a schema and the vast majority of keys are identical.
Where they diverge, the divergence is intentional:

- **`quality.maintainability.targetDirs` / `quality.crap.targetDirs`.** Root
  dogfood scans `.agents/scripts` (the framework's own source tree); the
  distributed template scans `src` (the conventional consumer source root).
  The resolver's code-level fallback also defaults to `src` so a consumer with
  no override matches the template they copied from.
- **Repo-specific orchestration values.** `orchestration.github.owner`,
  `orchestration.github.repo`, and any project-board pointers are populated in
  the root config and left as placeholders in the template.
- **Optional dogfood-only keys.** Keys the framework exercises against itself
  (e.g. orchestration tuning the dogfood Epic uses) may be present in the
  root config and absent from the template; `agents-sync-config` is
  schema-driven so legitimate overrides are preserved across syncs.

When in doubt: edit `.agents/default-agentrc.json` for changes that should
ship to consumers, and edit `.agentrc.json` for changes that only affect this
repo's own dogfood runs.

---

## Activation

1. **Configure** your AI tool to load `.agents/instructions.md` as the system
   prompt.
1. **Use personas** by telling the agent to "Act as [Role]" — it loads the
   matching file from `personas/`.
1. **Activate skills** by name or let the agent auto-discover `SKILL.md` files
   in `skills/core/` and `skills/stack/`.
1. **Run workflows** using slash commands (e.g., `/epic-plan`,
   `/audit-security`).

---

## Bootstrap (`/agents-bootstrap-github`)

Before running any Epic workflows, you must bootstrap your GitHub repository
so the orchestration engine has the labels, project fields, and metadata it
expects. The bootstrap script is **idempotent** — safe to run multiple times.

### Prerequisites

1. **`.agentrc.json`** at your project root with a valid `orchestration` block
   (copy from `.agents/default-agentrc.json` if you haven't already).
2. **GitHub authentication** — one of:
   - `GITHUB_TOKEN` or `GH_TOKEN` environment variable (CI / background scripts)
   - `gh auth login` (local developer workflow)
   - Active `github-mcp-server` session (agentic IDE)
3. **Token permissions** — the token must have `Issues: Read & Write` and
   `Metadata: Read-only`. If using GitHub Projects V2 fields, also
   `Projects: Read & Write`.

### What It Does

| Step | Action                               | Details                                                                                                                                               |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Verify API access**                | Sends a canary request to confirm authentication and repository access.                                                                               |
| 2    | **Create labels**                    | Creates labels across 7 categories (`type::`, `agent::`, `status::`, `risk::`, `persona::`, `context::`, `execution::`). Existing labels are skipped. |
| 3    | **Create project fields** (optional) | If `orchestration.github.projectNumber` is set, creates the `Execution` single-select field on the GitHub Project V2 board.                           |
| 4    | **Install workflows** (optional)     | With `--install-workflows`, copies CI workflow templates into `.github/workflows/`.                                                                   |

### Running It

**Via slash command (recommended):**

```text
/agents-bootstrap-github
```

**Via CLI:**

```bash
node .agents/scripts/agents-bootstrap-github.js
node .agents/scripts/agents-bootstrap-github.js --install-workflows
```

### Label Categories

| Category    | Example Labels                                                     | Purpose                          |
| ----------- | ------------------------------------------------------------------ | -------------------------------- |
| Type        | `type::epic`, `type::feature`, `type::story`, `type::task`         | Issue hierarchy classification   |
| Agent State | `agent::ready`, `agent::executing`, `agent::review`, `agent::done` | Tracks agent execution lifecycle |
| Status      | `status::blocked`                                                  | Signals blocked work items       |
| Risk        | `risk::high`, `risk::medium`                                       | Informational metadata; planning/ranking only — no runtime pause |
| Persona     | `persona::<name>` — one per file in [.agents/personas/](personas/) | Agent role assignment            |
| Context     | `context::prd`, `context::tech-spec`                               | Planning document classification |
| Execution   | `execution::sequential`, `execution::concurrent`                   | Dispatch strategy hints          |

> [!TIP] After bootstrapping, run `/epic-plan [EPIC_ID]` to begin the planning
> phase. See the [SDLC guide](SDLC.md) for the full end-to-end workflow.

---

## Secrets now live in `.env`

As of Epic #702 the framework no longer ships an MCP server, so `.mcp.json`
is **not** a valid home for framework secrets. Every environment variable
the orchestration engine reads is sourced from the process environment
only — loaded from `.env` locally, or set in the Claude Code web
environment-variables UI for web sessions.

### Keys the framework reads

| Variable                   | Required? | Purpose                                                                                                            |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`             | Yes\*     | GitHub API auth for all ticketing operations. `GH_TOKEN` is accepted as a synonym. `gh auth token` is a fallback for local sessions. |
| `NOTIFICATION_WEBHOOK_URL` | No        | POST target for in-band Notifier events (Make.com / Slack / Discord). Unset disables the webhook channel; `log` and `epic-comment` channels still fire. |
| `WEBHOOK_SECRET`           | No        | Shared secret used to sign outbound webhook payloads as `X-Signature-256: sha256=<hmac>`. Unset ships unsigned payloads. |

\* `GITHUB_TOKEN`/`GH_TOKEN` is required for background scripts and CI; a
locally-authenticated `gh auth login` session is an acceptable substitute
in interactive developer sessions only.

### Where to put them

| Environment                | Storage location                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Local development          | `.env` at the project root (auto-loaded by `config-resolver.js`). The file is `.gitignore`d; provision it per clone.  |

`.mcp.json` is reserved for your MCP host's own discovery of third-party
servers (e.g. `@modelcontextprotocol/server-github`, `context7`) and is
ignored by the orchestration engine. Any framework-specific keys still
present in a `.mcp.json` from a pre-#702 checkout are **dead config** —
move them to `.env` (local) or your web session's env-var UI (web).

---

## Personas

Personas constrain agent behavior to a specific role.

| File                   | Role            | Focus                                                      |
| ---------------------- | --------------- | ---------------------------------------------------------- |
| `architect.md`         | Architect       | System design, tech specs, API contracts, security         |
| `engineer.md`          | Engineer (Gen)  | Implementation, backend, shared libs, logic                |
| `engineer-web.md`      | Web Engineer    | Frontend UI, Astro/React, browser performance, WCAG        |
| `engineer-mobile.md`   | Mobile Engineer | Expo/React Native, native modules, mobile UX               |
| `product.md`           | Product Mgr     | PRDs, user stories, MVP scoping, retros                    |
| `ux-designer.md`       | UX Designer     | Journey maps, component states, visual hierarchy           |
| `qa-engineer.md`       | QA Engineer     | Test plans, E2E/Unit automation, test data management      |
| `devops-engineer.md`   | DevOps Engineer | CI/CD pipelines, IaC, build tooling, DX                    |
| `sre.md`               | SRE             | Reliability, observability, performance, incident response |
| `security-engineer.md` | Security Eng    | Audits, threat modeling, auth/authz, data privacy          |
| `technical-writer.md`  | Tech Writer     | Documentation, changelogs, Mermaid diagrams                |
| `project-manager.md`   | Project Mgr     | Epic decomposition, playbook generation, orchestration     |

---

## Rules

Modular, domain-agnostic standards loaded by the system prompt.

| File                                 | Domain          | Purpose                                                |
| ------------------------------------ | --------------- | ------------------------------------------------------ |
| `api-conventions.md`                 | API             | RESTful standards, status codes, and JSON patterns     |
| `changelog-style.md`                 | Release         | Keep-a-Changelog formatting and release-note grammar   |
| `coding-style.md`                    | Generic         | Clean code standards and file structure conventions    |
| `database-standards.md`              | Database        | Migration safety, naming, and indexing strategies      |
| `git-conventions.md`                 | Version Control | Branching strategy and PR quality standards            |
| `security-baseline.md`               | Security        | OWASP basics, credential safety, and encryption rules  |
| `testing-standards.md`               | Quality         | Pyramid tiers, coverage thresholds, assertion rules    |
| `gherkin-standards.md`               | Quality         | `.feature` grammar, tag taxonomy, forbidden patterns   |
| `ui-copywriting.md`                  | UX              | Content tone, error messaging, and labeling standards  |
| `search-and-execution-heuristics.md` | Shell & Search  | Optimized command usage and pipeline safety heuristics |

---

## Skills

The skill library uses a **two-tier architecture**: universal process skills
(`core/`) and technology-specific guardrails (`stack/`).

### Core Skills (`skills/core/`)

| Skill                           | Phase    | Purpose                                                  |
| ------------------------------- | -------- | -------------------------------------------------------- |
| `idea-refinement`               | Define   | Structured divergent/convergent thinking for vague ideas |
| `spec-driven-development`       | Define   | Requirements and acceptance criteria before code         |
| `planning-and-task-breakdown`   | Plan     | Decompose features into small, verifiable tasks          |
| `context-engineering`           | Build    | Load the right context at the right time                 |
| `incremental-implementation`    | Build    | Thin vertical slices, verified before expanding          |
| `api-and-interface-design`      | Build    | Stable interfaces with clear contracts                   |
| `frontend-ui-engineering`       | Build    | Production-quality UI with accessibility                 |
| `code-simplification`           | Build    | Resist over-engineering; prefer the boring solution      |
| `test-driven-development`       | Verify   | Failing test first, then make it pass                    |
| `browser-testing-with-devtools` | Verify   | Chrome DevTools MCP for runtime verification             |
| `debugging-and-error-recovery`  | Verify   | Reproduce → localize → fix → guard                       |
| `code-review-and-quality`       | Review   | Five-axis review with quality gates                      |
| `security-and-hardening`        | Review   | OWASP prevention, input validation, least privilege      |
| `performance-optimization`      | Review   | Measure first, optimize only what matters                |
| `git-workflow-and-versioning`   | Ship     | Atomic commits, clean history, conventional commits      |
| `ci-cd-and-automation`          | Ship     | Automated quality gates on every change                  |
| `documentation-and-adrs`        | Ship     | Document the why, not just the what                      |
| `shipping-and-launch`           | Ship     | Pre-launch checklist, monitoring, rollback plan          |
| `deprecation-and-migration`     | Maintain | Safe removal of legacy code and upgrade patterns         |
| `using-agent-skills`            | Meta     | Skill discovery and sequencing guide                     |

### Stack Skills (`skills/stack/`)

| Skill                           | Category       | Purpose                                               |
| ------------------------------- | -------------- | ----------------------------------------------------- |
| `monorepo-path-strategist`      | `architecture` | Enforces workspace aliases and dependency boundaries  |
| `structured-output-zod`         | `architecture` | Enforces structured API responses using Zod           |
| `subagent-orchestration`        | `architecture` | Defines subagent task delegation strategies           |
| `cloudflare-hono-architect`     | `backend`      | Prevents Node.js module usage in edge Workers         |
| `cloudflare-queue-manager`      | `backend`      | Ensures idempotent, resilient queue consumer logic    |
| `cloudflare-workers`            | `backend`      | Cloudflare edge compute best practices                |
| `highlevel-crm`                 | `backend`      | Guidelines for GoHighLevel CRM integration            |
| `sqlite-drizzle-expert`         | `backend`      | Enforces SQLite dialect for Drizzle ORM and Turso     |
| `stripe-integration`            | `backend`      | Stripe payments + billing: idempotency, webhooks, PCI |
| `turso-sqlite`                  | `backend`      | Rules for Turso edge database interactions            |
| `astro`                         | `frontend`     | Astro hydration, rendering, and routing rules         |
| `astro-react-island-strategist` | `frontend`     | Maintains Astro/React island hydration boundaries     |
| `expo-react-native-developer`   | `frontend`     | Prevents DOM elements in React Native code            |
| `google-analytics-v4`           | `frontend`     | Secure event logging for GA4                          |
| `tailwind-v4`                   | `frontend`     | Ensures strict Tailwind v4 class usage                |
| `audit-accessibility`           | `qa`           | WCAG automated scanning compliance                    |
| `gherkin-authoring`             | `qa`           | Business-readable `.feature` files, per-tag routing   |
| `playwright`                    | `qa`           | Rules for writing robust Playwright E2E tests         |
| `playwright-bdd`                | `qa`           | Binds Gherkin `.feature` files to Playwright steps    |
| `vitest`                        | `qa`           | Unit test automation with Vitest                      |
| `backend-security-patterns`     | `security`     | Clerk auth hardening + PII-safe telemetry/logging     |

> [!NOTE] The stack skill count (22) reflects skill directories containing a
> `SKILL.md` file; a few also include `examples/` or `scripts/` folders with
> companion context files.

---

## Workflows

Workflows are reusable slash commands for audits, Epic operations, and
repository maintenance.

### Audit Workflows

| Workflow                 | Slash Command          | Purpose                                     |
| ------------------------ | ---------------------- | ------------------------------------------- |
| `audit-accessibility.md` | `/audit-accessibility` | Lighthouse accessibility audit              |
| `audit-architecture.md`  | `/audit-architecture`  | Architecture and coupling review            |
| `audit-clean-code.md`    | `/audit-clean-code`    | Maintainability and technical debt analysis |
| `audit-dependencies.md`  | `/audit-dependencies`  | Dependency security and bloat audit         |
| `audit-devops.md`        | `/audit-devops`        | CI/CD and infrastructure review             |
| `audit-performance.md`   | `/audit-performance`   | Bottleneck and performance audit            |
| `audit-privacy.md`       | `/audit-privacy`       | PII and privacy compliance audit            |
| `audit-quality.md`       | `/audit-quality`       | Test coverage and quality review            |
| `audit-security.md`      | `/audit-security`      | Vulnerability and OWASP alignment           |
| `audit-seo.md`           | `/audit-seo`           | SEO and Generative Engine Optimization      |
| `audit-sre.md`           | `/audit-sre`           | Production release readiness audit          |
| `audit-ux-ui.md`         | `/audit-ux-ui`         | Design system consistency review            |

### Epic Workflows

| Workflow            | Slash Command                                                             | Purpose                                                                 |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `epic-plan.md`      | `/epic-plan`                                                              | PRD, Tech Spec, and task generation (PRD + decomposition phases).       |
| `epic-execute.md`   | `/epic-execute`                                                           | Owns the wave loop for an Epic; fans out via `/wave-execute`.           |
| `wave-execute.md`   | `/wave-execute`                                                           | Fans out Stories in a single wave via the Agent tool.                   |
| `story-execute.md`  | `/story-execute`                                                          | Init → Task loop → close for a single Story.                            |
| `epic-close.md`     | `/epic-close`                                                             | Final merge, tag release, close Epic (auto-invokes review + retro)      |

### QA Workflows

| Workflow            | Slash Command          | Purpose                                                       |
| ------------------- | ---------------------- | ------------------------------------------------------------- |
| `run-bdd-suite.md`  | `/run-bdd-suite [tag]` | Tag-filtered BDD acceptance run; collects Cucumber report     |

### Helper Modules (`workflows/helpers/`)

Helpers are path-included by parent workflows and are **not** exposed as
slash commands. They exist so the orchestrators (`/epic-plan`,
`/epic-close`, `/epic-execute`) stay readable while each phase stays
independently testable. Invoke them by running the parent workflow.

| Helper                           | Invoked by                                                  | Purpose                                                |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `epic-plan-spec.md`            | `/epic-plan` (Phase 1)                                       | PRD + Tech Spec authoring and persistence              |
| `epic-plan-decompose.md`       | `/epic-plan` (Phase 2)                                       | Feature / Story / Task decomposition                   |
| `epic-code-review.md`          | `/epic-close` Phase 3 · `/epic-execute` bookend             | Comprehensive code review, persists structured comment |
| `epic-retro.md`                | `/epic-close` Phase 6                                       | Retrospective from ticket graph + friction logs        |
| `epic-testing.md`              | `/epic-close` QA gate · operator                            | Ingests Cucumber evidence onto the epic-testing ticket |
| `_merge-conflict-template.md`    | `/epic-close`, `/story-execute`, `/git-merge-pr`            | Shared merge-conflict resolution procedure             |
| `agents-sync-config.md`          | `/agents-update` Step 3                                     | Reconcile `.agentrc.json` against the framework defaults |

### Utility Workflows

| Workflow                      | Slash Command              | Purpose                                   |
| ----------------------------- | -------------------------- | ----------------------------------------- |
| `agents-bootstrap-github.md`  | `/agents-bootstrap-github` | Initialize repo labels and project fields |
| `agents-update.md`            | `/agents-update`           | Bump `.agents/` pointer, reconcile `.agentrc.json`, regenerate `.claude/commands/` |
| `git-commit-all.md`           | `/git-commit-all`          | Stage and commit all changes              |
| `git-push.md`                 | `/git-push`                | Stage, commit, and push to remote         |
| `delete-epic-branches.md`     | `/delete-epic-branches`    | Hard reset: delete Epic branches          |
| `delete-epic-tickets.md`      | `/delete-epic-tickets`     | Hard reset: clear Epic child issues       |

---

## Orchestration Engine

### Provider Architecture

All ticketing operations are mediated through the `ITicketingProvider` abstract
interface. The framework ships with a **GitHub provider** using raw `fetch()`
(Node 20+) — no external SDK dependencies.

Execution operations (branch creation, script dispatch) are mediated through the
`IExecutionAdapter` interface, decoupling business logic from the shell.

#### Orchestration SDK (`scripts/lib/orchestration/`)

The SDK centralizes orchestration logic. All CLI scripts are **thin wrappers**
that delegate to it:

| Module                      | Exports                                         |
| --------------------------- | ----------------------------------------------- |
| `index.js`                  | Barrel — re-exports all SDK functions           |
| `dispatcher.js`             | `buildDAG`, `computeWave`, `resolveAndDispatch` |
| `context-hydrator.js`       | `hydrateContext`, `assemblePrompt`              |
| `ticketing.js`              | `transitionTicketState`, `cascadeCompletion`    |
| `dependency-analyzer.js`    | Cross-ticket dependency resolution              |
| `ticket-validator.js`       | Ticket structure and metadata validation        |
| `planning-state-manager.js` | Planning phase state tracking                   |
| `telemetry.js`              | Execution telemetry collection                  |

#### Entry Points

| Entry Point              | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `dispatcher.js`          | CLI wrapper — `node dispatcher.js --epic N [--dry-run]`        |
| `context-hydrator.js`    | CLI wrapper — `node context-hydrator.js --task N --epic N`     |
| `update-ticket-state.js` | CLI wrapper — `node update-ticket-state.js --task N --state S` |

#### Provider Layer

| Layer                 | File                                | Purpose                                   |
| --------------------- | ----------------------------------- | ----------------------------------------- |
| Abstract Interface    | `scripts/lib/ITicketingProvider.js` | Abstract ticketing contract               |
| Provider Factory      | `scripts/lib/provider-factory.js`   | Resolves `orchestration.provider` → class |
| GitHub Implementation | `scripts/providers/github.js`       | REST + GraphQL implementation for GitHub  |
| Config Resolver       | `scripts/lib/config-resolver.js`    | AJV schema validation + .env auto-loader  |

### Scripts Reference

| Script                               | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `agents-bootstrap-github.js`         | Idempotent setup of GitHub labels and project fields                    |
| `epic-planner.js`                    | Autonomous PRD and Tech Spec generation                                 |
| `ticket-decomposer.js`               | Recursive 4-tier hierarchy decomposition                                |
| `dispatcher.js`                      | CLI wrapper — DAG scheduler; outputs dispatch manifest                  |
| `context-hydrator.js`                | CLI wrapper — assembles self-contained agent prompts                    |
| `story-init.js`               | Initializes Story execution: branches, deps, state transitions          |
| `story-close.js`              | Finalizes Story: merges to Epic branch, cascades completions            |
| `epic-close.js`                    | Epic closure: doc freshness gate, version bump, tag release             |
| `epic-code-review.js`              | Automated code review execution                                         |
| `update-ticket-state.js`             | CLI wrapper — label-based state machine with cascade                    |
| `delete-epic.js`                     | Recursive issue deletion/clearing via GraphQL                           |
| `notify.js`                          | Operator notification (mentions + webhooks)                             |
| `lint-baseline.js`                   | Lint baseline ratchet — prevents new warnings                           |
| `check-maintainability.js`           | Maintainability score computation and baseline check                    |
| `update-maintainability-baseline.js` | Updates the maintainability baseline after improvements                 |
| `diagnose-friction.js`               | Analyzes friction logs for patterns                                     |
| `health-monitor.js`                  | Push-based Epic health monitoring                                       |
| `detect-merges.js`                   | Detects and reports merge conflicts                                     |
| `audit-orchestrator.js`              | Automated, gate-based static analysis and audit runner                  |
| `handle-approval.js`                 | CI webhook listener for `/approve` commands on audit findings           |

### Orchestration Configuration

Add the following block to your `.agentrc.json`:

```json
{
  "orchestration": {
    "provider": "github",
    "github": {
      "owner": "your-org",
      "repo": "your-repo",
      "projectNumber": null,
      "projectOwner": null,
      "operatorHandle": "@your-username"
    },
    "notifications": {
      "mentionOperator": true
    }
  }
}
```

| Field                           | Required | Description                                             |
| ------------------------------- | -------- | ------------------------------------------------------- |
| `provider`                      | Yes      | Provider name (`"github"` is the only shipped provider) |
| `github.owner`                  | Yes      | GitHub repository owner (user or org)                   |
| `github.repo`                   | Yes      | GitHub repository name                                  |
| `github.projectNumber`          | No       | GitHub Projects V2 number (for custom fields)           |
| `github.projectOwner`           | No       | Owner of the project board (defaults to `github.owner`) |
| `github.operatorHandle`         | No       | GitHub @mention handle for notifications                |
| `notifications.mentionOperator` | No       | Whether to @mention the operator in comments            |

The webhook URL for external delivery is **not** configured in `.agentrc.json`.
It is sourced from the `NOTIFICATION_WEBHOOK_URL` process env var only — set
it in `.env` locally, in the Claude Code web environment-variables UI for web
sessions, or as a repo secret via `ENV_FILE` for GitHub Actions runs. See
[**Secrets now live in `.env`**](#secrets-now-live-in-env) for the full key
list and the rationale.

---

## Authentication

The `GitHubProvider` resolves credentials in this priority order:

| Priority | Method                       | Environment               |
| -------- | ---------------------------- | ------------------------- |
| 1        | `GITHUB_TOKEN` or `GH_TOKEN` | CI/CD, background scripts |
| 2        | `gh auth token` (CLI)        | Local developer workflow  |

### Required Token Permissions

**Fine-grained PATs (recommended):**

- `GitHub Projects (V2)`: Read & Write
- `Issues`: Read & Write
- `Metadata`: Read-only
- `Pull requests`: Read & Write

**Classic PATs:** `repo` + `project` (full control).

### Configuration

1. **Background scripts**: Set `GITHUB_TOKEN` in your environment or `.env` file
   at the project root.
1. **Local CLI**: Run `gh auth login`.

---

## Concurrent close safety

`/wave-execute` may close multiple Stories into the same `epic/<epicId>`
branch in quick succession. The push step inside `story-close.js` retries on a
non-fast-forward rejection — fetch, replay the story merge on top of the new
remote tip, push again — bounded by `orchestration.closeRetry.maxAttempts`
(default 3) and `orchestration.closeRetry.backoffMs` (default
`[250, 500, 1000]`). A real content conflict (both stories touched the same
lines) aborts the loop with a clear error and leaves the local tree clean for
manual resolution.

---

## Guardrails

### Anti-Thrashing Protocol

Agents MUST halt, summarize blockers, and re-plan if they hit consecutive tool
errors or perform consecutive analysis steps without modifying a file.
Controlled by `limits.friction` in `.agentrc.json`.

### Lint Baseline Ratcheting

The lint baseline engine enforces zero-deterioration during Epic workflows.
Integrations fail if new lint warnings are introduced, and the baseline
automatically tightens when the codebase improves.

### Maintainability Ratchet

A per-file maintainability scoring engine computes composite scores based on
cyclomatic complexity, file length, and dependency counts. The
`baselines/maintainability.json` prevents score degradation between Epics.

### CRAP Gate (v5.22.0+) — Consumer Onboarding

A sibling per-method gate alongside the maintainability ratchet. CRAP scores
each JavaScript method via `c² · (1 − cov)³ + c`, combining
`typhonjs-escomplex` cyclomatic complexity with per-method coverage from the
`coverage/coverage-final.json` artifact your test runner already produces. No
new runtime dependencies. Runs at three sites: `close-validation` (story
close), `ci.yml` (push + PR), and `.husky/pre-push`.

If you're a consumer repo pulling the framework via the `dist` submodule,
this is what you need to know:

#### First-run behavior — bootstrap before the first push

As of Story #791 the gate is hard-enforcing across all three firing sites
(close-validation, pre-push, CI). With `crap.enabled: true` and no
`baselines/crap.json` on disk, `check-crap` prints:

```text
[CRAP] ❌ no baseline found — run 'npm run crap:update' and commit with a 'baseline-refresh:' subject to bootstrap
```

…and exits `1`. Bootstrap explicitly: run `npm run test:coverage` to produce
`coverage/coverage-final.json`, then `npm run crap:update` to generate
`baselines/crap.json`, and commit the file with a `baseline-refresh:` tagged
subject + non-empty body so the refresh-guardrail accepts it on the next PR.

The transitional informational mode (exit 0 on first sync) was retired in
Story #791 because it allowed broken pipelines to ride green for an
indeterminate window. If your test runner doesn't produce per-method
coverage, see "Disabling the gate" below.

#### Disabling the gate (single-flag opt-out)

If your repo doesn't run coverage, set `enabled: false` in your
`.agentrc.json`:

```jsonc
{
  "agentSettings": {
    "quality": {
      "crap": { "enabled": false }
    }
  }
}
```

All three gate sites self-skip with `[CRAP] gate skipped (disabled)` — no
source edits required. The maintainability ratchet keeps running.

#### Extending `targetDirs` without re-listing framework defaults

The config resolver supports deep-merge for list-valued keys. To add your
own source dirs to the framework default (`["src"]`):

```jsonc
{
  "agentSettings": {
    "quality": {
      "crap": {
        "targetDirs": { "append": ["packages/foo/src", "packages/bar/src"] }
      }
    }
  }
}
```

`{ "append": [...] }` and `{ "prepend": [...] }` are the deep-merge forms.
Passing a plain array replaces the default entirely — useful when you want
exactly your dirs and not the framework's. Unknown keys under
`quality.crap` warn but don't fail resolution, so you can extend
forward-compatibly.

#### Interpreting the `--json` artifact

`npm run crap:check -- --json temp/crap-report.json` (or the `crap-report`
artifact uploaded by the framework's `ci.yml`) writes:

```jsonc
{
  "kernelVersion": "1.0.0",       // Bumps when the CRAP formula changes.
  "escomplexVersion": "7.3.2",    // Bumps with the typhonjs-escomplex dep.
  "summary": {
    "total": 412,
    "regressions": 2,             // Tracked methods over baseline + tolerance.
    "newViolations": 1,           // New methods over `newMethodCeiling`.
    "drifted": 5,                 // Same method, shifted line — informational.
    "removed": 3,                 // Baseline rows absent from current scan.
    "skippedNoCoverage": 8        // Methods skipped under `requireCoverage`.
  },
  "violations": [
    {
      "file": ".agents/scripts/foo.js",
      "method": "doWork",
      "startLine": 42,
      "cyclomatic": 8,
      "coverage": 0.2,
      "crap": 45.3,
      "baseline": 18.0,
      "kind": "regression",
      "fixGuidance": {
        "crapCeiling": 18.0,
        "minComplexityAt100Cov": 4,             // floor(sqrt(target))
        "minCoverageAtCurrentComplexity": 0.74  // 1 − ((target − c) / c²)^(1/3)
      }
    }
  ]
}
```

Pick the cheaper axis from `fixGuidance` per offender:

- **`minComplexityAt100Cov`** — refactor the method down to ≤ this many
  branches and your existing coverage takes you under target.
- **`minCoverageAtCurrentComplexity`** — leave the structure alone and add
  tests until coverage reaches this fraction (`null` means unachievable at
  the current cyclomatic — refactor first).

The round-trip property: applying either single-axis fix re-scores the
method under target. Verified by unit test, so an agent can commit either
strategy without re-running the gate to check.

#### Refreshing the baseline (when the drift is justified)

`npm run crap:update` regenerates `baselines/crap.json`. The
`baseline-refresh-guardrail` CI job will reject your PR unless at least one
commit on the branch has:

1. A subject starting with the configured `refreshTag` (default
   `baseline-refresh:`).
2. A non-empty body explaining why the refresh is justified.

Both conditions are required. The tag alone without justification is not
enough. Baseline-only PRs additionally receive the `review::baseline-refresh`
label automatically — that's intentional, so a human reviewer sees every
refresh on top of green CI.

### HITL Blocker Escalation

`risk::high` is informational/planning metadata only. Runtime execution does not
pause automatically on `risk::high`.

The sole runtime HITL pause point is `agent::blocked`: when an agent encounters
an unresolvable blocker (including unsafe destructive actions lacking explicit
authorization), it flips the ticket/Epic to `agent::blocked`, posts friction
context, and waits for operator resume (`agent::executing`).

`agentSettings.riskGates.heuristics` remains the rubric for identifying
high-impact operations that should trigger blocker escalation.

### Friction Telemetry

Friction events (repetitive commands, consecutive errors, stagnation) are logged
as structured comments on the Task issue for post-hoc analysis.

---

## Git Performance (Windows)

### Global Settings (Run Once)

```bash
git config --global core.fsmonitor true
git config --global feature.manyFiles true
```

### Per-Repository Maintenance

```bash
git maintenance start
```

---

## Error-Handling Convention

All scripts under `.agents/scripts/` follow a single posture for reporting
failures. Matching the convention keeps operator output predictable and avoids
the "silent downgrade" bugs called out in the clean-code audit.

| Severity | Emitter                | When to use                                                                                  |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| debug    | `Logger.debug(msg)`    | Verbose trace. Only printed when `AGENT_LOG_LEVEL=verbose`. Safe for noisy cleanup paths.    |
| info     | `Logger.info(msg)`     | Normal progress line; equivalent to `console.log`. Use the `progress` helper in scripts.     |
| warn     | `Logger.warn(msg)`     | Recoverable issue the operator should notice but does not need to act on immediately.        |
| error    | `Logger.error(msg)`    | Non-fatal failure: the current phase aborts but the script continues with degraded output.   |
| throw    | `throw new Error(...)` | Task-level unrecoverable error. Caller decides whether it is fatal.                          |
| fatal    | `Logger.fatal(msg)`    | Unrecoverable; exits the process with code 1. Use **only** at CLI boundaries, never in libs. |

Rules of thumb:

- Prefer `throw` inside library code (`.agents/scripts/lib/`). Let the CLI entry
  point decide whether to fatal or continue.
- `Logger.fatal` exists exactly once per script — at the CLI boundary via
  `runAsCli`'s error handler. If you are calling it from anywhere else, you are
  probably hiding a `throw`.
- Empty `catch {}` is a bug in 99% of cases. Either log at the right level or
  add a one-line comment explaining why silence is correct (e.g. "deletion is
  idempotent, file may not exist").
- `console.error` is reserved for paths that run before `Logger` is available
  (e.g. pre-config-resolve bootstrap).

See `.agents/scripts/lib/Logger.js` for the implementation. The log level is
resolved from `AGENT_LOG_LEVEL` and accepts `silent`, `info` (default), or
`verbose` (`debug` is an alias for `verbose`).
