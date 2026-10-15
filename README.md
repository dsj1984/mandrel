# Mandrel

[![CI / CD](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dsj1984/mandrel/actions/workflows/ci.yml)

**Mandrel gives your AI coding assistant a disciplined software process.**
Out of the box, an assistant like Claude Code will happily write code, but it
has no shared idea of how work gets planned, verified, reviewed, and shipped.
Mandrel supplies that: a system prompt, rules, skills, and slash-command
workflows that turn "build me X" into a planned GitHub Story, an isolated
branch, a tested change, and a reviewed pull request that merges itself once
CI is green.

It is **Claude Code-first** and **GitHub-native**: planning, execution state,
and history all live in GitHub Issues, Labels, Pull Requests, and Projects V2,
so there is no extra service to run and every step leaves a visible record.

Mandrel ships as the [`mandrel`](https://www.npmjs.com/package/mandrel) npm
package. `mandrel sync` copies its payload into your project's `.agents/`
directory, where your assistant reads it.

## What's in `.agents/`

| Path | What it is |
| ---- | ---------- |
| `instructions.md` | The always-loaded system prompt — the assistant's core operating protocol. |
| `rules/` | Non-negotiable standards. A small core (security baseline, git conventions) is always on; the rest (testing, API, CI remediation, Gherkin) load when the work calls for them. |
| `skills/` | Focused guidance loaded on demand: `core/` for universal practice (code review, security, documentation, quality gates), `stack/` for specific tools (Playwright, Gherkin, the QA harness). |
| `workflows/` | The slash commands — `/mandrel-plan`, `/mandrel-deliver`, the `/audit-*` lenses, QA, and housekeeping. Projected into `.claude/commands/`. |
| `agents/` | Role-scoped sub-agent contexts (story worker, auditor, critics). Projected into `.claude/agents/`. |
| `scripts/` | Deterministic Node.js CLIs that do the mechanical work — GitHub state changes, worktrees, quality gates — so the model judges and the scripts execute. |
| `schemas/`, `templates/` | JSON Schema contracts and the prompt/planning templates the workflows fill in. |
| `docs/` | Consumer reference: [configuration](.agents/docs/configuration.md) (every `.agentrc.json` key), the [workflow index](.agents/docs/workflows.md), and operator runbooks. |
| `audit-checklists/` | Generated per-lens authoring checklists, threaded into a Story's write-time checklist when its change set matches an audit lens. |
| `mods/` | Beta, opt-in Claude Code mods — see the [mods runbook](.agents/docs/runbooks/mods.md). |
| `local/` | Yours. `mandrel sync` never touches it, so project-specific skills and workflow fragments survive upgrades. |

Project settings live in `.agentrc.json` at your repo root. The table above is
a partial list (it omits single files such as `starter-agentrc.json`); the full
tour of the bundle is in [`.agents/README.md`](.agents/README.md).

## The core loop: plan, then deliver

Two commands carry almost all of the work.

### `/mandrel-plan`

[`/mandrel-plan`](.agents/workflows/mandrel-plan.md) turns an idea into a
ready-to-execute GitHub Story. There are no flags to remember — it works out
what you meant from what you typed and tells you what it inferred:

```text
/mandrel-plan let users export their reports as CSV   # plan from a description
/mandrel-plan 4712                                    # plan an existing issue
```

It gathers context from your repo, then authors a Story whose `## Spec` holds
the technical plan and whose `acceptance[]` / `verify[]` lists are the contract
the delivery is held to. It writes **one Story by default**, splitting only when
the pieces are truly independent; larger efforts can be grouped under a
container Epic.

### `/mandrel-deliver`

[`/mandrel-deliver`](.agents/workflows/mandrel-deliver.md) lands the work:

```text
/mandrel-deliver 4712                    # a single Story
/mandrel-deliver 4700                    # an Epic — delivers its open child Stories
/mandrel-deliver 4712 - 4716             # a range of Stories
/mandrel-deliver fix the typo in the login page header   # direct text, no plan
```

Each Story gets its own `story-<id>` branch in an isolated worktree; the
assistant implements it, checks its work against the acceptance criteria, runs
the test suite and quality gates, opens a PR, gets it reviewed, and arms
auto-merge. Multiple Stories are sequenced by their dependencies, with
independent ones running in parallel sub-agents. Direct text is for small,
unplanned work: it authors a receipt Story on the fly and escalates to
`/mandrel-plan` if the work turns out bigger than it looked.

The full process — labels, state, review, troubleshooting — is in
[`docs/SDLC.md`](docs/SDLC.md).

## Audits

The `/audit-*` workflows are read-only lenses that examine the codebase along
one dimension and write a findings report (severity, location, recommendation,
acceptance signal) under `temp/audits/audit-results/`. They never change code — fixing is a
separate, planned pass.

| Area | Lenses |
| ---- | ------ |
| Code & design | `architecture`, `clean-code`, `adrs`, `data-model`, `documentation`, `exceptions` |
| Quality & ops | `quality`, `baselines`, `performance`, `devops`, `sre`, `dependencies` |
| Security & privacy | `security`, `privacy` |
| Product & UX | `ux-ui`, `accessibility`, `mobile`, `navigability`, `seo` |

Run one manually (e.g. `/audit-security`) for a codebase-wide pass, then run
**`/audit-to-stories`** to group the findings, deduplicate them against open
issues, and turn them into Stories — feeding them back into
`/mandrel-plan` → `/mandrel-deliver`. Multi-Story deliveries can also run the
relevant cross-cutting lenses over the combined change when they finish.

Other workflows cover QA (`/qa-explore`, `/qa-assist`, `/qa-run`), UI
prototyping (`/prototype`), ad-hoc commits (`/git-deliver`), and housekeeping
(`/clean-git`, `/clean-worktrees`, `/clean-temp`). See the
[workflow index](.agents/docs/workflows.md) for the full list.

## Getting started

### Prerequisites

- **Node.js** `>=22.22.1 <25`
- **`git`** on your `PATH`
- **GitHub CLI `gh`** `>= 2.40`, authenticated with `gh auth login`. To let
  bootstrap create a Projects V2 board, also grant the `project` scope with
  `gh auth refresh -s project`; without it, bootstrap warns and skips the board.

You do **not** need an existing git repo or GitHub remote — bootstrap creates
both if they're missing.

### Install

```bash
npx mandrel init
```

This installs `mandrel` (if `.agents/` is absent), materializes `.agents/`, and
asks whether to **configure now** or stop at **just the files**. Configuring
runs `bootstrap.js` — which seeds `.agentrc.json`, wires the system prompt, and
provisions the GitHub side (repo, labels, branch protection, board) — then
detects your stack, offers to scaffold docs, runs `mandrel doctor`, and hands
you off to `/mandrel-plan`. Use `--assume-yes` for a non-interactive run.

Bootstrap infers owner, repo, base branch, and operator handle from your git
remote and config, prompting only for what it can't infer. Override with
`--owner`, `--repo`, `--base-branch`, `--operator-handle`, or
`--visibility private|public|internal` for a newly created repo. It is
idempotent — safe to re-run.

<details>
<summary>Manual install</summary>

```bash
npm install mandrel                 # pins an exact, provenance-signed version
npx mandrel sync                    # materialize ./.agents/ (postinstall usually does this)
node .agents/scripts/bootstrap.js   # wire the project and GitHub
npx mandrel doctor                  # verify the install
```

Bootstrap adds a guarded `prepare` script that regenerates `.claude/commands/`
and `.claude/agents/` from `.agents/`. Both are generated and gitignored —
never commit them.

</details>

> **pnpm users:** the `.agents/scripts/` CLIs resolve their dependencies from
> your top-level `node_modules`, which pnpm's isolated layout doesn't populate.
> Add `shamefully-hoist=true` to `.npmrc` (or a `public-hoist-pattern[]=` line
> per package in `.agents/runtime-deps.json`). If `mandrel doctor` reports
> `runtime-deps missing`, this is the fix.

### Updating

Inside Claude Code, run:

```text
/mandrel-update
```

It upgrades to the newest published `mandrel`, re-syncs `.agents/`, applies
migrations, checks the install, and walks you through reconciling your config
and committing the bump.

## Contributing

Only `.agents/`, `bin/`, `lib/`, and `docs/CHANGELOG.md` are published (see the
`files` array in [`package.json`](package.json)); everything else here is
development tooling for Mandrel itself.

```bash
npm run lint           # biome + markdownlint + repo ratchets + generated-doc drift
npm run format         # biome format (JS/JSON only)
npm test               # framework tests
npm run test:coverage  # tests with the coverage gate
```

A few things to know:

- **Quality gates are blocking at four sites** — pre-commit (staged files),
  pre-push (diff vs `origin/main`), Story close, and CI — using the CRAP and
  maintainability thresholds in `delivery.quality.*`. A green `lint`/`test` run
  does not predict them.
- **Install scripts are off** — the committed [`.npmrc`](.npmrc) sets
  `ignore-scripts=true` as supply-chain defense. Use
  `npm install --ignore-scripts=false` for a one-off exception.
- **Releases are automated** by release-please from Conventional Commits on
  `main`.

Further reading: [`AGENTS.md`](AGENTS.md) (repo orientation),
[`docs/onboarding.md`](docs/onboarding.md) (layout, commands, standards),
[`docs/architecture.md`](docs/architecture.md) (module map, tech stack),
[`docs/release-operations.md`](docs/release-operations.md), and
[`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## License

MIT
