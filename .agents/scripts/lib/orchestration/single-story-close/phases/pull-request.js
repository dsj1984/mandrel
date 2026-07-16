/**
 * phases/pull-request.js — open or reuse the PR for a standalone Story.
 *
 * Probes for an existing open PR with `head = storyBranch`; creates one if
 * none exists. Returns the PR URL.
 *
 * `gh pr view --head` is not available on all `gh` versions, so we probe
 * with `gh pr list --head <branch>` and fall back to `gh pr create`.
 *
 * Story #2990 routed the underlying `gh pr list` / `gh pr create` calls
 * through the `lib/gh-exec.js` facade (the same shim the
 * `providers/github/` gateways use) so this phase inherits the typed
 * error classification, timeout handling, and JSON parsing surface
 * instead of carrying its own `execFileSync('gh', …)` plumbing.
 *
 * The function still accepts an injected `gh` facade so tests can wire
 * a fake without spawning real children.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { normalizePrTitle } from './normalize-pr-title.js';

/**
 * Probe for an existing open PR with `head = storyBranch`; create one if
 * none exists. Returns the PR URL. Exported for testing.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   storyTitle: string,
 *   storyBranch: string,
 *   baseBranch: string,
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   progress?: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<string>}
 */
export async function ensurePullRequestWith({
  cwd: _cwd,
  storyId,
  storyTitle,
  storyBranch,
  baseBranch,
  gh = defaultGh,
  progress = () => {},
}) {
  // `cwd` is preserved on the call signature for backwards compatibility
  // with the SUT's thin wrapper, but `gh-exec` spawns `gh` against the
  // current process cwd. `single-story-close.js` chdirs into the worktree
  // before invoking the phase, so the effective cwd matches the legacy
  // `execFileSync('gh', …, { cwd })` shape.
  try {
    // `gh pr list --head <branch> --state open --json url` returns a
    // JSON array of `{ url }` rows; an empty array means no open PR on
    // this head. We pick the first entry's URL (matching the legacy
    // `-q '.[0].url // empty'` projection on our side) so the typed
    // `gh.pr.list` facade can stay generic.
    const rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'open'],
      ['url'],
    );
    const existing =
      Array.isArray(rows) && rows.length > 0
        ? String(rows[0]?.url ?? '').trim()
        : '';
    if (existing) {
      progress('PR', `Reusing existing PR: ${existing}`);
      return existing;
    }
  } catch (err) {
    // `gh pr list` failure is recoverable — fall through to create. Log
    // the error so an auth issue surfaces visibly.
    Logger.warn?.(
      `[single-story-close] ⚠️ \`gh pr list\` probe failed (continuing to create): ${err?.message ?? err}`,
    );
  }

  progress('PR', `Opening PR for ${storyBranch} → ${baseBranch}...`);
  // The repo squash-merges and GitHub uses the PR title as the squash
  // subject on `main`. A raw human issue title is not a Conventional
  // Commit, so release-please silently counts it as 0 releasable commits
  // (Story #3969). Normalize the title to conventional form: preserve an
  // already-conventional `storyTitle` verbatim, otherwise synthesize a
  // type derived from the branch's own commit subjects (default `chore`).
  // `gh-exec` spawns `gh` against the current process cwd (the worktree),
  // so the branch-commit read uses the same cwd.
  const title = normalizePrTitle({
    storyTitle,
    storyId,
    storyBranch,
    baseBranch,
    cwd: _cwd ?? process.cwd(),
  });
  const body = [
    `Closes #${storyId}`,
    '',
    `_Auto-opened by \`/deliver\`._`,
  ].join('\n');
  try {
    const createResult = await gh.pr.create([
      '--base',
      baseBranch,
      '--head',
      storyBranch,
      '--title',
      title,
      '--body',
      body,
    ]);
    const url = (createResult?.stdout ?? '').trim();
    progress('PR', `✅ Opened: ${url}`);
    return url;
  } catch (err) {
    throw new Error(
      `[single-story-close] \`gh pr create\` failed: ${err?.message ?? err}`,
    );
  }
}
