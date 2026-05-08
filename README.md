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

## Where to look

| You want…                                         | Open                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| The end-to-end SDLC walkthrough                   | [`SDLC.md`](SDLC.md)                                                            |
| The system prompt loaded by your AI tool          | [`instructions.md`](instructions.md)                                            |
| Every `.agentrc.json` key, default, and override  | [`docs/configuration.md`](../docs/configuration.md)                              |
| Quality-gate runbooks (CRAP, MI, lint, friction)  | [`docs/quality-gates.md`](../docs/quality-gates.md)                              |
| Slash-command workflow definitions                | [`workflows/`](workflows/)                                                      |
| Persona behavior packs                            | [`personas/`](personas/)                                                        |
| Domain-agnostic baseline rules                    | [`rules/`](rules/)                                                              |
| Skill library (core process + stack guardrails)   | [`skills/core/`](skills/core/) · [`skills/stack/`](skills/stack/)                |
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
