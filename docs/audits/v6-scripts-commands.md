# v6 Scripts & Commands Surface Audit

**Audit snapshot:** 2026-05-12
**Story:** #1601 (Epic F #1184)
**Method:** repo-wide `rg` cross-reference of every `.agents/scripts/*.js` basename
against `.agents/workflows/`, `.claude/commands/`, `tests/`, `.github/workflows/`,
`package.json`, `.husky/`, and other `.agents/scripts/*.js` callers, excluding
`baselines/`, `temp/`, `docs/archive/`, `node_modules/`, and `.git`. Reference
counts ignore self-references (the script's own file) and stale historical
mentions in baseline ratchet artifacts.

## Scope inventoried

- `.agents/scripts/*.js` — 68 top-level scripts (excludes `lib/`).
- `.claude/commands/*.md` — 33 slash commands (auto-generated mirror of
  `.agents/workflows/*.md`; `sync-claude-commands.js` is sole writer).
- `.agents/workflows/*.md` — 33 top-level workflows; `helpers/` subdirectory is
  intentionally not synced.

## Catalog parity

The `.claude/commands/` set and `.agents/workflows/` (top-level) set are
identical after sync (`comm -3` of basename lists is empty). No broken or
orphaned commands. Helpers under `.agents/workflows/helpers/` are correctly
excluded by `sync-claude-commands.js`'s `isTopLevelWorkflow` filter.

## Removals — scripts

| Script | Status | Rationale |
| --- | --- | --- |
| `.agents/scripts/handle-approval.js` | **Delete** | Orphaned `/approve` / `/approve-audit-fixes` webhook listener. No CI wiring (`.github/workflows/**` does not invoke it), no caller in `.agents/scripts/` or `.agents/workflows/`, no test under `tests/`. Only references were a one-line description in `.agents/SDLC.md` and a row in `.agents/scripts/lib/orchestration/README.md` — both pointing at a feature that was never plumbed end-to-end. The auto-approval flow it represents has not been adopted; the human-approve-PR path is the only live one. |

Companion doc edits (same commit):

- `.agents/SDLC.md` — drop the `/approve` / `handle-approval.js` bullet from
  the auto-fixing section so the SDLC narrative reflects the live surface.
- `.agents/scripts/lib/orchestration/README.md` — drop the `handle-approval.js`
  row from the script catalog table.

## Removals — commands

None. Every `.claude/commands/*.md` has a corresponding tracked workflow source
file, and every workflow is sourced from a tracked file in `.agents/workflows/`.
The catalog is already lean.

## Retentions worth noting

Every other script in `.agents/scripts/` has at least one live reference path:

- **Bootstrap / lifecycle:** `single-story-init`, `single-story-close`,
  `story-init`, `story-close`, `story-execute-prepare`, `story-task-progress`,
  `task-commit`, `epic-close`, `epic-deliver-*` (5 files), `epic-execute-record-wave`,
  `epic-plan*` (5 files), `epic-reconcile`, `wave-gate`, `wave-tick` — wired
  from corresponding workflow under `.agents/workflows/`.
- **Quality gates:** `check-coverage-baseline`, `check-crap`,
  `check-maintainability`, `coverage-capture`, `quality-preview`,
  `quality-watch`, `run-coverage`, `update-coverage-baseline`,
  `update-crap-baseline`, `update-maintainability-baseline`, `lint-baseline`,
  `loc-delta` — wired from `package.json` scripts, `.husky/pre-push`,
  and `code-quality-guardrails.md` workflow helper.
- **Catalog / sync:** `sync-claude-commands` — `package.json` scripts hook;
  `update-self` — invoked by `agents-update` workflow; `update-ticket-state` —
  MCP fallback documented in `story-execute.md` and `single-story-execute.md`.
- **Audit suite:** `audit-orchestrator`, `run-audit-suite`, `select-audits`,
  `epic-code-review` — wired from `audit-*` and `epic-deliver` workflows.
- **Diagnostics / signals:** `analyze-execution`, `diagnose`,
  `diagnose-friction`, `signals-view`, `noise-study`, `validate-docs-freshness`,
  `check-windows-git-perf`, `retrofit-task-bodies`, `render-manifest` —
  wired from corresponding workflow or used during epic-deliver phases.
- **Branch hygiene:** `delete-epic-branches`, `git-cleanup-branches`,
  `git-pr-quality-gate`, `git-rebase-and-resolve`, `detect-merges`,
  `assert-branch`, `branch-name-guard` (in `lib/`), `drain-pending-cleanup`,
  `epic-deliver-cleanup`, `epic-deliver-note-intervention` — wired from
  `git-*` and `epic-deliver*` workflows.
- **Context / providers:** `context-hydrator`, `hydrate-context`,
  `hierarchy-gate`, `dispatcher`, `evidence-gate`, `notify`,
  `post-structured-comment`, `test-wrapper`, `epic-plan-edit-flow` (called
  by `epic-plan.js`) — internal callers under `.agents/scripts/`.

## Wiring conventions reaffirmed (no code changes)

- `.agents/workflows/` is the source of truth; `.claude/commands/` is a
  generated mirror. Editing under `.claude/commands/` directly is a bug.
- `sync-claude-commands.js` only mirrors top-level `.md` files; `helpers/`
  subdirectory is intentional and stays out of the `/` menu. This audit
  validated that filter is correctly implemented.

## Next-Story follow-ups (not in scope here)

- Companion Task #1620 codifies the naming + recategorization matrix in
  `docs/decisions.md` and moves `worktree-lifecycle.md` into
  `.agents/workflows/helpers/`. After that move, the next `npm run
  sync:commands` will drop `.claude/commands/worktree-lifecycle.md` from
  the catalog automatically — no manual command-file deletion needed.
- Companion Task #1619 lands `.agents/workflows/mandrel.md` and walks
  every workflow's `description:` frontmatter for `/` menu legibility.
