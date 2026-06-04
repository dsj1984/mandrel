# Workflow (Slash-Command) Reference Index

This is a **reference index** of every slash-command skill shipped under
`.agents/workflows/`. The canonical workflow narrative lives in
[`.agents/SDLC.md`](../.agents/SDLC.md) — read that first to understand how the
commands compose. This file is only for "which command does X?" lookups.

Every command file lives at `.agents/workflows/<name>.md` and is projected into
a **Claude Code plugin** by `npm run sync:commands` so it shows up as a
namespaced `/mandrel:<name>` command (e.g. `/mandrel:epic-deliver`). The
projection writes the plugin manifest at
`.claude/plugins/mandrel/.claude-plugin/plugin.json`, the command tree under
`.claude/plugins/mandrel/commands/`, and a repo-local marketplace listing at
`.claude/.claude-plugin/marketplace.json`. The `mandrel:` namespace is the one
place the brand appears — it makes every Mandrel command collision-safe and
self-identifying (see ADR 20260603-plugin-namespace-cutover). Requires Claude
Code v2.1.0+ for stable `plugin:command` namespacing.

## SDL critical path

The SDL critical path is two commands. `/epic-plan` builds the
backlog declaratively — it emits an `epic.yaml` artifact and reconciles
it against GitHub via `epic-reconcile.js` without creating
the Epic branch at plan time. `/epic-deliver` drives the merged
wave-loop + close-tail and opens a pull request to `main`. The operator
merges the PR through the GitHub UI — the workflow never merges to
`main` itself.

`/agents-update` invokes the Claude Code built-in
`/fewer-permission-prompts` (Step 3.6) to refresh the harness allowlist
after a package bump. Other built-ins (`/loop`, `/insights`, `/goal`)
are not wired into any workflow today — see ADR 20260512-coupling-stance
and ADR 20260512-loop-adoption in [`decisions.md`](decisions.md) for the
stance on future adoption.

| Command                           | Purpose                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mandrel:epic-plan`                      | Ideation mode (no args) — sharpen a raw idea, search for duplicates, create the Epic, then run PRD + Tech Spec + decomposition.                    |
| `/mandrel:epic-plan --idea "<seed>"`      | Same ideation entry with a pre-supplied seed.                                                                                                      |
| `/mandrel:epic-plan <epicId>`             | Existing-Epic mode — generate PRD + Tech Spec + decomposition for an Epic ticket that has already been opened.                                     |
| `/mandrel:epic-deliver <epicId>`          | Six-phase wave-loop + close-validation + code-review + retro + finalize. Terminates with a PR open against `main`; operator merges via GitHub UI.  |
| `/mandrel:story-deliver <storyId>`        | Init → Story-implementation phase → close for one Story. Used directly when re-driving a single Story off-table. |

## Audit suite

Twelve specialized audits. Each activates the corresponding persona and can be
invoked manually or automatically at `gate1`–`gate4` by the audit orchestrator.

| Command                    | Focus                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| `/mandrel:audit-architecture`      | Architecture and clean-code structure                                          |
| `/mandrel:audit-clean-code`        | Clean-code and maintainability                                                 |
| `/mandrel:audit-dependencies`      | Dependency audit and upgrade                                                   |
| `/mandrel:audit-devops`            | DevOps infrastructure                                                          |
| `/mandrel:audit-lighthouse`        | Lighthouse audit (Performance / Accessibility / Best Practices / SEO)          |
| `/mandrel:audit-performance`       | Performance and bottleneck analysis                                            |
| `/mandrel:audit-privacy`           | Privacy and PII data flows                                                     |
| `/mandrel:audit-quality`           | Testing and quality assurance                                                  |
| `/mandrel:audit-security`          | Security and vulnerability scan                                                |
| `/mandrel:audit-seo`               | SEO and Generative Engine Optimization                                         |
| `/mandrel:audit-sre`               | Production release-candidate SRE readiness                                     |
| `/mandrel:audit-ux-ui`             | UX/UI consistency and design system adherence                                  |

## Git operations

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/mandrel:git-commit-all`         | Commit all outstanding changes to the current branch.                         |
| `/mandrel:git-push`               | Commit all outstanding changes and push to the remote.                        |
| `/mandrel:git-merge-pr`           | Analyze, validate, resolve conflicts, and merge a given pull request.         |

