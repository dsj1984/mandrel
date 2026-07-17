/**
 * worktree-residue-biome — refuse-and-print check.
 *
 * Detects partial-reap residue under `.worktrees/` where a previous Story's
 * tree was deleted incompletely and left a nested `biome.json` behind. The
 * root `npm run lint` walks into the orphan tree, hits the nested config,
 * and fails. The close-time biome block is the canonical symptom.
 *
 * Surface: `story-close` preflight, the `/diagnose` CLI, and retro.
 * Surfaced as a blocker so the operator clears the residue
 * with `rm -rf` before close re-runs the validation chain.
 *
 * AutoCorrect is `refuse-and-print`. Recursive deletion under `.worktrees/`
 * is technically blessed by the README, but the residue may include
 * partially-merged work the operator wants to inspect first. We print the
 * exact `rm -rf` recipe rather than running it.
 */

const ID = 'worktree-residue-biome';

export default {
  id: ID,
  severity: 'blocker',
  scope: ['story-close', 'diagnose', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const orphans = state?.fs?.worktreeBiomeOrphans ?? [];
    if (!Array.isArray(orphans) || orphans.length === 0) return null;
    const lines = orphans.map((p) => `  - ${p}`).join('\n');
    return {
      id: ID,
      severity: 'blocker',
      scope: state?.scope ?? '',
      summary: `${orphans.length} orphan worktree(s) with nested biome.json — root biome lint will fail`,
      detail: `Nested biome.json files found under .worktrees/ subdirectories:\n${lines}\n\nThese block root \`npm run lint\` because biome walks into them and resolves the nested config.`,
      fixCommand: buildFixCommand(orphans),
      autoCorrectable: false,
    };
  },
};

/**
 * Build the `rm -rf` command(s) the operator should run to clear the
 * residue. Multiple orphans get a single chained command so it can be
 * copy-pasted as one line.
 *
 * @param {string[]} orphans
 * @returns {string}
 */
function buildFixCommand(orphans) {
  if (orphans.length === 0) return '';
  // Each path is already an absolute orphan worktree directory; deleting
  // the whole directory is the canonical reap recipe.
  return orphans.map((p) => `rm -rf "${p}"`).join(' && ');
}
