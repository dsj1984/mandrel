# Mandrel

[![CI / CD](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml)

An opinionated workflow framework for AI coding assistants built on
Epic-centric GitHub orchestration. Planning, execution, and state all live
natively in GitHub Issues, Labels, and Projects V2.

## Prerequisites

- **Node.js** >= 22.22.1 (< 25).
- **GitHub CLI `gh`** >= 2.40 — run `gh auth login` once so orchestration
  scripts pick up your token from the OS keychain.

## Get Started

```bash
git submodule add -b dist https://github.com/dsj1984/mandrel.git .agents
node .agents/scripts/bootstrap.js
# in your agentic IDE:
/epic-plan          # ideation -> PRD/Tech Spec -> 4-tier ticket hierarchy
/epic-deliver <id>  # wave loop -> validation -> review -> retro -> open PR
```

`bootstrap.js` is interactive on a TTY (auto-detects owner/repo/base
branch from `git remote`); pass `--owner`, `--repo`, and `--assume-yes`
for CI/scripted installs. It is idempotent — safe to re-run anytime.

## Documentation

- [`.agents/README.md`](.agents/README.md) — consumer reference and layout.
- [`.agents/SDLC.md`](.agents/SDLC.md) — end-to-end workflow narrative.
- [`docs/architecture.md`](docs/architecture.md) — module map, state
  machine, and tech stack.
- [`docs/configuration.md`](docs/configuration.md) — every `.agentrc.json`
  key explained.
- [`docs/workflows.md`](docs/workflows.md) — slash-command index.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — release history.

## License

ISC

---

## Reference

### Repository layout

```text
mandrel/
├── .agents/                  # Distributed bundle (the "product")
│   ├── instructions.md       # Primary system prompt
│   ├── personas/             # Role-specific behaviour
│   ├── rules/                # Domain-agnostic standards
│   ├── skills/               # core/ (universal) + stack/ (tech-specific)
│   ├── workflows/            # Slash-command automation
│   ├── scripts/              # Orchestration engine (lib + providers)
│   └── schemas/              # JSON Schemas
├── docs/                     # Reference docs and changelog
├── tests/                    # Framework tests
└── package.json
```

Only `.agents/` is distributed to consumers via the `dist` branch.

### Install scripts are disabled by default

The repo ships a committed [`.npmrc`](.npmrc) that sets
`ignore-scripts=true`, so `npm install` / `npm ci` will not execute
`preinstall` / `install` / `postinstall` hooks from any dependency — a
defense-in-depth measure against malicious lifecycle scripts in
typo-squatted or compromised transitive packages (CWE-1357). CI passes
`--ignore-scripts` explicitly. If a contributor knowingly needs install
scripts for a specific install, run `npm install --ignore-scripts=false`
for that invocation only.

### Stabilized quality gates

CRAP and Maintainability gates fire at every checkpoint (keystroke,
pre-commit, pre-push, story-close, CI, Epic merge) against the same
thresholds from `delivery.quality.*` in `.agentrc.json`. Downstream
projects pull the surface in via the `/agents-update` workflow.

### Development

```bash
npm run lint           # markdown + biome
npm run format         # auto-format
npm test               # framework tests
npm run test:coverage  # tests with coverage gate
```

### Release process

Releases are automated by `release-please`. Land Conventional Commits on
`main`; release-please opens a `chore(main): release X.Y.Z` PR that
squash-merges itself once CI is green. See the **Contribution Workflow**
section in [`AGENTS.md`](AGENTS.md) for PAT setup and major-version
policy.