## Comprehension

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/mandrel:explain [PR# \| branch \| --staged]` | Walk the operator through a code change until they understand it — problem, why, design decisions, edge cases, blast radius. Drives the `core/knowledge-transfer` skill (restate-first, why-ladder, mastery gates, persistent checklist) with an operator-controlled stop at every checkpoint. The same engine runs over a *plan* at `/epic-plan` Phase 11. |

## Setup & meta

| Command                    | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node .agents/scripts/bootstrap.js` | One-shot consumer setup: wires the local harness (mandrel plugin sync + enablement, `package.json` scripts, hooks, gitignore, Windows git-perf check) **and** initializes the GitHub repo (label taxonomy, project fields, default Kanban board, branch protection when enabled). Not a slash command — runs deterministically with interactive prompts on a TTY and flag-driven non-interactive runs in CI. |
| `/mandrel:agents-update`            | Upgrade the installed `@mandrelai/agents` package via the `mandrel update` CLI (bump → sync → migrate → doctor), reconcile `.agentrc.json` against the new defaults, and refresh the Claude Code plugin command surface. |
| `/mandrel:drain-pending-cleanup`    | Reap any orphan `.worktrees/` residue and prune stale story / epic branches in one pass.                        |
| `/mandrel:run-qa-harness`           | Drive a selected set of Gherkin scenarios through a real browser as an agent-driven QA sweep, emitting a sweep summary and structured findings (consumed by the `epic-testing.md` helper). Run pipeline, the `qa` contract fields, and the `F#` finding shape are documented in [`architecture.md` § Agent-driven QA harness](architecture.md#agent-driven-qa-harness); consumer adoption steps are in [`.agents/README.md` § Adopting the QA harness](../.agents/README.md#adopting-the-qa-harness). |

## Internal / reference-only

Not invoked directly by operators, but referenced from other workflows:

- `helpers/_merge-conflict-template.md` — canonical procedure for resolving a
  merge conflict, included by reference from `story-deliver`, `epic-deliver`,
  and `git-merge-pr`.
- `helpers/epic-code-review.md` — comprehensive code-review procedure,
  auto-invoked by `/epic-deliver` Phase 4 (close-tail). Findings persist as
  a `code-review` structured comment on the Epic ticket.
- `helpers/epic-testing.md` — QA evidence ingest for the Epic-testing
  ticket; consumes `/run-qa-harness` output. Invoked by operators or by the
  `/epic-deliver` close-tail when an Epic-testing ticket is present.
- `helpers/epic-plan-spec.md`, `helpers/epic-plan-decompose.md` —
  phase procedures delegated to by `/epic-plan`.
- `helpers/task-execute.md` — single-Task implementation procedure read
  inline by `/story-deliver` per Task (not a slash command).
- `helpers/agents-sync-config.md` — schema-driven validate-then-merge procedure
  for `.agentrc.json`, invoked by `/agents-update` after the package upgrade
  re-materializes `.agents/` (formerly shipped as `/agents-sync-config`).
- `helpers/worktree-lifecycle.md` — per-story `git worktree` isolation model,
  including node_modules strategies, Windows notes, and escape hatches. Lives
  under `helpers/` because it is operator and reviewer reference documentation,
  not an executable workflow; path-included from `story-deliver.md`.

The retro is no longer a separate helper — its logic lives inline at
`lib/orchestration/retro-runner.js` and fires automatically during
`/epic-deliver` Phase 5 before the PR is opened.

## Convergence in multi-phase workflows

Long-running orchestrator workflows like `/epic-deliver` and
`/story-deliver` converge through their phase machinery, not through a
sticky-goal directive. Each phase is driven by a CLI script
(`wave-tick.js`, `epic-execute-record-wave.js`, `story-close.js`, …)
whose JSON return tells the agent what to do next; terminal states are
unambiguous (`nextAction.kind === "epic-complete"`, `action: 'noop'`).
The Anti-Thrashing Protocol in `.agents/instructions.md` and the
`agent::blocked` HITL gate handle drift and unresolvable blockers.

Claude Code's `/goal` built-in (a prompt-side directive only the
operator can type) is not wired into any workflow. When authoring a new
multi-phase orchestrator, rely on the same pattern: explicit per-phase
CLI returns, an `agent::blocked` exit, and the anti-thrashing rules
already documented in the system prompt.

## Adding a new workflow

1. Author `.agents/workflows/<name>.md` with a YAML frontmatter block (`name`,
   `description`).
2. Run `npm run sync:commands` — this projects the file into the mandrel
   plugin at `.claude/plugins/mandrel/commands/<name>.md` so it surfaces as a
   `/mandrel:<name>` command. Never hand-edit the generated tree; it carries
   the `<!-- AUTO-GENERATED -->` header and is regenerated idempotently.
3. Add a row to this index (showing the `/mandrel:<name>` invocation) and (if
   the command is part of the canonical lifecycle) a reference in
   [`.agents/SDLC.md`](../.agents/SDLC.md).
