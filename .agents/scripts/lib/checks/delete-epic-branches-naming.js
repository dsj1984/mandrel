/**
 * delete-epic-branches-naming — refuse-and-print warning check.
 *
 * The `delete-epic-branches.js` cleanup script's regex expects nested
 * story branches of the shape `story/epic-<id>/<n>`. The
 * `feedback_delete_epic_branches_naming.md` note documents the failure
 * mode where the flat naming `story-NNNN` is created instead and never
 * cleaned up — the branch leaks across epic closures and accumulates
 * in `git branch -a` output.
 *
 * This check fires when one or more local branches matches the literal
 * pattern `^story-\d+$`. It is a `warning` rather than a `blocker`
 * because the residue does not actively break story-close — it just
 * leaks branches. The `fixCommand` lists the exact branches the
 * operator can `git branch -D` to clear the residue.
 *
 * Detection reads `state.git.localBranches`, the array of short branch
 * names assembled by state.js.
 */

const FLAT_STORY_NAME = /^story-\d+$/;

export default {
  id: 'delete-epic-branches-naming',
  severity: 'warning',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const branches = state?.git?.localBranches ?? [];
    const flat = branches.filter((b) => FLAT_STORY_NAME.test(b));
    if (flat.length === 0) return null;
    return {
      id: 'delete-epic-branches-naming',
      severity: 'warning',
      scope: state?.scope ?? 'story-close',
      summary: `${flat.length} local branch(es) match flat story-NNNN naming and will be missed by delete-epic-branches.js`,
      detail: [
        'Flat-named branches (matched):',
        ...flat.map((b) => `  - ${b}`),
        '',
        'delete-epic-branches.js only matches the nested story/epic-<id>/<n>',
        'form. Delete the flat names manually with the fixCommand below.',
      ].join('\n'),
      fixCommand: `git branch -D ${flat.join(' ')}`,
      autoCorrectable: false,
    };
  },
};
