/**
 * phases/auto-merge.js — enable GitHub native auto-merge on the PR.
 *
 * Mirrors the call in `epic-deliver-finalize.js`: squash strategy, delete
 * the branch on merge. Non-fatal — returns `{ enabled: false, reason }`
 * on any failure so the caller can fall back to the operator-merges-button
 * path.
 *
 * The `gh`-spawn boundary lives here intentionally — see Story #2990 for
 * the separate refactor that moves these calls behind a `providers/github/`
 * adapter.
 *
 * `execFileSync` is accepted as an injected dependency so the SUT's
 * cache-busted binding wins when tests mock `node:child_process`. The
 * SUT (`single-story-close.js`) statically imports `execFileSync` and
 * wraps these primitives so external callers (tests) hit the live mock.
 */

/**
 * Enable GitHub native auto-merge on the PR. Non-fatal.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number,
 *   execFileSync: Function,
 *   runner?: (args: string[], opts: object) => { status: number, stdout?: string, stderr?: string },
 * }} opts
 * @returns {{ enabled: boolean, reason?: string }}
 */
export function enableAutoMergeWith({ cwd, prNumber, execFileSync, runner }) {
  const exec = runner ?? makeDefaultGhAutoMergeRunner(execFileSync);
  try {
    const result = exec(
      [
        'pr',
        'merge',
        String(prNumber),
        '--auto',
        '--squash',
        '--delete-branch',
      ],
      { cwd },
    );
    if (result.status === 0) return { enabled: true };
    return {
      enabled: false,
      reason: `gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`,
    };
  } catch (err) {
    return { enabled: false, reason: `gh-spawn-error: ${err?.message ?? err}` };
  }
}

function makeDefaultGhAutoMergeRunner(execFileSync) {
  return function defaultGhAutoMergeRunner(args, { cwd }) {
    try {
      const stdout = execFileSync('gh', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: typeof err.status === 'number' ? err.status : 1,
        stdout: err.stdout?.toString?.() ?? '',
        stderr: err.stderr?.toString?.() ?? String(err?.message ?? err),
      };
    }
  };
}

/**
 * Dispatch auto-merge enablement based on `--no-auto-merge`, an
 * unparseable PR number, or a `gh` failure. Returns the structured
 * `{ autoMergeEnabled, autoMergeReason }` pair the result envelope needs.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number|null,
 *   prUrl: string,
 *   noAutoMerge: boolean,
 *   execFileSync: Function,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {{ autoMergeEnabled: boolean, autoMergeReason: string|null }}
 */
export function runAutoMergePhase({
  cwd,
  prNumber,
  prUrl,
  noAutoMerge,
  execFileSync,
  progress,
}) {
  if (noAutoMerge) {
    progress('PR', '⏭  Auto-merge disabled (--no-auto-merge).');
    return { autoMergeEnabled: false, autoMergeReason: 'disabled-by-flag' };
  }
  if (prNumber == null) {
    progress(
      'PR',
      `⚠️ Auto-merge skipped: could not parse PR number from URL ${prUrl}.`,
    );
    return {
      autoMergeEnabled: false,
      autoMergeReason: 'pr-number-unparseable',
    };
  }
  const result = enableAutoMergeWith({ cwd, prNumber, execFileSync });
  if (result.enabled) {
    progress(
      'PR',
      `✅ Auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
    );
    return { autoMergeEnabled: true, autoMergeReason: null };
  }
  progress(
    'PR',
    `⚠️ Auto-merge enablement failed (${result.reason}) — operator can merge manually.`,
  );
  return { autoMergeEnabled: false, autoMergeReason: result.reason };
}
