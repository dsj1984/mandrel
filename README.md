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

## Stabilized quality gates

Epic #1386 stabilized the CRAP and Maintainability gates against drift by
combining four reinforcing mechanisms with a coding-time tooling layer.
Net effect: the same engines (`check-maintainability.js`,
`check-crap.js`) now defend the same thresholds at every firing site —
keystroke, pre-commit, pre-push, story-close, CI, and Epic merge — and
read from the same `agentSettings.quality.*` config so a project tunes
once and the entire pipeline tracks the change.

The user-visible surfaces:

- **Diff-scoped defaults.** Both gate CLIs default `--changed-since=main`
  (or `origin/main` when present), so the gate scans only files in the
  current diff. Pass `--full-scope` for explicit full-repo runs (used by
  baseline-refresh and the empirical noise study).
- **Per-Epic baseline snapshots.** `/epic-plan` Phase 1 forks
  `baselines/{maintainability,crap}.json` into the
  `baselines/epic/<id>/` subdirectory and commits them to the Epic
  branch. `story-close.js` and CI then read from that snapshot via
  `--epic-ref epic/<id>`, so Stories under an Epic are immune to
  unrelated drift on `main`. `/epic-deliver`'s merge step refreshes
  `main`'s baselines from the merged tree as a single
  `baseline-refresh: epic-<id>` commit.
- **Bounded auto-refresh at story-close.** After green tests,
  `story-close.js` regenerates baseline rows for files in the Story diff
  and amends them into the close commit — but refuses (and emits a
  `baseline-refresh-regression` friction signal) when any file's MI
  would drop more than `agentSettings.quality.autoRefresh.miDropCap`
  (default 1.5pt) or any method's CRAP would jump more than
  `agentSettings.quality.autoRefresh.crapJumpCap` (default 5).
- **Coding-time tooling.**
  [`npm run quality:preview`](package.json) wraps both gates with
  `--changed-since HEAD` and prints a per-file delta table; the
  matching [`npm run quality:watch`](package.json) wraps it in a
  chokidar watcher; and the framework's
  [`.husky/pre-commit`](.husky/pre-commit) hook runs the same script
  with `--staged` so MI/CRAP drift surfaces at commit time rather than
  at the close-validation chain.
- **Coding guardrails helper.**
  [`.agents/workflows/helpers/code-quality-guardrails.md`](.agents/workflows/helpers/code-quality-guardrails.md)
  is the single source of truth for the coding-time numeric rules
  (cyclomatic > 8 = flag, > 12 = must-fix; MI drop > 1.5 = refactor;
  rename = baseline-refresh). Every workflow that cites a threshold
  links here so the numbers stay in lockstep.

The empirical evidence supporting the re-tuned thresholds lives in
`docs/noise-study-*.md` (one report per re-run); the threshold values
themselves live under `agentSettings.quality.codingGuardrails`,
`agentSettings.quality.autoRefresh`,
`agentSettings.quality.maintainability`, and
`agentSettings.quality.crap` in
[`.agents/default-agentrc.json`](.agents/default-agentrc.json).

### For downstream projects

Existing projects pick up the entire stabilized-gates surface area
through one invocation of the framework's update workflow:

```bash
node .agents/scripts/update-self.js
# then in your agentic IDE:
/agents-update
```

The [`/agents-update`](.agents/workflows/agents-update.md) workflow is
idempotent. On a project that lacks any of the new artefacts it will:

1. Install the
   [`code-quality-guardrails.md`](.agents/workflows/helpers/code-quality-guardrails.md)
   helper under `.agents/workflows/helpers/` (no-op when `.agents/` is
   consumed as a submodule).
2. Register the `.husky/pre-commit` hook with the diff-scoped
   `quality:preview` invocation. **Custom hooks are preserved** — the
   workflow detects a non-framework hook, leaves it untouched, and
   prints a notice with the snippet to merge in by hand.
3. Backfill the `quality:preview` and `quality:watch` npm scripts in
   `package.json` (only when the keys are absent).
4. Seed `agentSettings.quality.codingGuardrails` and
   `agentSettings.quality.autoRefresh` defaults in `.agentrc.json` —
   again only filling missing keys, never clobbering operator
   overrides.
5. Migrate any pre-existing `baselines/` layout into the
   `baselines/epic/` subdirectory contract used by the per-Epic
   snapshot lifecycle.

A project that re-runs `/agents-update` immediately after a successful
upgrade sees `no-change` on every step.

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
