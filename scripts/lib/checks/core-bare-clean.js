/**
 * core-bare-clean — refuse-and-print blocker check.
 *
 * Asserts that `git config core.bare` on the main checkout is NOT set
 * to `true`. This guards the old failure mode where an `npm test` path
 * mis-set `core.bare=true` on the main checkout, after which
 * `story-close.js`'s post-rebase `git checkout` aborted with
 * `fatal: this operation must be run in a work tree`. `cleanGitEnv`
 * already lands the live fix; this check is the regression guard.
 *
 * Severity is `blocker` because story-close cannot recover on its own
 * — the operator must run `git config --unset core.bare` (or rely on
 * `cleanGitEnv` to do it before the rebase). The check is
 * refuse-and-print: the `fixCommand` is the literal unset, and the
 * operator runs it deliberately. We do not auto-fix because mutating
 * the parent repo's git config from a check is exactly the
 * "no commits to integration branches" cousin of the autoCorrect
 * disallowed list — config writes outside the local worktree boundary.
 *
 * Detection reads `state.git.coreBare`, the string returned by
 * `git config --get core.bare` (or `null` when unset). The check fires
 * when the string is the literal `'true'`.
 */
export default {
  id: 'core-bare-clean',
  severity: 'blocker',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const coreBare = state?.git?.coreBare;
    if (coreBare !== 'true') return null;
    return {
      id: 'core-bare-clean',
      severity: 'blocker',
      scope: state?.scope ?? 'story-close',
      summary:
        'core.bare=true on main checkout; story-close post-rebase checkout will abort',
      detail: [
        'cleanGitEnv normally unsets this before the rebase. If you are',
        'seeing this surface, cleanGitEnv did not run (e.g. a pre-fix code',
        'path) or the value was re-set after it ran. Unset it manually and',
        're-run the close.',
      ].join('\n'),
      fixCommand: 'git config --unset core.bare  # or rely on cleanGitEnv',
      autoCorrectable: false,
    };
  },
};
