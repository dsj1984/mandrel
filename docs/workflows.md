# Workflow (Slash-Command) Reference Index

This is a **reference index** of every slash-command skill shipped under
`.agents/workflows/`. The canonical workflow narrative lives in
[`.agents/SDLC.md`](../.agents/SDLC.md) — read that first to understand how the
commands compose. This file is only for "which command does X?" lookups.

Every command file lives at `.agents/workflows/<name>.md` and is auto-synced to
`.claude/commands/<name>.md` by `npm run sync:commands` so it shows up as a
`/`-prefixed slash command in Claude Code.

## Planning

| Command       | Purpose                                                                                          | Typical caller  |
| ------------- | ------------------------------------------------------------------------------------------------ | --------------- |
| `/epic-plan`  | One-shot wrapper: generate PRD + Tech Spec, pause for confirmation, then decompose. No flags.    | Operator in IDE |

## Execution

The execution surface is split by hierarchy level. Pick the
level you want to drive — each skill takes an explicit ticket id and dispatches
its children via the Agent tool inside the operator's Claude session.

| Command                              | Purpose                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/epic-execute <epicId>`             | Owns the wave loop for the whole Epic; fans Stories out directly per wave via Agent-tool sub-agents (cap = `concurrencyCap`). |
| `/story-execute <storyId>`           | Init → task loop → close for one Story. Reads `helpers/task-execute.md` inline per Task. |

## Closure

| Command              | Purpose                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/epic-close`        | Close an Epic end-to-end. Internally auto-invokes the `epic-code-review` and `epic-retro` helpers before merging to `main`.   |
| `/run-bdd-suite`     | Run a tag-filtered BDD acceptance suite and collect a Cucumber report (consumed by the `epic-testing.md` helper).             |

## Audit suite

Twelve specialized audits. Each activates the corresponding persona and can be
invoked manually or automatically at `gate1`–`gate4` by the audit orchestrator.

| Command                    | Focus                                                                          |
| -------------------------- | ------------------------------------------------------------------------------ |
| `/audit-architecture`      | Architecture and clean-code structure                                          |
| `/audit-clean-code`        | Clean-code and maintainability                                                 |
| `/audit-dependencies`      | Dependency audit and upgrade                                                   |
| `/audit-devops`            | DevOps infrastructure                                                          |
| `/audit-lighthouse`        | Lighthouse audit (Performance / Accessibility / Best Practices / SEO)          |
| `/audit-performance`       | Performance and bottleneck analysis                                            |
| `/audit-privacy`           | Privacy and PII data flows                                                     |
| `/audit-quality`           | Testing and quality assurance                                                  |
| `/audit-security`          | Security and vulnerability scan                                                |
| `/audit-seo`               | SEO and Generative Engine Optimization                                         |
| `/audit-sre`               | Production release-candidate SRE readiness                                     |
| `/audit-ux-ui`             | UX/UI consistency and design system adherence                                  |

## Git operations

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/git-commit-all`         | Commit all outstanding changes to the current branch.                         |
| `/git-push`               | Commit all outstanding changes and push to the remote.                        |
| `/git-merge-pr`           | Analyze, validate, resolve conflicts, and merge a given pull request.         |
| `/delete-epic-branches`   | Hard reset — delete all branches associated with an Epic and its children.    |
| `/delete-epic-tickets`    | Hard reset — delete all child issues of an Epic (not the Epic itself).        |

## Setup & meta

| Command                    | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/agents-bootstrap-github`  | Initialize a GitHub repo with the framework label taxonomy, project fields, and the default Kanban board.       |
| `/agents-bootstrap-project` | Wire the local harness around the framework: `.claude/commands/` sync, `package.json` scripts, hooks, gitignore, and a host-level git-perf check on Windows. |
| `/agents-update`            | Bump the `.agents` submodule to its remote HEAD, reconcile `.agentrc.json` against the new defaults, and regenerate `.claude/commands/`. |
| `/drain-pending-cleanup`    | Reap any orphan `.worktrees/` residue and prune stale story / epic branches in one pass.                        |

## Internal / reference-only

Not invoked directly by operators, but referenced from other workflows:

- `helpers/_merge-conflict-template.md` — canonical procedure for resolving a
  merge conflict, included by reference from `story-execute`, `epic-close`,
  and `git-merge-pr`.
- `helpers/epic-code-review.md` — comprehensive code-review procedure,
  auto-invoked by `epic-close` (Phase 3) and the `epic-execute` bookends.
- `helpers/epic-retro.md` — retrospective authoring procedure, auto-invoked
  by `epic-close` (Phase 6).
- `helpers/epic-testing.md` — QA evidence ingest for the Epic-testing
  ticket, invoked by `epic-close` / operator; consumes `/run-bdd-suite`
  output.
- `helpers/epic-plan-spec.md`, `helpers/epic-plan-decompose.md` —
  phase procedures delegated to by `/epic-plan`.
- `helpers/task-execute.md` — single-Task implementation procedure read
  inline by `/story-execute` per Task (not a slash command).
- `helpers/agents-sync-config.md` — schema-driven validate-then-merge procedure
  for `.agentrc.json`, invoked by `/agents-update` after the submodule pointer
  moves (formerly shipped as `/agents-sync-config`).
- `worktree-lifecycle.md` — per-story `git worktree` isolation model, including
  node_modules strategies, Windows notes, and escape hatches.

## Adding a new workflow

1. Author `.agents/workflows/<name>.md` with a YAML frontmatter block (`name`,
   `description`).
2. Run `npm run sync:commands` — this copies the file into
   `.claude/commands/<name>.md` so it surfaces as a `/`-prefixed command.
3. Add a row to this index and (if the command is part of the canonical
   lifecycle) a reference in [`.agents/SDLC.md`](../.agents/SDLC.md).
