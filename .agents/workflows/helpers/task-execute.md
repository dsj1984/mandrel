# Task Execution — Inline Helper

Procedural module read **inline per Task** by [`/story-execute`](../story-execute.md).
This is **not** a slash command — there is no `/task-execute` registration in
`.claude/commands/`. The Story skill loads this file once per child Task in
its sequential loop.

## Procedure

1. **Read the Task ticket's `## Instructions` section in full.** Treat the
   instructions as authoritative scope. If the description is ambiguous, prefer
   the narrowest reasonable interpretation that still satisfies the acceptance
   criteria of the parent Story; **do not** ask the operator clarifying
   questions when running as a sub-agent (the parent has no input channel).
   This is the same constraint stated from the meta-skill side under the
   "Sub-agent exception" clause in
   [`.agents/skills/core/using-agent-skills/SKILL.md`](../../skills/core/using-agent-skills/SKILL.md) —
   read both together.

2. **Implement the changes strictly within Story scope.** Edit only files that
   the Task instructions require. Do not opportunistically refactor unrelated
   modules — sibling Tasks in the same Story may be touching them, and you
   are not the only writer on this branch's history. Out-of-scope cleanups
   belong in a follow-on ticket.

3. **Run the diff-scoped quality preview before staging.** Invoke
   [`npm run quality:preview`](../../../package.json) (which runs
   `quality-preview.js --changed-since HEAD` against the same maintainability
   and CRAP engines that `check-baselines.js` enforces at merge time) while
   the change is still warm in working memory. A clean preview means the
   unified baselines gate will not bounce the merge. Respond to the output per
   [`code-quality-guardrails.md`](code-quality-guardrails.md) — flagged
   findings (cyclomatic > 8, MI drop > 1.5pt) get a one-line review note;
   must-fix findings (cyclomatic > 12) get refactored before
   `task-commit.js` runs.

4. **Stage, guard, commit, and verify in one CLI call.** Hand the work to
   `task-commit.js`, which asserts the branch (`story-<storyId>`), stages the
   listed paths (or falls back to `git add -u`), runs the conventional-commit
   formatter, and re-asserts the branch after the hooks return:

   ```bash
   node .agents/scripts/task-commit.js \
     --story <storyId> --task <taskId> \
     --type <feat|fix|refactor|docs|test|chore|perf|build|ci|style|revert> \
     [--scope <scope>] --title "<task title>" \
     [--paths <p1> <p2> ...]
   ```

   <!-- # justification: prose rule prohibiting --no-verify, not a code example. -->
   - The CLI never passes `--no-verify` — commit hooks are intentional
     defense-in-depth and must run.
   - Output is `{ sha, branch, subject }`. Capture `sha` so
     `/story-execute` can record it on the next `story-run-progress` write.
   - If the CLI exits non-zero (branch drift, hook failure, empty diff),
     **STOP**. Do not retry by skipping hooks. Surface the failure to the
     caller.

## Merge conflicts

If any commit triggers a rebase that pauses on conflicts, follow the canonical
procedure in [`_merge-conflict-template.md`](_merge-conflict-template.md). Do
not bulk-accept one side without reading the deltas first.

## Constraints

- **Never** push the Story branch directly to `main`. The parent `story-close`
  is the only writer that integrates Story work upstream (and only into
  `epic/<epicId>`, never `main`).
- **Never** `git checkout` to another branch inside the Task loop. The
  worktree's HEAD is the Story branch by construction; leave it pinned.
<!-- # justification: prose rule prohibiting --no-verify, not a code example. -->
- **Never** skip commit hooks (`--no-verify`, `--no-gpg-sign`). The hooks
  are the same ones the close-validation chain runs — bypassing them just
  defers the failure to merge time.
- **Always** make one commit per Task. Squashing multiple Tasks into a single
  commit breaks the per-Task closure cascade and obscures bisect history.
- **Always** keep the Task scope strict. If implementation reveals a missing
  prerequisite, post a `friction` comment on the Task and the parent Story
  rather than silently widening scope.
