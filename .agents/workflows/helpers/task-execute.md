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

2. **Implement the changes strictly within Story scope.** Edit only files that
   the Task instructions require. Do not opportunistically refactor unrelated
   modules — sibling Tasks in the same Story may be touching them, and you
   are not the only writer on this branch's history. Out-of-scope cleanups
   belong in a follow-on ticket.

3. **Stage with explicit paths.** Prefer `git add <path/one> <path/two>` over
   `git add -A` so accidental edits (lockfiles, generated artifacts, scratch
   files) do not leak into the commit. `git add -u` is acceptable when you
   only modified files you intended to commit.

4. **Guard the branch before committing.** Even inside an isolated worktree,
   keep the assert-branch guard — it's cheap defense-in-depth against drift
   from a `git checkout` buried inside a tool script:

   ```powershell
   node .agents/scripts/assert-branch.js --expected story-<storyId> --cwd .
   ```

   If the guard fails, **STOP** and surface the drift to the caller — do not
   force the commit through. A wrong-branch commit corrupts the Story's
   linear history and breaks `story-close.js` merge replay.

5. **Commit with conventional-commit format.**

   ```powershell
   git commit -m "<type>(<scope>): <task title> (resolves #<taskId>)"
   ```

   - `<type>` — `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
     `perf`, `build`, `ci`, `style`, or `revert`. Match the dominant nature of
     the change; when in doubt, prefer `feat` for new behavior and `refactor`
     for behavior-preserving moves.
   - `<scope>` — a short symbolic scope (module name, area, or sub-system).
     Optional but encouraged when the touched area is identifiable in one
     token.
   - `<task title>` — the Task ticket's title verbatim, lowercased and
     trimmed of redundant prefixes.
   - `(resolves #<taskId>)` — required. The parent Story's `cascadeCompletion`
     reads this trailer to confirm closure intent.

6. **Verify the commit landed on the expected branch.** `git log -1
   --pretty=%H%n%s` should show the new SHA on top of `story-<storyId>`. If
   the commit hash differs from your expectation (e.g. an empty-tree no-op or
   a hook-rewrite), re-read what the hook did before proceeding to the next
   Task.

7. **Return control to `/story-execute`** so it can record the per-Task
   transition in the `story-run-progress` structured comment and move to the
   next Task in dependency order.

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
