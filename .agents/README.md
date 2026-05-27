# Mandrel — `.agents/`

This is the framework submodule (`.agents/`) consumed by host repos via
`git submodule add`. It ships a system prompt, a baseline rule pack, a
two-tier skill library, a slash-command workflow set, and the
orchestration engine that runs Epic → Feature → Story → Task plans on
GitHub. The framework version lives at [`VERSION`](VERSION) — read that
file, not a count here.

> **3-tier (target shape — opt-in via `planning.hierarchy: '3-tier'`).**
> Epic #3078 collapses the Task layer; the target hierarchy is
> Epic → Feature → Story with inline acceptance/verify on Story bodies.
> While Epic #3078 is in flight, the default for `planning.hierarchy`
> in `.agentrc.json` remains `'4-tier'` and both shapes are supported in
> parallel. Set `planning.hierarchy: '3-tier'` to opt in. After Epic
> #3078's destructive Feature 8 lands, the flag is removed and 3-tier
> becomes the only shape — consumers re-pin the `.agents/` submodule to
> adopt the cutover. See [`SDLC.md` § 3-tier hierarchy](SDLC.md) for the
> target diagram and execution-model implications.

This is the only README inside the distributed `.agents/` bundle. It
explains what each part of the submodule is for and captures the
cross-directory authoring conventions. The process narrative for
`/epic-plan` and `/epic-deliver` stays in [`SDLC.md`](SDLC.md).

---

## Activation

Two steps, run once per consuming repo:

1. **Load the system prompt.** Configure your AI tool (`.cursorrules`,
   Custom Instructions, or system-prompt settings) to load
   [`instructions.md`](instructions.md) verbatim. Without this, none of
   the protocols are active.
2. **Run the unified bootstrap.** From the host repo root:

   ```bash
   node .agents/scripts/bootstrap.js
   ```

   The script walks every required value (auto-detecting owner / repo /
   base branch from `git remote`), seeds `.agentrc.json` from
   [`starter-agentrc.json`](starter-agentrc.json), merges the
   framework's runtime dependencies, runs `npm install`, wires the
   `.claude/commands/` sync hook, gitignores derived artefacts, runs
   the stabilized-quality-gates installer, then creates the GitHub
   label taxonomy + Project V2 fields. Idempotent — safe to re-run. Pass
   `--owner`, `--repo`, and `--assume-yes` for non-interactive (CI)
   installs; pass `--skip-github` to defer the remote half.

After bootstrap you can run any slash command — `/epic-plan`,
`/single-story-plan`, `/single-story-deliver`, `/audit-security`,
`/agents-update`, etc. The [SDLC guide](SDLC.md) walks an end-to-end
Epic; standalone Stories pair [`/single-story-plan`](workflows/single-story-plan.md)
(idea → drafted Story Issue) with [`/single-story-deliver`](workflows/single-story-deliver.md)
(Story Issue → merged PR).

---

## Contents

| Path | Purpose |
| ---- | ------- |
| [`instructions.md`](instructions.md) | Primary system prompt loaded by the host AI tool. |
| [`VERSION`](VERSION) | Framework version shipped by this submodule. |
| [`SDLC.md`](SDLC.md) | Operator process for `/epic-plan` and `/epic-deliver`. |
| [`starter-agentrc.json`](starter-agentrc.json) | Bootstrap delta-seed copied to the consumer repo root as `.agentrc.json`. |
| [`full-agentrc.json`](full-agentrc.json) | Exhaustive editor reference enumerating every schema key with its framework default. |
| [`personas/`](personas/) | Role-specific behavior packs selected by task persona or explicit user instruction. |
| [`rules/`](rules/) | Domain-agnostic coding, security, testing, shell, git, and workflow rules. |
| [`skills/core/`](skills/core/) | Universal process skills such as debugging, TDD, security, documentation, and code review. |
| [`skills/stack/`](skills/stack/) | Stack-specific guardrails for frameworks, services, and testing tools. |
| [`workflows/`](workflows/) | Slash-command workflow definitions. Top-level files are synced to `.claude/commands/`. |
| [`workflows/helpers/`](workflows/helpers/) | Workflow fragments read by parent workflows; not exposed as slash commands. |
| [`scripts/`](scripts/) | Deterministic Node.js CLIs used by workflows and operators. |
| [`scripts/lib/orchestration/`](scripts/lib/orchestration/) | In-process orchestration SDK used by the CLI wrappers. |
| [`scripts/lib/checks/`](scripts/lib/checks/) | Discovery-based self-healing checks registry for preflight, the `diagnose.js` viewer, and retro surfaces. |
| [`schemas/`](schemas/) | JSON Schema contracts for config, manifests, reports, and persisted runtime artefacts. |
| [`templates/`](templates/) | Prompt and planning templates used by the orchestration flow. |

