/**
 * stale-origin-epic — refuse-and-print blocker check.
 *
 * Detects the failure mode where a manual merge into `epic/<id>` landed
 * locally but the operator forgot to `git push` the epic branch before
 * re-running `story-close.js`. The close script's rebase then fights a
 * stale `origin/epic/<id>` and re-introduces a different conflict on
 * every retry.
 *
 * The check surfaces this at story-close preflight (and at retro time
 * read-only) so the operator is told to fetch + push the epic branch
 * before the close re-runs. It is `refuse-and-print` because the fix
 * is `git fetch origin` followed by `git push origin epic/<id>`; both
 * touch remote state and therefore violate the autoCorrect rules.
 *
 * Detection reads `state.git.epicBranchSync` (assembled in state.js).
 * Each entry reports `{ local, remote, ahead }` for an `epic/<id>` ref;
 * we surface the first ref whose local SHA differs from its remote SHA.
 * If the remote ref is missing entirely we return null (this is a
 * pre-push epic, not a stale one — story-close.js handles that path).
 */
export default {
  id: 'stale-origin-epic',
  severity: 'blocker',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const sync = state?.git?.epicBranchSync ?? {};
    const entries = Object.entries(sync);
    for (const [branch, info] of entries) {
      if (!info?.local || !info.remote) continue;
      if (!info.ahead) continue;
      return {
        id: 'stale-origin-epic',
        severity: 'blocker',
        scope: state?.scope ?? 'story-close',
        summary: `Local ${branch} differs from origin/${branch}; close will rebase against a stale base.`,
        detail: [
          `local  ${branch}        = ${info.local}`,
          `remote origin/${branch} = ${info.remote}`,
          'Push the epic branch (or fetch origin) before re-running story-close.',
        ].join('\n'),
        fixCommand: `git fetch origin && git push origin ${branch}`,
        autoCorrectable: false,
      };
    }
    return null;
  },
};
