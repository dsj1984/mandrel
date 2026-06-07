# Workflow (Slash-Command) Reference Index

This is a **reference index** of every slash-command skill shipped under
`.agents/workflows/`. The canonical workflow narrative lives in
[`.agents/SDLC.md`](../.agents/SDLC.md) — read that first to understand how the
commands compose. This file is only for "which command does X?" lookups.

Every command file lives at `.agents/workflows/<name>.md` and is projected into
a flat `.claude/commands/` tree by `npm run sync:commands` (the UserPromptSubmit
hook keeps it current) so it shows up as a bare `/<name>` slash command (e.g.
`/epic-deliver`). The projection writes only `.claude/commands/<name>.md` —
there is no plugin manifest and no marketplace listing. The commands load in
every Claude Code environment. The #3576 plugin cutover (which namespaced
commands as `/mandrel:<name>`) was reverted because the plugin system
(`/plugin`) is unavailable in some Claude Code environments, leaving namespaced
commands unreachable; the flat `.claude/commands/` projection loads everywhere.

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
| `/epic-plan`                      | Ideation mode (no args) — sharpen a raw idea, search for duplicates, create the Epic, then run PRD + Tech Spec + decomposition.                    |
| `/epic-plan --idea "<seed>"`      | Same ideation entry with a pre-supplied seed.                                                                                                      |
| `/epic-plan <epicId>`             | Existing-Epic mode — generate PRD + Tech Spec + decomposition for an Epic ticket that has already been opened.                                     |
| `/epic-deliver <epicId>`          | Six-phase wave-loop + close-validation + code-review + retro + finalize. Terminates with a PR open against `main`; operator merges via GitHub UI.  |
| `/story-deliver <storyId>`        | Init → Story-implementation phase → close for one Story. Used directly when re-driving a single Story off-table. |

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

## QA workflows

Two complementary QA loops. `/qa-explore` is the **open-ended, exploratory**
sweep (the agent probes a named surface, captures observations into a session
ledger, then triages them); `/qa-run-harness` is its **automated complement**
(the agent steps a known set of Gherkin `.feature` scenarios through a real
browser). Both adopt the `qa-engineer` persona and resolve the consumer's
`qa.*` project-contract block from `.agentrc.json` via
[`resolve-qa-contract.js`](../.agents/scripts/lib/qa/resolve-qa-contract.js)
before they touch the surface — the resolver fails **loudly** when the project
has not bound the harness, with no silent fallback.

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/qa-explore <surface>`   | Human-in-the-loop **Plan → Capture → Triage** exploratory-QA loop over a named surface. Capture is strictly read-only; each observation is appended as a `QaLedgerItem` to the session ledger under `temp/qa/<sessionId>.ndjson`. Triage classifies, dedups, and routes each item into a `file` / `defer` / `dismiss` disposition — every phase transition and every ticket-filing write is operator-gated. Cites `/qa-run-harness` as the scripted-scenario complement. |
| `/qa-run-harness <selector>` | Drive a selected set of Gherkin scenarios through a real browser as an agent-driven QA sweep, emitting a sweep summary and structured `F#` findings (consumed by the `epic-testing.md` helper). |

The `temp/qa/` ledger is session scratch under `project.paths.tempRoot` — it is
one `QaLedgerItem` per ndjson line, gitignored per
[`.agents/instructions.md` § 6](../.agents/instructions.md), and **never**
committed. A resumed session (`--session-id <id>`) appends and carries its
un-triaged backlog forward; it never overwrites a prior ledger. The
`/qa-explore` procedure, ledger contract, and helper seams
(`.agents/scripts/lib/qa/` + `.agents/scripts/lib/findings/`) are documented in
[`workflows/qa-explore.md`](../.agents/workflows/qa-explore.md); the
`/qa-run-harness` run pipeline, the `qa` contract fields, and the `F#` finding
shape are in
[`architecture.md` § Agent-driven QA harness](architecture.md#agent-driven-qa-harness).
Consumer adoption steps are in
[`.agents/README.md` § Adopting the QA harness](../.agents/README.md#adopting-the-qa-harness).

## Git operations

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/git-commit-all`         | Commit all outstanding changes to the current branch.                         |
| `/git-push`               | Commit all outstanding changes and push to the remote.                        |
| `/git-merge-pr`           | Analyze, validate, resolve conflicts, and merge a given pull request.         |

## Comprehension

| Command                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/explain [PR# \| branch \| --staged]` | Walk the operator through a code change until they understand it — problem, why, design decisions, edge cases, blast radius. Drives the `core/knowledge-transfer` skill (restate-first, why-ladder, mastery gates, persistent checklist) with an operator-controlled stop at every checkpoint. The same engine runs over a *plan* at `/epic-plan` Phase 11. |

## Setup & meta

| Command                    | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node .agents/scripts/bootstrap.js` | One-shot consumer setup: wires the local harness (`.claude/commands/` sync hook, `package.json` scripts, hooks, gitignore, Windows git-perf check) **and** initializes the GitHub repo (label taxonomy, project fields, default Kanban board, branch protection when enabled). Not a slash command — runs deterministically with interactive prompts on a TTY and flag-driven non-interactive runs in CI. |
| `/agents-update`            | Upgrade the installed `@mandrelai/agents` package via the `mandrel update` CLI (bump → sync → migrate → doctor), reconcile `.agentrc.json` against the new defaults, and refresh the Claude Code `.claude/commands/` surface. |
| `/drain-pending-cleanup`    | Reap any orphan `.worktrees/` residue and prune stale story / epic branches in one pass.                        |

## Internal / reference-only

Not invoked directly by operators, but referenced from other workflows:

- `helpers/_merge-conflict-template.md` — canonical procedure for resolving a
  merge conflict, included by reference from `story-deliver`, `epic-deliver`,
  and `git-merge-pr`.
- `helpers/epic-code-review.md` — comprehensive code-review procedure,
  auto-invoked by `/epic-deliver` Phase 4 (close-tail). Findings persist as
  a `code-review` structured comment on the Epic ticket.
- `helpers/epic-testing.md` — QA evidence ingest for the Epic-testing
  ticket; consumes `/qa-run-harness` output. Invoked by operators or by the
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
2. Run `npm run sync:commands` — this projects the file into the flat
   `.claude/commands/<name>.md` tree so it surfaces as a `/<name>` command.
   Never hand-edit the generated tree; it carries the `<!-- AUTO-GENERATED -->`
   header and is regenerated idempotently.
3. Add a row to this index (showing the `/<name>` invocation) and (if
   the command is part of the canonical lifecycle) a reference in
   [`.agents/SDLC.md`](../.agents/SDLC.md).
