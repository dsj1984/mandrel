# Workflow (Slash-Command) Reference Index

This is a **reference index** of every slash-command skill shipped under
`.agents/workflows/`. The canonical workflow narrative lives in
[`.agents/SDLC.md`](../.agents/SDLC.md) — read that first to understand how the
commands compose. This file is only for "which command does X?" lookups.

Every command file lives at `.agents/workflows/<name>.md` and is auto-synced to
`.claude/commands/<name>.md` by `npm run sync:commands` so it shows up as a
`/`-prefixed slash command in Claude Code.

## SDL critical path

The SDL critical path is two commands. `/epic-plan` builds the
backlog declaratively — it emits an `epic.yaml` artifact and reconciles
it against GitHub via `epic-reconcile.js` without creating
the Epic branch at plan time. `/epic-deliver` drives the merged
wave-loop + close-tail and opens a pull request to `main`. The operator
merges the PR through the GitHub UI — the workflow never merges to
`main` itself.

The framework leans on Claude Code built-ins (`/goal`,
`/fewer-permission-prompts`, `/insights`, `/loop`) where they replace or
augment homegrown machinery — see ADR 20260512-coupling-stance and ADR
20260512-loop-adoption in [`decisions.md`](decisions.md).

| Command                           | Purpose                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/epic-plan`                      | Ideation mode (no args) — sharpen a raw idea, search for duplicates, create the Epic, then run PRD + Tech Spec + decomposition.                    |
| `/epic-plan --idea "<seed>"`      | Same ideation entry with a pre-supplied seed.                                                                                                      |
| `/epic-plan <epicId>`             | Existing-Epic mode — generate PRD + Tech Spec + decomposition for an Epic ticket that has already been opened.                                     |
| `/epic-deliver <epicId>`          | Six-phase wave-loop + close-validation + code-review + retro + finalize. Terminates with a PR open against `main`; operator merges via GitHub UI.  |
| `/story-execute <storyId>`        | Init → task loop → close for one Story. Reads `helpers/task-execute.md` inline per Task. Used directly when re-driving a single Story off-table.   |

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

## Setup & meta

| Command                    | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node .agents/scripts/bootstrap.js` | One-shot consumer setup: wires the local harness (`.claude/commands/` sync, `package.json` scripts, hooks, gitignore, Windows git-perf check) **and** initializes the GitHub repo (label taxonomy, project fields, default Kanban board, branch protection when enabled). Not a slash command — runs deterministically with interactive prompts on a TTY and flag-driven non-interactive runs in CI. |
| `/agents-update`            | Bump the `.agents` submodule to its remote HEAD, reconcile `.agentrc.json` against the new defaults, and regenerate `.claude/commands/`. |
| `/drain-pending-cleanup`    | Reap any orphan `.worktrees/` residue and prune stale story / epic branches in one pass.                        |
| `/run-bdd-suite`            | Run a tag-filtered BDD acceptance suite and collect a Cucumber report (consumed by the `epic-testing.md` helper). |

## Internal / reference-only

Not invoked directly by operators, but referenced from other workflows:

- `helpers/_merge-conflict-template.md` — canonical procedure for resolving a
  merge conflict, included by reference from `story-execute`, `epic-deliver`,
  and `git-merge-pr`.
- `helpers/epic-code-review.md` — comprehensive code-review procedure,
  auto-invoked by `/epic-deliver` Phase 4 (close-tail). Findings persist as
  a `code-review` structured comment on the Epic ticket.
- `helpers/epic-testing.md` — QA evidence ingest for the Epic-testing
  ticket; consumes `/run-bdd-suite` output. Invoked by operators or by the
  `/epic-deliver` close-tail when an Epic-testing ticket is present.
- `helpers/epic-plan-spec.md`, `helpers/epic-plan-decompose.md` —
  phase procedures delegated to by `/epic-plan`.
- `helpers/task-execute.md` — single-Task implementation procedure read
  inline by `/story-execute` per Task (not a slash command).
- `helpers/agents-sync-config.md` — schema-driven validate-then-merge procedure
  for `.agentrc.json`, invoked by `/agents-update` after the submodule pointer
  moves (formerly shipped as `/agents-sync-config`).
- `helpers/worktree-lifecycle.md` — per-story `git worktree` isolation model,
  including node_modules strategies, Windows notes, and escape hatches. Lives
  under `helpers/` because it is operator and reviewer reference documentation,
  not an executable workflow; path-included from `story-execute.md`.

The retro is no longer a separate helper — its logic lives inline at
`lib/orchestration/retro-runner.js` and fires automatically during
`/epic-deliver` Phase 5 before the PR is opened.

## Convergence via /goal

Long-running orchestrator workflows that iterate across many turns rely on
the `/goal` directive to pin a single convergence target for the entire
run. Without it, Claude can drift between sub-goals or stall waiting for
operator re-prompting between phases.

The pattern is one line, issued before any other phase runs:

```text
/goal "<scope> <id> acceptance criteria all green"
```

The two canonical wirings are:

- **`/epic-deliver`** — Phase 0 issues `/goal "epic <epicId> acceptance
  criteria all green"` before Phase 1 (prepare). The goal stays set
  across the wave loop, close-validation, code-review, retro, finalize,
  watch-and-iterate, and auto-merge gate.
- **`/story-execute`** — Step -1 issues `/goal "story <storyId>
  acceptance criteria all green"` before Step 0 (`story-init.js`). The
  goal stays set across init, the implementation loop, and close.

When authoring a new orchestrator workflow that spans multiple phases or
turns, add an equivalent early step. Phrase the goal in terms of the
ticket-level acceptance criteria so the convergence target is the same
contract the closing gates verify.

## Adding a new workflow

1. Author `.agents/workflows/<name>.md` with a YAML frontmatter block (`name`,
   `description`).
2. Run `npm run sync:commands` — this copies the file into
   `.claude/commands/<name>.md` so it surfaces as a `/`-prefixed command.
3. Add a row to this index and (if the command is part of the canonical
   lifecycle) a reference in [`.agents/SDLC.md`](../.agents/SDLC.md).
