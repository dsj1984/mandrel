# Agent Protocols — Activation

This is the framework submodule (`.agents/`) consumed by host repos via
`git submodule add`. It ships a system prompt, a baseline rule pack, a
two-tier skill library, a slash-command workflow set, and the
orchestration engine that runs Epic → Feature → Story → Task plans on
GitHub. The framework version lives at [`VERSION`](VERSION) — read that
file, not a count here.

This README is intentionally short. The detailed reference material has
moved to `docs/` and to per-directory README / SKILL files. See the
[where to look](#where-to-look) table below.

---

## Activation

Three steps, run once per consuming repo:

1. **Load the system prompt.** Configure your AI tool (`.cursorrules`,
   Custom Instructions, or system-prompt settings) to load
   [`instructions.md`](instructions.md) verbatim. Without this, none of
   the protocols are active.
2. **Copy the config template.** From the host repo root:

   ```bash
   cp .agents/default-agentrc.json .agentrc.json
   ```

   Then edit `orchestration.github.{owner,repo}` and any
   project-specific overrides. Every key is documented in
   [`docs/configuration.md`](../docs/configuration.md).
3. **Bootstrap the GitHub repo.** Run the
   [`/agents-bootstrap-github`](workflows/agents-bootstrap-github.md)
   slash command (or `node .agents/scripts/agents-bootstrap-github.js`)
   to create the v5 label taxonomy and the optional Project V2 fields.
   It is idempotent — safe to re-run.

After step 3 you can run any slash command — `/epic-plan`,
`/audit-security`, `/agents-update`, etc. The
[SDLC guide](SDLC.md) walks an end-to-end Epic.

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

The split is exactly the v5.6 "host LLM authors directly" pattern made
explicit: the prompt+judgment step gets a `description`, an
`allowed_tools` declaration, and a smoke test; the GitHub I/O around it
keeps its imperative implementation. See the
[2026-05-11 prompt-shaped script ledger](../docs/audits/2026-05-11-prompt-shaped-scripts.md)
for the full list of scripts following this split pattern.

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
the renderer half stays imperative. This is the named deterministic
counter-example in the
[2026-05-11 prompt-shaped script ledger](../docs/audits/2026-05-11-prompt-shaped-scripts.md#deterministic-counter-example--retrofit-task-bodiesjs).

---

## Where to look

| You want…                                         | Open                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| The end-to-end SDLC walkthrough                   | [`SDLC.md`](SDLC.md)                                                            |
| The system prompt loaded by your AI tool          | [`instructions.md`](instructions.md)                                            |
| Every `.agentrc.json` key, default, and override  | [`docs/configuration.md`](../docs/configuration.md)                              |
| Quality-gate runbooks (CRAP, MI, lint, friction)  | [`docs/quality-gates.md`](../docs/quality-gates.md)                              |
| Slash-command workflow definitions                | [`workflows/`](workflows/)                                                      |
| Render the signals span-tree (`/signals`)         | [`workflows/signals.md`](workflows/signals.md)                                  |
| Persona behavior packs                            | [`personas/`](personas/)                                                        |
| Domain-agnostic baseline rules                    | [`rules/`](rules/)                                                              |
| Skill library (core process + stack guardrails)   | [`skills/core/`](skills/core/) · [`skills/stack/`](skills/stack/)                |
| Decision rule: should this be a Skill or a Script? | [§ When to use a Skill vs a Script](#when-to-use-a-skill-vs-a-script)            |
| JSON Schemas (config, dispatch manifest, etc.)    | [`schemas/`](schemas/)                                                          |
| Orchestration SDK internals                       | [`scripts/lib/orchestration/README.md`](scripts/lib/orchestration/README.md)    |
| Bootstrap labels + project fields reference       | [`workflows/agents-bootstrap-github.md`](workflows/agents-bootstrap-github.md)  |

---

## Root config vs distributed template

Two `.agentrc`-shaped files live in this repository and are easy to
confuse:

| File                            | Audience                          | Role                                                                                                                              |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `.agentrc.json` (repo root)     | The framework dogfooding itself   | Live config used when running `/epic-*`, `/story-execute` against this repo. Exercises the framework end-to-end. |
| `.agents/default-agentrc.json`  | Downstream consumer repos         | Template a consumer copies via `cp .agents/default-agentrc.json .agentrc.json` when bootstrapping. Sane defaults for any repo.    |

The two files share a schema; where they legitimately diverge (target
dirs, repo identifiers, version-file pointer) is documented in
[`docs/configuration.md` § Root dogfood vs distributed template](../docs/configuration.md#root-dogfood-vs-distributed-template).
Edit `default-agentrc.json` for changes that should ship to consumers;
edit the root `.agentrc.json` for changes that only affect this repo's
own dogfood runs.
