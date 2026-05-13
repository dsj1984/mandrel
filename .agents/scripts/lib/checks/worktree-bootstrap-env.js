/**
 * worktree-bootstrap-env — refuse-and-print check.
 *
 * Detects active worktrees that are missing the `.env` or `.mcp.json`
 * bootstrap files. These files are intentionally untracked in git, so a
 * freshly-created worktree under `.worktrees/<story>/` does not get them
 * unless the orchestration explicitly copies them. When they are missing,
 * tests that read environment variables silently take a different code
 * path.
 *
 * Surface: `epic-deliver` preflight and the `/diagnose` CLI. Surfaced as a
 * warning rather than a blocker — the missing file may be a deliberate
 * choice (e.g. a worktree that doesn't need MCP), but the operator should
 * see the divergence from the main checkout.
 *
 * AutoCorrect is `refuse-and-print`. Copying `.env` between trees is
 * defensible at the orchestration layer (`worktree.bootstrap` step) but
 * not as a self-healing fix — the contents are project-specific and may
 * include secrets the check explicitly never reads.
 *
 * Privacy: this check reads only the bootstrap *status* projection
 * (`fs.worktreeBootstrapStatus`) which records presence per worktree, not
 * file contents. The Finding's `detail` never exposes any env-var value.
 */

const ID = 'worktree-bootstrap-env';

export default {
  id: ID,
  severity: 'warning',
  scope: ['epic-deliver', 'diagnose'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const status = state?.fs?.worktreeBootstrapStatus ?? {};
    const entries = Object.entries(status);
    if (entries.length === 0) return null;
    const missing = entries
      .map(([wtPath, files]) => {
        const missingFiles = [];
        if (!files.dotEnv) missingFiles.push('.env');
        if (!files.dotMcp) missingFiles.push('.mcp.json');
        return { wtPath, missingFiles };
      })
      .filter((entry) => entry.missingFiles.length > 0);
    if (missing.length === 0) return null;
    const detailLines = missing.map(
      (m) => `  - ${m.wtPath}: missing ${m.missingFiles.join(', ')}`,
    );
    return {
      id: ID,
      severity: 'warning',
      scope: state?.scope ?? '',
      summary: `${missing.length} worktree(s) missing bootstrap files (.env / .mcp.json)`,
      detail: [
        'Worktrees with missing bootstrap files:',
        ...detailLines,
        '',
        'Tests that read these vars will silently degrade in the affected worktrees.',
      ].join('\n'),
      fixCommand: buildFixCommand(missing),
      autoCorrectable: false,
    };
  },
};

/**
 * Build a copy recipe the operator can run from the main checkout. Each
 * missing file gets its own `cp` line targeting the affected worktree.
 *
 * @param {Array<{wtPath: string, missingFiles: string[]}>} missing
 * @returns {string}
 */
function buildFixCommand(missing) {
  const lines = [];
  for (const { wtPath, missingFiles } of missing) {
    for (const file of missingFiles) {
      lines.push(`cp "${file}" "${wtPath}/${file}"`);
    }
  }
  return lines.join(' && ');
}
