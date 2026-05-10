# Agent Protocols 🤖

A structured framework of instructions, personas, skills, and SDLC workflows
that govern AI coding assistants built on **Epic-Centric GitHub Orchestration**
— all planning, execution, and state management lives natively in GitHub Issues,
Labels, and Projects V2.

**Current version:** see [`.agents/VERSION`](.agents/VERSION). Release notes
live in [`docs/CHANGELOG.md`](docs/CHANGELOG.md); v1.0.0 – v4.7.2 history is in
[`docs/archive/CHANGELOG-v4.md`](docs/archive/CHANGELOG-v4.md).

## Highlights

- **GitHub as SSOT** — Issues, Labels, and Projects V2 are the single source
  of truth. No local playbooks or per-iteration files.
- **Two-command SDL critical path** — `/epic-plan` generates PRDs, Tech
  Specs, and the full 4-tier ticket hierarchy (with optional ideation
  entry from a raw idea). `/epic-deliver` drives the wave loop, runs
  close-validation, fires the retro, and opens a pull request to `main`
  — the operator merges through the GitHub UI. There is no in-script
  merge to `main`.
- **Single-session fan-out** — Stories run in parallel via Agent-tool
  sub-agents inside the operator's Claude session, with per-story `git
  worktree` filesystem isolation.
- **Gate-based quality** — Lint, test, typecheck, MI, and CRAP gates wired
  into close-validation, CI, and pre-push with base-branch-enforced
  baselines.
- **Performance-signal telemetry** (Epic #1030) — runtime events stream into
  per-Story `signals.ndjson` and roll up into a Story-level
  `story-perf-summary` and an Epic-level `epic-perf-report` consumed by the
  retro. Tickets carry decisions and summaries; NDJSON carries events.
- **Bounded concurrency & module hygiene** (Epic #1072) — previously
  unbounded GitHub-mutation and fs-scan loops now flow through
  `concurrentMap` at story-specific caps; the HTTP client lives under
  `providers/github/`; a canonical `branch-name-guard` replaces two
  duplicate implementations; and `.agents/scripts/README.md` indexes every
  top-level CLI.
- **Close-time reliability hardening** (Epic #1114) — close-validation
  gates run inside the per-Story worktree (baselines resolve at the Epic
  ref, not the main checkout); `WorktreeManager.isSafeToRemove` uses a
  real `git merge-base --is-ancestor` reachability check; baseline
  refreshes now attribute to the Story whose diff caused them and block
  on non-attributable drift; and the `analyze-execution` analyzer is
  finally wired into both the post-merge pipeline and the Epic-deliver
  retro phase.

For the full architecture (mermaid flow, module map, state machine, tech
stack), see [`docs/architecture.md`](docs/architecture.md).

## Get Started

Five commands take you from zero to a planned, delivered Epic:

```powershell
git submodule add -b dist https://github.com/dsj1984/agent-protocols.git .agents
node .agents/scripts/agents-bootstrap-github.js --install-workflows
cp .agents/default-agentrc.json .agentrc.json   # then fill in orchestration.github
# in your agentic IDE:
/epic-plan          # ideation entry — sharpen idea, create the Epic, decompose
/epic-deliver <id>  # wave loop → validation → review → retro → open PR to main
```

Set `GITHUB_TOKEN` (or `GH_TOKEN`) in `.env` at the project root so the
orchestration scripts can authenticate.

The full configuration reference is in
[`docs/configuration.md`](docs/configuration.md); the static JSON Schema at
`.agents/schemas/agentrc.schema.json` powers editor autocomplete. See
[`.agents/SDLC.md`](.agents/SDLC.md) for the end-to-end workflow narrative
and [`docs/workflows.md`](docs/workflows.md) for the slash-command index.

---

## Repository Structure

```text
agent-protocols/
├── .agents/                  # Distributed bundle (the "product")
│   ├── VERSION
│   ├── instructions.md       # Primary system prompt
│   ├── SDLC.md               # End-to-end workflow guide
│   ├── README.md             # Detailed consumer reference
│   ├── personas/             # Role-specific behaviour (12)
│   ├── rules/                # Domain-agnostic standards (8)
│   ├── skills/
│   │   ├── core/             # Universal process skills (20)
│   │   └── stack/            # Tech-stack guardrails (5 categories)
│   ├── workflows/            # Slash-command automation
│   ├── scripts/              # Orchestration engine (lib + providers)
│   ├── schemas/              # JSON Schemas
│   └── templates/            # Context hydration templates
├── docs/                     # Reference docs, changelog, archive
├── tests/                    # Unit and integration tests
└── package.json
```

Counts above are advisory — the directories are authoritative. See
[`.agents/README.md`](.agents/README.md) for the consumer-facing layout
reference.

## Development

```powershell
npm run lint           # Markdown lint
npm run format         # Auto-format markdown
npm test               # Framework tests
npm run test:coverage  # Tests with 85% coverage gate
```

## Documentation

[`.agents/README.md`](.agents/README.md) has the canonical "where to look"
pointer table. Quick links: [SDLC.md](.agents/SDLC.md) ·
[architecture.md](docs/architecture.md) ·
[configuration.md](docs/configuration.md) ·
[workflows.md](docs/workflows.md) · [CHANGELOG.md](docs/CHANGELOG.md).

## License

ISC