---

## Where to Look

| You want… | Open |
| --------- | ---- |
| The Epic planning and delivery process | [`SDLC.md`](SDLC.md) |
| The system prompt loaded by your AI tool | [`instructions.md`](instructions.md) |
| Every `.agentrc.json` key, default, and override | [`docs/configuration.md`](../docs/configuration.md) |
| Quality-gate runbooks (CRAP, MI, lint, friction) | [`docs/quality-gates.md`](../docs/quality-gates.md) |
| Baseline envelope, component model, writer/reader contract | [`docs/baselines.md`](../docs/baselines.md) |
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

### Worked example 2 — pure script: `retrofit-task-bodies.js`

[`scripts/retrofit-task-bodies.js`](scripts/retrofit-task-bodies.js)
**stays a script** even though it has an LLM step adjacent to it.

- It walks every Task descendant of an Epic, skips ones already on the
  current structured-body schema, and emits a JSON envelope per
  non-conforming Task.
- The host LLM authors a "bodies file" from the envelope (the judgment
  step, conceptually adjacent — but **not part of this unit**).
- A second invocation applies the authored bodies, updating each Task's
  issue body via the GitHub provider.

The script's own input/output is deterministic and parseable: it does
not compose prompts, it does not classify, it does not author prose. The
adjacent LLM authoring step could one day be migrated to a Skill in a
separate Epic, but doing so would not change this script's verdict —
the renderer half stays imperative.

---

## Workflow Authoring

`workflows/` is the source of truth for the slash-command surface
exposed by Claude Code in this repo. Each top-level `.md` file is synced
into `.claude/commands/<name>.md` by
[`sync-claude-commands.js`](scripts/sync-claude-commands.js). Files under
`workflows/helpers/` are path-included modules read by parent workflows;
they are not synced or exposed as slash commands.

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
3. Run `npm run sync:commands` to mirror the file into
   `.claude/commands/`.

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
no separate adapter abstraction; `wave-dispatcher.js` synthesizes the
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
consumed by preflight guards (`/epic-deliver`, `/story-close`, `npm test`),
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

See [`docs/baselines.md`](../docs/baselines.md) for the full reference:
envelope shape, per-kind axes, component model, path canonicalisation,
writer/reader contract, kernel-version friction, and — most relevant to
consumers — the **floor override** path. Consumers add a `floors` block
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

`runCodeReview()` (invoked at the end of `/story-deliver`,
`/single-story-deliver`, and `/epic-deliver`) loads its review backend
through a pluggable registry. Two configuration shapes are supported:

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
| `pnpm-store`   | pnpm repos. **Shipped consumer default in `full-agentrc.json`.** | Fast (store-backed).     | Runs `pnpm install --frozen-lockfile` against the shared content-addressable store.                         |

The **shipped consumer default in
[`.agents/full-agentrc.json`](./full-agentrc.json) remains
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

## Root config vs distributed templates

Three `.agentrc`-shaped files live in this repository and are easy to
confuse:

| File                              | Audience                          | Role                                                                                                                              |
| --------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `.agentrc.json` (repo root)       | The framework dogfooding itself   | Live config used when running `/epic-*`, `/story-deliver` against this repo. Exercises the framework end-to-end. |
| `.agents/starter-agentrc.json`    | Downstream consumer repos         | Bootstrap delta-seed a consumer copies via `cp .agents/starter-agentrc.json .agentrc.json`. Minimum schema-required keys.        |
| `.agents/full-agentrc.json`       | Operators and reviewers           | Exhaustive editor reference enumerating every schema key with its framework default. Not a copy target.                          |

The three files share a schema; where they legitimately diverge (target
dirs, repo identifiers, version-file pointer) is documented in
[`docs/configuration.md` § Root dogfood vs distributed template](../docs/configuration.md#root-dogfood-vs-distributed-template).
Edit `full-agentrc.json` when a framework default changes; edit
`starter-agentrc.json` only when the bootstrap seed itself needs new
schema-required keys; edit the root `.agentrc.json` for changes that
only affect this repo's own dogfood runs.
