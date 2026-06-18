# Mandrel Framework

An opinionated workflow framework for AI coding assistants built on
Epic-centric GitHub orchestration. Planning, execution, and state all live natively in GitHub Issues, Labels, and Projects V2.

This is the consumer README inside the distributed `.agents/` bundle. It explains what each part of the bundle is for and captures the cross-directory authoring conventions. The process narrative for
`/plan` and `/deliver` stays in [`docs/SDLC.md`](docs/SDLC.md).

The framework payload (`.agents/`) is consumed by host repos. It ships inside the [`mandrel`](https://www.npmjs.com/package/mandrel)
npm package and is materialized into a consumer's `./.agents/` directory by `mandrel sync`. It carries a system prompt, a baseline rule pack, a two-tier skill library, a slash-command workflow set, and the orchestration engine that runs Epic → Story plans on GitHub.

The framework version is the version of the installed [`mandrel`](https://www.npmjs.com/package/mandrel) npm package — run `npm ls mandrel` (or read `package.json`), not a
count here.

---

## Activation

### All-in-one Install

From an **empty or existing** local directory, run:

```bash
npx mandrel init        # install (if absent) → prompt: configure now, or just the files
```

`mandrel init` first **installs the framework if `./.agents/` is absent** —
`npm install mandrel --ignore-scripts` followed by an explicit `mandrel sync`,
so the materialization is a single deterministic step rather than a
postinstall-then-init double sync. When `./.agents/` already exists from a prior install, it skips straight to the prompt — the one subcommand is idempotent across both entry points.

It then shows a **two-option prompt**:

1. **Configure now** — runs `node .agents/scripts/bootstrap.js`, forwarding any
   passthrough flags unchanged, to wire the project and GitHub side (creates the
   GitHub repo; board decoration and Issue Forms are opt-in — see below).
2. **Just the files** — stops after materialization and prints a re-run hint
   (`mandrel init`) so you can configure later.

`--assume-yes` skips the prompt and configures non-interactively (the flag is
also forwarded to `bootstrap.js`); a non-TTY run without `--assume-yes` defaults
to **files-only**, so the side-effecting GitHub provisioning never runs
unattended.

After it completes, `mandrel init` runs the onboarding tail automatically —
stack detection, docs scaffolding offer, a `mandrel doctor` readiness gate,
and a printed `/plan` handoff — so you land at planning in one command.

### Manual Install

This section documents the manual steps `mandrel init` wraps, for operators who prefer to drive them by hand.

#### Mandrel Package

From an **empty or existing** project that does not yet have `.agents/`,
install the package and materialize the framework payload:

```bash
npm install mandrel
```

Installing `mandrel` pins an exact, provenance-signed version in
your lockfile (the npm publish attaches a Sigstore build-provenance
statement proving the tarball was built from this repo's CI). The package's
`postinstall` hook runs `mandrel sync` best-effort, which copies the
package's `.agents/` payload into your project's `./.agents/` directory as
plain regular files (never a symlink). If lifecycle scripts are skipped
(`--ignore-scripts`, sandboxed CI), run it yourself:

```bash
npx mandrel sync           # materialize ./.agents/ (idempotent, copy-only)
npx mandrel sync --dry-run # preview the planned copies, write nothing
npx mandrel doctor         # confirm the install is healthy
```

#### Bootstrap Config

To wire the local directory and GitHub, run `npx mandrel init` again or use the bootstrapper directly: `node .agents/scripts/bootstrap.js`

The bootstrap pipeline, in order:

1. **Preflight gate (runs first, before any mutation).** A single
   fail-before-mutate check confirms Node is at the required major
   version, `git` is on `PATH`, the command is running inside a git work
   tree, and — unless `--skip-github` is set — that the `gh` CLI is
   installed and authenticated. If any check fails the bootstrap prints
   each failing check's remedy and halts with exit 1 **before** touching
   a single file or making a GitHub call, so a half-configured repo is
   never left behind.
2. **Resolve answers (owner / repo / base branch / operator handle /
   project number).** Defaults are inferred from the local `git remote`
   and config (no network calls). Each value is resolved through a
   priority chain: CLI flag → environment variable
   (`GH_OWNER`, `GH_REPO`, …) → silently-accepted inferred default →
   interactive picker → free-text prompt → `--assume-yes` default.
3. **Project-side mutations.** Seeds `.agentrc.json` from
   [`starter-agentrc.json`](starter-agentrc.json), merges the framework's
   runtime dependencies into `package.json`, runs the install, wires the
   command-sync hook (the UserPromptSubmit hook that regenerates the flat
   `.claude/commands/` tree so every `/<command>` loads), wires the system
   prompt (see below), gitignores derived artefacts, and runs the
   quality-gates installer.
4. **GitHub-side mutations.** Creates the label taxonomy, branch protection,
   and merge-method settings. Skipped with `--skip-github`. Two additional
   mutations are **opt-in** (prompted y/N, defaulting No, or passed as flags):
   - `--with-project-board` — provision the Projects V2 Status field and
     custom fields on an existing board.
   - `--with-issue-forms` — generate `.github/ISSUE_TEMPLATE/story.yml` and
     `epic.yml` from the ticket-body schema.

The bootstrap is idempotent — safe to re-run; an already-configured
clone produces zero file mutations.

---

## Upgrading and local additions

Once installed, the ongoing upgrade path is **`mandrel update`** — it bumps
`mandrel` to the newest published version, re-runs `mandrel sync`,
applies version-keyed migrations, and verifies the install with
`mandrel doctor`. The lockfile bump is left **staged for you to review and
commit** (the command performs no `git` mutation):

```bash
npx mandrel update           # update → sync → migrate → doctor
npx mandrel update --dry-run # preview the target version + ordered steps
```

Major crossings are applied like any other bump — Mandrel ships hard
cutovers, so the release notes in the surfaced changelog are the migration
guide. Migrations can also be run on their own:

```bash
npx mandrel migrate --from <version> --to <version> [--dry-run]
```

**Local additions survive upgrades only inside `.agents/local/`.** Because
`mandrel sync` overwrites `./.agents/` in place from the package payload,
hand edits to synced framework files are clobbered on the next upgrade — and
`mandrel doctor`'s drift check flags them. The **`.agents/local/`** zone is
the consumer-owned space `mandrel sync` never copies into nor prunes and the
drift check treats as sanctioned, so keep project-specific skills and local
workflow fragments there rather than editing synced files in place.

---

## CLI subcommand reference

Run `mandrel --help` for a subcommand list. Each subcommand supports
`--dry-run` (where noted) to preview without writing.

| Subcommand | Purpose | Key flags |
| ---------- | ------- | --------- |
| `init` | Install + configure mandrel in the current project (cold-start). | `--assume-yes`, `--skip-github`, `--dry-run` |
| `sync` | Re-materialize `.agents/` from the installed package payload. | `--dry-run` |
| `sync-commands` | Regenerate `.claude/commands/` from `.agents/workflows/`. | — |
| `doctor` | Run readiness checks and print per-check remedies. | — |
| `update` | Upgrade mandrel to the newest published version. | `--dry-run`, `--install-cmd` |
| `migrate` | Apply version-keyed migrations for a version range. | `--from`, `--to`, `--dry-run` |
| `explain` | Print resolved config values with their sources. | `--json` |
| `uninstall` | Reverse a recorded install using the install ledger. | `--include-github`, `--dry-run` |

### `mandrel explain`

Prints every resolved `.agentrc.json` config key — its effective value, the
source layer it came from (`[agentrc]` or `[default]`), and a one-line
meaning. Secret-shaped keys are redacted. Useful for debugging unexpected
behavior when multiple config sources overlap.

```bash
mandrel explain            # human-readable config report
mandrel explain --json     # same report as JSON
```

### `mandrel sync-commands`

Regenerates the flat `.claude/commands/` projection from `.agents/workflows/`.
The bootstrap wires a `UserPromptSubmit` hook that runs this automatically on
every Claude Code prompt submission, so manual runs are rarely needed.

```bash
mandrel sync-commands      # rebuild .claude/commands/
```

### `mandrel uninstall`

Reverses a recorded install using the install ledger
(`.agents/.install-manifest.json`). Each ledger entry is a
mutation-manifest record; uninstall walks reversible entries and undoes
exactly what the install applied, without touching pre-existing operator
content. GitHub-side state (labels, branch protection, project board fields)
requires manual reversal and is surfaced as a follow-up checklist.

```bash
mandrel uninstall                      # reverse all local install mutations
mandrel uninstall --dry-run            # preview what would be reversed
mandrel uninstall --include-github     # acknowledge GitHub-side manual steps
```

---

## Automatic system-prompt wiring

The bootstrap wires the framework system prompt into a project-root
`CLAUDE.md` automatically, so there is no manual "load the system prompt"
step. Claude Code hydrates its always-loaded context from `CLAUDE.md`,
and the wiring step (idempotent, keyed off the literal
`@.agents/instructions.md` import path) does one of three things:

- **No `CLAUDE.md`** → writes a minimal one carrying a `## System Prompt`
  heading and the `@.agents/instructions.md` import.
- **`CLAUDE.md` exists but lacks the import** → appends the import block.
- **`CLAUDE.md` already imports it** → no-op (no duplicate import line).

If your AI tool is not Claude Code, load
[`instructions.md`](instructions.md) verbatim through that tool's own
system-prompt mechanism (`.cursorrules`, Custom Instructions, etc.).

---

## Interactive repo / project pickers

When the bootstrap runs interactively (a TTY, and `--assume-yes` is not
set), the **repo** and **project-number** questions render a live,
numbered menu of real choices instead of a blank prompt:

- The **repo picker** lists the resolved owner's repositories via
  `gh repo list <owner>`.
- The **project picker** lists the owner's Projects V2 titles via
  `gh project list --owner <owner>`.

The pickers are interactive-only and never block: a `--owner`/`--repo`
flag, a `GH_OWNER`/`GH_REPO` environment variable, or `--assume-yes`
short-circuits the picker (the earlier resolvers win); a non-TTY run
skips it entirely. If the owner cannot be resolved, or `gh` is missing,
unauthenticated, too old, or returns nothing, the list comes back empty
and the prompt falls through to manual free-text entry — so a missing or
stale `gh` never breaks the run.

For non-interactive (CI) installs, pass `--owner`, `--repo`, and
`--assume-yes`; pass `--skip-github` to defer the remote half.

After bootstrap, every Mandrel command is generated into a flat
`.claude/commands/` tree by `npm run sync:commands` (the UserPromptSubmit hook
keeps it current) and loads as a bare `/<command>` slash command — e.g.
`/plan`, `/plan`, `/deliver`, `/audit-security`. The
commands load in every Claude Code environment. The [SDLC guide](docs/SDLC.md) walks
an end-to-end Epic; standalone Stories pair
[`/plan`](workflows/helpers/plan-story.md) (idea → drafted Story
Issue) with [`/deliver`](workflows/helpers/deliver-stories.md) (Story Issue → merged
PR).

---

## Runtime dependencies

The framework scripts under `.agents/scripts/` import a small set of
third-party npm packages at runtime. The materialized `./.agents/` tree
carries **no `node_modules` of its own** — `mandrel sync` copies only the
`.agents/` payload, so the scripts resolve their dependencies from the
**consuming repository's** install (Node walks `node_modules` upward from
the script's location to your repo root). The required set is enumerated in
a single vendored manifest that ships inside the bundle:

- **[`runtime-deps.json`](runtime-deps.json)** — the single source of
  truth. Its `dependencies` block lists the **required** packages (`ajv`,
  `ajv-formats`, `js-yaml`, `minimatch`, `picomatch`, `string-argv`,
  `typhonjs-escomplex`); its `optionalDependencies` block lists packages
  used behind graceful-degradation paths (`typescript` for TS-source
  scoring in the maintainability engine, `chokidar` for `quality:watch`,
  `@commitlint/load` for commit-subject sizing).

**How a consumer satisfies them:** `bootstrap` (above) merges the required
set into your `package.json` `dependencies` and runs your package manager's
install — so a freshly bootstrapped repo already has them. If you adopt
`.agents/` without the bootstrap, add the `runtime-deps.json` `dependencies`
to your own `package.json` (any compatible versions) and install.

**Fail-fast guard.** The dependency-dependent entry points
(`epic-plan-spec.js`, `epic-plan-decompose.js`, and the baseline scorers)
run a presence check on their required deps before doing any work. When the
install is missing, empty, or stale, they exit non-zero with an actionable
message naming the missing packages and your install command — instead of a
raw `ERR_MODULE_NOT_FOUND` deep inside a workflow. A drift test
(`tests/scripts/runtime-deps-drift.test.js`) keeps the manifest honest: it
fails if any third-party import under `.agents/scripts/**` is not declared
in `runtime-deps.json`.

---

## Ticket Hierarchy

Mandrel uses a **2-tier hierarchy** (Epic → Story) with inline `acceptance[]` / `verify[]` on story bodies.

See [`docs/SDLC.md` § Ticket hierarchy](docs/SDLC.md) for the diagram and execution-model implications.

---

## Contents

| Path | Purpose |
| ---- | ------- |
| [`instructions.md`](instructions.md) | Primary system prompt loaded by the host AI tool. |
| [`docs/SDLC.md`](docs/SDLC.md) | Operator process for `/plan` and `/deliver`. |
| [`starter-agentrc.json`](starter-agentrc.json) | Bootstrap delta-seed copied to the consumer repo root as `.agentrc.json`. |
| [`agentrc-reference.json`](docs/agentrc-reference.json) | Exhaustive editor reference enumerating every schema key with its framework default. |
| [`personas/`](personas/) | Role-specific behavior packs selected by task persona or explicit user instruction. |
| [`rules/`](rules/) | Domain-agnostic coding, security, testing, shell, git, and workflow rules. |
| [`skills/core/`](skills/core/) | Universal process skills such as debugging, TDD, security, documentation, and code review. |
| [`skills/stack/`](skills/stack/) | Stack-specific guardrails for frameworks, services, and testing tools. |
| [`workflows/`](workflows/) | Workflow definitions. Top-level files are projected into the flat `.claude/commands/` tree and invoked as `/<name>`. |
| [`workflows/helpers/`](workflows/helpers/) | Workflow fragments read by parent workflows; not exposed as commands. |
| [`scripts/`](scripts/) | Deterministic Node.js CLIs used by workflows and operators. |
| [`scripts/lib/orchestration/`](scripts/lib/orchestration/) | In-process orchestration SDK used by the CLI wrappers. |
| [`scripts/lib/checks/`](scripts/lib/checks/) | Discovery-based self-healing checks registry for preflight, the `diagnose.js` viewer, and retro surfaces. |
| [`schemas/`](schemas/) | JSON Schema contracts for config, manifests, reports, and persisted runtime artefacts. |
| [`templates/`](templates/) | Prompt and planning templates used by the orchestration flow. |

---

## Where to Look

| You want… | Open |
| --------- | ---- |
| The Epic planning and delivery process | [`docs/SDLC.md`](docs/SDLC.md) |
| The system prompt loaded by your AI tool | [`instructions.md`](instructions.md) |
| Every `.agentrc.json` key, default, and override | [`docs/configuration.md`](docs/configuration.md) (under `.agents/`) |
| Quality-gate runbooks (CRAP, MI, lint, friction) plus the baseline envelope, component model, and writer/reader contract | [`.agents/docs/quality-gates.md`](docs/quality-gates.md) |
| Slash-command workflow definitions | [`workflows/`](workflows/) |
| Render the signals span-tree (debug helper) | [`workflows/helpers/signals.md`](workflows/helpers/signals.md) |
| Persona behavior packs | [`personas/`](personas/) |
| Domain-agnostic baseline rules | [`rules/`](rules/) |
| Skill library (core process + stack guardrails) | [`skills/core/`](skills/core/) · [`skills/stack/`](skills/stack/) |
| Decision rule: should this be a Skill or a Script? | [§ When to use a Skill vs a Script](#when-to-use-a-skill-vs-a-script) |
| Workflow authoring conventions | [§ Workflow authoring](#workflow-authoring) |
| Orchestration SDK and GitHub authentication | [§ Orchestration SDK](#orchestration-sdk) |
| Check registry authoring rules | [§ Self-healing checks](#self-healing-checks) |
| JSON Schema conventions | [§ Schemas](#schemas) |
| Bootstrap script (project + GitHub setup) | [`scripts/bootstrap.js`](scripts/bootstrap.js) |
| Adopt the QA workflows (`/qa-explore`, `/qa-assist`, `/qa-run`) in your project | [§ Adopting the QA harness](#adopting-the-qa-harness) |
| Coordinate two operators on the same repo (lease model) | [§ Multi-developer coordination](#multi-developer-coordination) |

---

## When to use a Skill vs a Script

The framework ships two surfaces for automation under `.agents/`:

- **Scripts** under [`scripts/`](scripts/) — Node modules invoked via
  `node .agents/scripts/<name>.js`, typically wired into a slash command
  in [`workflows/`](workflows/).
- **Skills** under [`skills/core/`](skills/core/) and
  [`skills/stack/`](skills/stack/) — declarative `SKILL.md` packages with
  YAML front-matter (`name`, `description`, `allowed_tools`) that the host
  LLM dispatches directly from a slash command.

The decision between the two is **not** a matter of taste. Apply this
rule:

> **Deterministic + parseable output → keep it a script.** Examples:
> GitHub I/O, label transitions, JSON validators, NDJSON readers,
> diff-vs-baseline gates, template renderers.
>
> **Prompt + judgment → make it a Skill.** Examples: composing a PRD
> from an Epic body, classifying friction signals from a failed shell
> command, decomposing a Tech Spec into a ticket hierarchy.

The rule is two-sided on purpose. "Has an LLM step adjacent" is *not*
the signal — many deterministic scripts emit a JSON envelope that a host
LLM consumes downstream, and that does not turn the script into a Skill.
The signal is whether the *output of this unit* is the product of
judgment (Skill) or of a parseable transform (script).

### Worked example 1 — split: `epic-plan-decompose.js`

[`scripts/epic-plan-decompose.js`](scripts/epic-plan-decompose.js) is a
**split**: the deterministic halves stay as a script, the judgment middle
moves to a Skill.

- **`--emit-context`** (script half) — fetches the PRD and Tech Spec
  bodies, scrapes project docs, emits a JSON envelope. Parseable in,
  parseable out. Stays a script.
- **Authoring middle** (Skill half) — given the envelope, author the
  ticket hierarchy JSON. Pure prompt + judgment. Migrates to a Skill
  under `.agents/skills/core/` so it ships with declarative
  `allowed_tools` and a smoke test rather than bespoke prompt-template
  plumbing inside a Node module.
- **Persist half** (script half) — given the author-provided tickets
  JSON, validate against the schema, create GitHub issues, flip the Epic
  label. Deterministic GitHub I/O + schema validation. Stays a script.

The split codifies the "host LLM authors directly" pattern explicitly:
the prompt+judgment step gets a `description`, an
`allowed_tools` declaration, and a smoke test; the GitHub I/O around it
keeps its imperative implementation.

### Worked example 2 — pure script: `resync-status-column.js`

[`scripts/resync-status-column.js`](scripts/resync-status-column.js)
**stays a script** because every step is deterministic GitHub I/O.

- It derives the target Projects v2 Status column for a ticket,
  re-asserts it via a GraphQL mutation after auto-merge fires, and
  polls for drift so the orchestrator wins the race against GitHub's
  built-in merge bot.
- Input is the operator's CLI flags (`--ticket`, `--poll-attempts`,
  etc.) and the GitHub API; output is a single-line JSON envelope
  summarising the synced state.

The script's own input/output is deterministic and parseable: it does
not compose prompts, it does not classify, it does not author prose.
There is no judgment step adjacent to it — the verdict is "this is
the right shape" without any future Skill migration.

---

## Workflow Authoring

`workflows/` is the source of truth for the command surface exposed by
Claude Code in this repo. Each top-level `.md` file is projected into the
flat `.claude/commands/<name>.md` tree by
[`sync-claude-commands.js`](scripts/sync-claude-commands.js), so it is
invoked as `/<name>`. The flat projection has no plugin manifest and no
marketplace listing. Files under `workflows/helpers/` are path-included
modules read by parent workflows; they are not projected or exposed as
commands.

If you are looking for an end-user reference for an individual workflow,
read the workflow file itself. Every workflow is a self-contained
contract.

Every workflow begins with a flat YAML-ish frontmatter block delimited by
`---` lines. The parser in
[`frontmatter.js`](scripts/lib/audit-suite/frontmatter.js) reads a flat
key/value map; nested structures are not supported.

```yaml
---
description: <one-paragraph summary surfaced in the skill index>
---
```

`description` is recommended. Keep it under roughly 280 characters; the
audit-suite summary helpers truncate after three sentences. Missing
frontmatter falls back to the file's first prose paragraph.

Workflow frontmatter does **not** carry model identifiers. `Agent`
sub-dispatches inherit from the `general-purpose` sub-agent definition
unless a specific call in the workflow body passes a per-call `model:`
literal — that per-call override is the only supported way to pin a
sub-agent's model.

To add a workflow:

1. Drop a new `.md` file at the top level of `workflows/`.
2. Add frontmatter with at least `description`.
3. Run `npm run sync:commands` to project the file into the flat
   `.claude/commands/` tree; it surfaces as `/<name>`.

---

## Orchestration SDK

`scripts/lib/orchestration/` is the in-process orchestration SDK. Every
top-level CLI under `scripts/` should be a thin wrapper that parses argv,
resolves config, and delegates business logic to the SDK.

Provider operations are mediated through `ITicketingProvider`. The shipped
ticketing provider is GitHub, resolved by `provider-factory.js` from the
`orchestration.provider` config key. CLI scripts receive provider
instances from the SDK surface rather than importing provider
implementations directly. Execution is Claude-Code-in-session — there is
no separate adapter abstraction; `manifest-builder.js` synthesizes the
dispatch record inline and the dispatch manifest (md + structured
comment) is the cross-runtime contract.

The SDK barrel is `scripts/lib/orchestration/index.js`; its exports are
the source of truth for the public in-process surface. Key families
include dispatch (`dispatch-engine.js`, `manifest-builder.js`), context
hydration, planning state, label transitions, Epic runner phases,
Story-close internals, retro heuristics, and structured error capture.

### GitHub authentication

The GitHub provider resolves credentials in this order:

| Priority | Method | Environment |
| -------- | ------ | ----------- |
| 1 | `GITHUB_TOKEN` or `GH_TOKEN` | CI/CD and background scripts |
| 2 | `gh auth token` | Local developer workflow |

Fine-grained PATs should grant GitHub Projects V2 read/write, Issues
read/write, Metadata read-only, and Pull requests read/write. Classic
PATs need `repo` and `project`.

Set `GITHUB_TOKEN` in the process environment or in `.env` at the
project root; the resolver auto-loads `.env`. For local interactive
sessions, `gh auth login` is sufficient.

---

## Self-Healing Checks

`scripts/lib/checks/` is the discovery-based registry of named checks
consumed by preflight guards (`/deliver`, `/story-close`, `npm test`),
the `diagnose.js` ad-hoc viewer, and the retro surface. Use one check per
file. The runner (`index.js`) loads checks at process start and filters by
scope at each call site.

Each check module default-exports an object with this shape:

```js
export default {
  id: 'stale-origin-epic',
  severity: 'blocker', // 'blocker' | 'warning' | 'info'
  scope: ['epic-deliver', 'story-close', 'retro'],
  autoCorrect: 'refuse-and-print', // 'auto' | 'refuse-and-print'
  detect(state) {
    return null;
  },
  async fix(state) {
    return { ok: true, message: 'what was changed' };
  },
};
```

`detect(state)` returns a finding or `null`. Read git, filesystem, and
environment projections from the assembled `state`; do not re-probe the
environment inside the check. A finding includes `id`, `severity`,
`scope`, `summary`, optional `detail`, mandatory `fixCommand`, and
`autoCorrectable`.

`autoCorrect: 'auto'` means the fix is local, bounded, and reversible.
Auto-fixes must not push to remotes, commit to `epic/*` or `main`, amend
history, recursively delete outside `.worktrees/<id>/`, write GitHub
state, or read secret values. Anything requiring those operations must be
`refuse-and-print` with a human-run `fixCommand`.

The retro scope is read-only. `runChecks({ scope: 'retro', autoFix: true
})` is invalid, and retro-scoped checks should usually omit `fix()`.

Module boundary rules:

- Filenames match check ids in kebab-case.
- `index.js` and `state.js` are runner infrastructure and excluded from
  discovery.
- Checks do not import from other checks.
- Shared probes belong in `state.js`; pure formatting helpers may live in
  sibling helper modules.
- Checks do not keep module-level mutable state.

---

## Baselines

The framework's quality gates compare against per-kind baseline files
under `baselines/<kind>.json` (lint, coverage, crap, maintainability,
mutation, lighthouse, bundle-size). Every baseline shares a single
envelope, every gate reads through one shared module
([`.agents/scripts/lib/baselines/reader.js`](scripts/lib/baselines/reader.js)),
and every refresher writes through one shared writer
([`.agents/scripts/lib/baselines/writer.js`](scripts/lib/baselines/writer.js)).

See the [Baseline reference](docs/quality-gates.md#baseline-reference)
section of `.agents/docs/quality-gates.md` for the full reference: envelope shape,
per-kind axes, component model, path canonicalisation, writer/reader
contract, kernel-version friction, and — most relevant to consumers — the
**floor override** path. Consumers add a `floors` block
(and optional `components`) under their gate in `.agentrc.json`:

```json
{
  "delivery": {
    "quality": {
      "gates": {
        "coverage": {
          "floors": { "*": { "lines": 90, "branches": 85 } },
          "components": { "api": ["src/api/**"] }
        }
      }
    }
  }
}
```

The unified runtime gate
[`.agents/scripts/check-baselines.js`](scripts/check-baselines.js)
currently runs floor + tolerance + schema + kernel-mismatch checks only;
full regression absorption and per-kind CLI deletion are tracked in
follow-up **Epic #1943**.

---

## Schemas

`schemas/` contains JSON Schema draft 2020-12 contracts consumed by the
orchestration layer. Each schema describes one structured artefact:
configuration, structural Epic specs, runtime reports, dispatch
manifests, or persisted state. Where a runtime AJV schema also exists,
the JSON file is a mirror kept in sync by a drift test.

Important schema groups:

- Structural specs: `epic-spec.schema.json` for the declarative
  `epic.yaml` plus reconciler flow.
- Configuration: `agentrc.schema.json`, mirrored from the runtime config
  schemas.
- Runtime reports: audit results, CRAP and maintainability reports,
  performance summaries, friction and signal events, and validation
  evidence.
- Dispatch: `dispatch-manifest.json`, the per-Epic dispatch manifest
  schema written by `dispatcher.js`.

Schema conventions:

- `$schema` references draft 2020-12.
- `$id` is the canonical GitHub blob URL for the file.
- Every property carries a `description`.
- Objects use `additionalProperties: false` unless the contract
  explicitly needs an open extension point.
- Structural schemas do not model `agent::*` labels; wave-runner state is
  separate from structural intent.

---

## Code review providers (pluggable chain)

`runCodeReview()` (invoked at the end of `helpers/epic-deliver-story`,
`helpers/single-story-deliver`, and `/deliver`'s `delivery.code-review`
state) loads its review backend through a pluggable registry. Two configuration shapes are supported:

- **Legacy single provider** — `delivery.codeReview.provider: "native"`
  (default), `"codex"`, or `"security-review"`. Returns one adapter; one
  set of findings; one structured comment.
- **Provider chain** (Story #2871) — `delivery.codeReview.providers: []`
  iterates a declared list of entries, merges every inline adapter's
  `Finding[]` in declaration order, and appends a non-blocking
  "Manual Review Suggestions" section for any manual-prompt entries
  that contributed text. When both fields are set, `providers` wins.

```json
{
  "delivery": {
    "codeReview": {
      "providers": [
        { "name": "native" },
        { "name": "security-review", "scopes": ["epic"], "optional": true },
        {
          "name": "ultrareview",
          "scopes": ["epic"],
          "manualPrompt": true,
          "when": { "label": "risk::high" }
        }
      ]
    }
  }
}
```

Each chain entry accepts:

- `name` (required) — registered key. Inline: `native`, `codex`,
  `security-review`. Manual-prompt: `ultrareview`.
- `scopes` — invocation scopes this entry fires on (`["story", "epic"]`).
  Default is both.
- `optional` — when `true`, a construction failure (host missing the
  required CLI/plugin) is logged and the entry is skipped instead of
  hard-failing the chain. Use for portable configs that ship across
  Claude and non-Claude runtimes — for example,
  `security-review` requires the `claude` CLI on PATH and degrades
  cleanly on a non-Claude host when `optional: true`.
- `manualPrompt` — when `true`, the entry is loaded from the
  manual-prompt registry and contributes a one-line operator suggestion
  via `renderPrompt()` instead of running a real review. Manual-prompt
  contributions do NOT affect severity counts or the `halted` gate.
- `when` — optional label predicate evaluated at invocation time
  against the ticket's labels (`when.label` for a single required
  label, `when.labelAny` for "any of these"). False predicates skip
  the entry silently for that run.

Cross-runtime contract: manual-prompt providers (e.g. `ultrareview`)
emit Markdown only and MUST NEVER throw under any host. Inline
providers that require a host-specific binary (e.g.
`security-review` shells out to `claude --print /security-review`)
SHOULD be declared `optional: true` so non-Claude consumers can pin
the same `.agents/` version without modifying their config.

The pluggable backend was introduced in Epic #2815; the multi-provider
chain, `security-review`, and `ultrareview` were added in Story #2871.

---

## Feedback loop — code-review auto-graduation

When the Epic finalize listener runs, non-blocking code-review findings
(severity `high`, `medium`, or `low`) that survived merge are
auto-graduated into follow-up issues, routed by source classification
into the framework repo or the consumer repo. The toggle lives at
`delivery.feedbackLoop.codeReviewAutoFile` and defaults to `true`.

To opt out (for example, to triage findings manually during a
stabilization window), set the toggle to `false` in your root
`.agentrc.json`:

```json
{
  "delivery": {
    "feedbackLoop": {
      "codeReviewAutoFile": false
    }
  }
}
```

When disabled, the listener short-circuits and leaves the structured
`code-review` comments on the Epic ticket untouched. Re-enabling the
toggle is safe: the graduator embeds an idempotency marker
(`<!-- code-review-followup: epic-<id>-finding-<idx> -->`) in each filed
issue body, so re-runs skip findings that already have an issue.

---

## Worktree dependency strategies

When `delivery.worktreeIsolation.enabled` is `true`, each Story runs in
its own worktree under `.worktrees/story-<id>/`. The
`nodeModulesStrategy` field on `delivery.worktreeIsolation` controls how
`node_modules` is populated in that worktree. Three values are supported,
each with different cost/portability trade-offs:

| Strategy       | When to use                                                      | Cold-start cost          | Notes                                                                                                       |
| -------------- | ---------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `per-worktree` | Default-safe — no host setup, no symlink semantics to worry about. | Full `npm ci` per Story. | Slowest. Each worktree gets an independent `node_modules`.                                                  |
| `symlink`      | npm/yarn repos that want the fast path. **Opt-in.**              | Near-zero.               | Junctions a single donor `node_modules` into each worktree. Refuses on Windows unless explicitly opted in.  |
| `pnpm-store`   | pnpm repos. **Shipped consumer default in `agentrc-reference.json`.** | Fast (store-backed).     | Runs `pnpm install --frozen-lockfile` against the shared content-addressable store.                         |

The **shipped consumer default in
[`.agents/docs/agentrc-reference.json`](./docs/agentrc-reference.json) remains
`pnpm-store`**. Repos that do not use pnpm should opt in to `symlink`
explicitly in their root `.agentrc.json`; this repo dogfoods that
configuration.

### Symlink opt-in (npm / yarn)

To opt in, set three fields on `delivery.worktreeIsolation` in your root
`.agentrc.json`:

```json
{
  "delivery": {
    "worktreeIsolation": {
      "enabled": true,
      "nodeModulesStrategy": "symlink",
      "primeFromPath": ".",
      "allowSymlinkOnWindows": true
    }
  }
}
```

- **`nodeModulesStrategy: "symlink"`** — switch off the per-worktree
  install and link instead.
- **`primeFromPath`** — relative path (from the repo root) to the donor
  worktree whose `node_modules/` is reused. `"."` means the root
  checkout, which must already have `node_modules/` populated before a
  Story initializes. `story-init.js` enforces this with a pre-check.
- **`allowSymlinkOnWindows`** — required on Windows. The strategy uses
  junctions (no admin rights needed) on Windows when this is `true`; it
  refuses with an explanatory error otherwise, because symlink semantics
  vary by Windows version.

Once these are set, `story-init.js` skips `npm ci` in the worktree and
junctions/symlinks `node_modules` from the donor — typical cold-start
falls from minutes to under a second.

---

## Multi-developer coordination

Two operators can drive the same repository at once — one running
`/deliver <id>`, another running `/single-story-deliver <id>`, or two
operators on the same Epic from separate clones. The framework keeps those
runs from clobbering one another with **two distinct coordination layers**.
They solve different problems and must not be confused:

- **Filesystem locks** (`epic-merge-lock`, `sweep-lock`) serialise work
  **within a single machine/clone**. They are keyed on local process PIDs
  and live under `.git/` (or a local lockfile path), so they do **not**
  coordinate across clones. See
  [`docs/SDLC.md` § Cross-clone coordination](docs/SDLC.md#cross-clone-coordination)
  for why.
- **The assignee-as-lease claim** coordinates **across clones** by riding
  the ticket's GitHub `assignees` surface — a substrate every clone can
  see. This is the cross-clone layer, described below.

### Assignee-as-lease claim model

The lease primitive lives in
[`scripts/lib/orchestration/ticket-lease.js`](scripts/lib/orchestration/ticket-lease.js).
Rather than inventing a new state column, the lease rides the ticket's
existing **assignees** field: the single assignee *is* the lease owner.
Liveness is decided by the owner's most-recent `story.heartbeat` timestamp
compared against a configurable TTL (`delivery.lease.ttlMs`).

The model has five behaviours, all expressed through `acquireLease` /
`releaseLease`:

| Behaviour | When it fires | Outcome |
| --------- | ------------- | ------- |
| **Acquire by self-assign** | The ticket is unassigned. | The operator is written to `assignees`; the run proceeds (`reason: 'unclaimed'`). |
| **Re-affirm a self-held claim** | The operator already holds the lease. | No write; the run proceeds (`reason: 'already-held'`). |
| **Refuse-if-foreign** | A *different* operator holds the lease and their heartbeat is within the TTL (the claim is **live**). | The acquire **fails closed** — the run refuses to start and names the current owner so you know who to coordinate with (`reason: 'held'`). |
| **Stale-claim reclaim** | A foreign claim exists but its heartbeat is older than the TTL (or the owner never heartbeated). | The lease is automatically reassigned to the operator (`reason: 'reclaimed'`). An abandoned claim never wedges the ticket. |
| **`--steal` override** | A foreign claim is *live* and the operator passes `--steal`. | The live claim is forcibly transferred (`reason: 'stolen'`). This is the **only** way past a live foreign claim. |

On a clean completion the holder **releases** the lease (clears the
assignment), but only when it still holds it — a late release on a ticket
that was since reassigned (e.g. via `--steal`) is a no-op, so it never
yanks the claim back from whoever legitimately took over.

**Where it's wired:**

- **`/deliver`** acquires the lease on the **Epic** ticket during its
  prepare phase, before any mutating git work
  ([`epic-deliver-lease-guard.js`](scripts/lib/orchestration/epic-deliver-lease-guard.js)).
  A live foreign claim refuses the run; pass `--steal` to override and
  `--as <handle>` to claim under a specific identity. The operator is
  resolved from `--as`, then `github.operatorHandle`, then
  `git config user.email`; when none resolve, the lease step is skipped
  (the checkout-safety guard still runs).
- **`/single-story-deliver`** acquires the lease on the **Story** ticket at
  init and releases it at close
  ([`single-story-lease-guard.js`](scripts/lib/orchestration/single-story-lease-guard.js)).
  The standalone path requires `github.operatorHandle` to be set — without
  an operator identity the lease has no owner to record.
- **`/plan`** acquires the lease on the **Epic** ticket before Phase 7
  (spec) and releases it after Phase 8 (decompose)
  ([`epic-plan-lease-guard.js`](scripts/lib/orchestration/epic-plan-lease-guard.js)).
  Because planning emits no `story.heartbeat` (heartbeats are a
  delivery-time signal), the plan path has no live-heartbeat source and so
  **fails closed**: any foreign assignee is treated as a live claim and
  refuses the run unless `--steal` transfers it. Unassigned or self-held
  Epics proceed. When `github.operatorHandle` is unset the lease cannot be
  keyed and the preflight degrades to a no-op.

---

## Root config vs distributed templates

Three `.agentrc`-shaped files live in this repository and serve different
audiences. Their roles, audiences, and the keys where they legitimately
diverge are documented in
[`docs/configuration.md` § Root dogfood vs distributed templates](docs/configuration.md#root-dogfood-vs-distributed-templates)
— that section is the canonical single home for this table.

---

## Adopting the QA harness

Mandrel ships **three** complementary QA loops, all adopting the `qa-engineer`
persona and all reading the same `qa.*` project contract from `.agentrc.json`.
Two are exploratory siblings that differ on **who drives**; the third steps a
known scenario set:

- **`/qa-explore <surface>`** — an **agent-led**, open-ended
  **Plan → Capture → Triage** exploratory sweep. The operator names a surface;
  the **agent drives** it (through the browser MCP by default, or statically as
  a documented interim), probing for product bugs, environment-setup friction,
  tooling/DX gaps, missing tests, and enhancement ideas, recording each
  observation as a `QaLedgerItem` against the
  [`qa-ledger.schema.json`](schemas/qa-ledger.schema.json) contract. Capture is
  strictly read-only — the only write it performs is appending ledger lines to
  the session ledger at **`temp/qa/<sessionId>.ndjson`** (session scratch under
  `project.paths.tempRoot`, gitignored, never committed). Triage then
  classifies, dedups, and routes each item into a `file` / `defer` / `dismiss`
  disposition; the session is HITL-gated — every phase transition and every
  ticket-filing write is operator-gated. A resumed session
  (`--session-id <id>`) appends and carries its un-triaged backlog forward. The
  end-to-end procedure is the SSOT in
  [`workflows/qa-explore.md`](workflows/qa-explore.md), with the deterministic
  decision seams under `scripts/lib/qa/` (session, redaction, coverage,
  missing-test) and `scripts/lib/findings/` (classification, dedup/route).
- **`/qa-assist`** — the **human-led** sibling of `/qa-explore`: a
  single-observation **Intake → Enrich → Record** loop. Here the **human
  drives** — the operator reports one thing they observed (a bug, a flaky
  behavior, a "this feels off") and the agent enriches it into a triage-ready
  `QaLedgerItem` (a clean repro, a `file:line` root-cause locus, a coverage
  verdict), asking clarifying questions when the observation is ambiguous, then
  appends it — after explicit confirmation — to a persistent, resumable rolling
  session under `temp/qa/`. It writes the **same** ledger contract `/qa-explore`
  produces, so a `/qa-assist` item flows through the identical dedup,
  classification, and promotion machinery later. The end-to-end procedure is
  the SSOT in [`workflows/qa-assist.md`](workflows/qa-assist.md). Reach for
  `/qa-assist` when you hit something mid-flight and want it captured well
  without breaking stride; reach for `/qa-explore` when you want the agent to
  go hunt a named surface.
- **`/qa-run <selector>`** — the **automated complement**: it drives a
  consumer's Gherkin `.feature` scenarios through a real browser (the
  `chrome-devtools` MCP surface), captures per-surface console/network into
  structured `F#` findings, and drafts follow-up tickets for operator
  sign-off. The end-to-end procedure is the SSOT in
  [`workflows/qa-run.md`](workflows/qa-run.md); the
  instrumentation conventions live in the
  [`skills/stack/qa/qa-harness`](skills/stack/qa/qa-harness/SKILL.md) skill; the
  architectural overview (run pipeline, contract fields, finding shape) is in
  [`docs/architecture.md` § Agent-driven QA harness](../docs/architecture.md#agent-driven-qa-harness).

Reach for `/qa-explore` when you want the **agent** to hunt a freshly delivered
Story/Feature or run a structured bug-hunt captured into a triageable ledger;
reach for `/qa-assist` when **you** hit something mid-flight and want it
enriched into a single triage-ready ledger item; reach for `/qa-run` to
step a **known** scenario set through the browser for a regression pass.

Binding the QA contract is **opt-in**. All three workflows resolve the
consumer's `qa` block through the single seam
[`resolve-qa-contract.js`](scripts/lib/qa/resolve-qa-contract.js); a consumer
that has not bound it gets a loud, actionable failure ("this project has not
bound the QA harness") when either workflow runs — there is no auto-detection
fallback. To adopt the QA surface, a consumer project takes three concrete
steps.

### 1. Bind the `qa` block in `.agentrc.json`

Add a top-level `qa` block. It is optional in the schema (so config
validation never breaks a non-QA consumer), but the four core fields are
required at run time by `resolveQaContract`. Copy the reference shape from
[`agentrc-reference.json`](docs/agentrc-reference.json) and adapt the paths:

```jsonc
{
  "qa": {
    "featureRoot": "tests/features",                 // root the selector resolves .feature files against
    "fixturesManifest": "tests/fixtures/personas.json", // persona → seed-data manifest
    "signInSeam": { "urlTemplate": "/dev/sign-in-as/{persona}" }, // dev seam (see step 3)
    "personas": ["admin", "member"],                 // name-only array — the honest shape for a url-template seam
    "consoleAllowlist": ["[HMR]"],                   // optional benign-noise filter (default [])
    "designTokens": "src/styles/tokens.css"          // optional visual-check pointer (default null)
  }
}
```

`featureRoot`, `fixturesManifest`, `signInSeam`, and `personas` are
mandatory; omitting any one makes the resolver throw a field-named error.
`consoleAllowlist` and `designTokens` default to `[]` and `null`.

`personas` accepts **two shapes** (the resolver normalizes both to one
canonical internal map keyed by persona name):

- **Name-only array** (above) — `["admin", "member"]`. This is the honest
  shape under a `urlTemplate` dev-impersonation seam, where the persona name
  is the only input the harness consumes (it is substituted into the URL) and
  no per-persona auth material is ever read. Do **not** fabricate
  `credentialRef`/`signInSkill` values a url-template seam ignores.
- **Object map** — keyed by persona name, each entry carrying per-persona
  auth material (`{ credentialRef }` or `{ signInSkill }`). Use this only
  under a `skill` (or credential) seam where that material is genuinely
  consulted:

  ```jsonc
  "signInSeam": { "skill": "stack/qa/sign-in" },
  "personas": {
    "admin": { "credentialRef": "QA_ADMIN_CREDENTIAL" }, // stored-credential reference, never an inline secret
    "member": { "signInSkill": "stack/qa/sign-in-member" } // or a per-persona sign-in skill
  }
  ```

### 2. Author the fixtures manifest

Create the file referenced by `fixturesManifest`. It binds each persona to
the seed data the harness loads before signing that persona in, so scenarios
start from a known state. Every persona named under `qa.personas` should have
a corresponding entry. Keep the manifest free of real secrets — it carries
seed-data shape, not credentials (credentials resolve through `credentialRef`
or a sign-in skill).

### 3. Expose a `signInSeam`

The harness signs in once per persona using a **dev-only seam** — real
credentials are never entered. Expose one of two shapes:

- **`{ urlTemplate }`** — a dev sign-in route where `{persona}` is
  substituted (e.g. `/dev/sign-in-as/{persona}` → `/dev/sign-in-as/admin`).
  Gate this route to non-production builds.
- **`{ skill }`** — when sign-in is multi-step or non-URL, point at a
  consumer skill whose `SKILL.md` the harness reads and follows.

Which seam kinds consult per-persona material: under a `{ urlTemplate }` seam
the persona **name** is the sole input, so author `personas` as a name-only
array and supply no auth material. Under a `{ skill }` (or credential) seam,
author `personas` as the object map and supply per-persona overrides:
`{ credentialRef }` points at a stored-credential reference (resolved from the
environment, never inlined) and `{ signInSkill }` points at a per-persona
sign-in skill.

Once these three `qa.*` keys are in place, `/qa-explore <surface>`,
`/qa-assist`, and `/qa-run <selector>` all resolve the contract and
operate against the bound surface. For `/qa-run`, the `chrome-devtools`
MCP surface is a host-provided runtime dependency; when it is unavailable the
harness degrades with a clear error rather than falling back to a headless
runner. `/qa-explore` and `/qa-assist` read the same `qa.*` keys to scope their
work and to drive the deterministic coverage/missing-test verdicts, then record
each observation into the `temp/qa/` ledger described above.
