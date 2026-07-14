# Merge Conflict Resolution — Shared Procedure

Canonical, workflow-agnostic procedure for resolving merge / rebase conflicts.
Referenced by `deliver.md` and `helpers/deliver-story.md`.

## Procedure

1. **Identify conflicting files.**

   ```powershell
   git diff --name-only --diff-filter=U
   ```

2. **For each conflicting file**, open it and read both conflict sides in full:
   - The `<<<<<<< HEAD` block — content from the branch you are merging _into_
     (or the rebase target).
   - The `>>>>>>> <incoming>` block — content from the branch you are merging
     _in_ (or the commit being replayed).

3. **Resolve**, in order of preference:
   - **Apply both changes** when they are logically compatible (e.g. two
     additions to the same list, two new helpers in the same module). This is
     the default when the two sides touch disjoint responsibilities.
   - **Choose a single side** only when the two sides are genuinely mutually
     exclusive. Document the rationale in your commit message or in an inline
     comment — "chose incoming because it updates the API signature both sides
     assume" is enough; silent choices are not.
   - **Never silently drop code.** If neither side can be preserved, raise the
     conflict to the operator with both sides quoted before making a destructive
     choice.

4. **Stage the resolved files** and continue the operation:

   ```powershell
   git add <resolved/path/one> <resolved/path/two>
   # Rebase path:
   git rebase --continue
   # Merge path:
   git commit    # if the merge was paused for manual resolution
   ```

5. **Repeat** until the rebase / merge completes cleanly.

## Constraint

- Do not bulk-accept one side (`git checkout --ours` / `--theirs`) without
  reading the deltas first. These shortcuts are the easiest way to lose
  legitimate work.
- Do not use `--no-verify` to bypass commit hooks around a conflict resolution —
  the hooks are there to catch resolutions that reintroduce syntax errors or
  broken formatting.
- If the same file conflicts repeatedly across successive rebase steps, stop and
  re-evaluate — you may be resolving the same hunk inconsistently across
  rewrites. `git rebase --abort` is a valid escape hatch.
