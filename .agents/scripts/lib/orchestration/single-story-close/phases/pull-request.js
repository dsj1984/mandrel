/**
 * phases/pull-request.js — open or reuse the PR for a standalone Story.
 *
 * Probes for an existing open PR with `head = storyBranch`; creates one if
 * none exists. Returns the PR URL.
 *
 * `gh pr view --head` is not available on all `gh` versions, so we probe
 * with `gh pr list --head <branch>` and fall back to `gh pr create`.
 *
 * The `gh`-spawn boundary lives here intentionally — see Story #2990 for
 * the separate refactor that moves these calls behind a `providers/github/`
 * adapter. Until that lands, the phase is the single owner of the
 * `execFileSync('gh', …)` calls for the PR open path.
 *
 * `execFileSync` is accepted as an injected dependency so the SUT's
 * cache-busted binding wins when tests mock `node:child_process`. The
 * SUT (`single-story-close.js`) statically imports `execFileSync` and
 * passes it through; direct callers (tests that import from the SUT)
 * receive the same closure shape via the parent's `ensurePullRequest`
 * wrapper.
 */

import { Logger } from '../../../Logger.js';

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
 *   execFileSync: Function,
 *   progress?: (tag: string, msg: string) => void,
 * }} args
 * @returns {string}
 */
export function ensurePullRequestWith({
  cwd,
  storyId,
  storyTitle,
  storyBranch,
  baseBranch,
  execFileSync,
  progress = () => {},
}) {
  const ghEnv = { ...process.env };
  try {
    // `gh pr list --head <branch> --state open --json url -q .[0].url`
    // returns the PR URL or an empty string when no PR matches.
    const existing = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        storyBranch,
        '--state',
        'open',
        '--json',
        'url',
        '-q',
        '.[0].url // empty',
      ],
      { cwd, encoding: 'utf8', env: ghEnv },
    ).trim();
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
  const title = storyTitle?.trim()
    ? `${storyTitle} (#${storyId})`
    : `Story #${storyId}`;
  const body = [
    `Closes #${storyId}`,
    '',
    `_Auto-opened by \`/single-story-deliver\`._`,
  ].join('\n');
  try {
    const url = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        storyBranch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd, encoding: 'utf8', env: ghEnv },
    ).trim();
    progress('PR', `✅ Opened: ${url}`);
    return url;
  } catch (err) {
    throw new Error(
      `[single-story-close] \`gh pr create\` failed: ${err?.message ?? err}`,
    );
  }
}
