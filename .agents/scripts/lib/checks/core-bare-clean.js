/**
 * Blocks on `core.bare=true` in the main checkout, which aborts close's
 * post-rebase checkout (`cleanGitEnv` is the live fix; this is the regression
 * guard). Refuse-and-print: a check must not write config outside its worktree.
 */
export default {
  id: 'core-bare-clean',
  severity: 'blocker',
  // 'npm-test' catches a poisoned shared config before a suite inherits it.
  scope: ['story-close', 'retro', 'npm-test'],
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
