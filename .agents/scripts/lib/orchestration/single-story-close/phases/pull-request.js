/**
 * phases/pull-request.js — open, reuse, or decline to open the Story's PR.
 *
 * A MERGED PR on the head is reported as the outcome, not treated as absent:
 * a resumed close whose original PR auto-merged would otherwise open a second
 * PR and squash an empty commit onto `main`. Creation is also refused on a
 * positively empty diff; an unenumerable diff fails open.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { computeChangeSet as defaultComputeChangeSet } from '../../change-set.js';
import { buildPullRequestFields } from './normalize-pr-title.js';

/**
 * OPEN wins, then the first MERGED; CLOSED-only resolves to null. A row with
 * no recognizable `state` reads as live, since guessing "no PR" opens a
 * duplicate. Module-private: a test-only export would trip dead-exports.
 *
 * @param {Array<{url?: string, state?: string, mergedAt?: string}>} rows
 * @returns {{ url: string, state: 'OPEN'|'MERGED' }|null}
 */
function pickHeadPullRequest(rows) {
  if (!Array.isArray(rows)) return null;
  let merged = null;
  for (const row of rows) {
    const url = String(row?.url ?? '').trim();
    if (!url) continue;
    const state = String(row?.state ?? '').toUpperCase();
    if (state === 'MERGED' || (state !== 'OPEN' && row?.mergedAt)) {
      merged ??= { url, state: 'MERGED' };
      continue;
    }
    if (state === 'CLOSED') continue;
    return { url, state: 'OPEN' };
  }
  return merged;
}

/**
 * Prefers `origin/<base>`: the local ref can trail by exactly the merge that
 * makes the diff empty. Unenumerable is NOT empty.
 *
 * @returns {{ empty: boolean, baseRef: string|null }}
 */
function probeEmptyDiff({ cwd, baseBranch, storyBranch, computeChangeSet }) {
  for (const baseRef of [`origin/${baseBranch}`, baseBranch]) {
    const set = computeChangeSet({ baseRef, headRef: storyBranch, cwd });
    if (!set.enumerated) continue;
    return { empty: (set.files ?? []).length === 0, baseRef };
  }
  return { empty: false, baseRef: null };
}

/**
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   storyTitle: string,
 *   storyBody?: string,
 *   storyBranch: string,
 *   baseBranch: string,
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   computeChangeSetFn?: typeof defaultComputeChangeSet,
 *   progress?: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{ url: string, alreadyMerged: boolean, created: boolean }>}
 */
export async function ensurePullRequestWith({
  cwd: _cwd,
  storyId,
  storyTitle,
  storyBody = '',
  storyBranch,
  baseBranch,
  gh = defaultGh,
  computeChangeSetFn = defaultComputeChangeSet,
  progress = () => {},
}) {
  // `gh-exec` spawns `gh` in the process cwd, not `_cwd`.
  try {
    // `--state all`, not `open`: a merged PR must be seen.
    const rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['url', 'state', 'mergedAt'],
    );
    const existing = pickHeadPullRequest(rows);
    if (existing?.state === 'OPEN') {
      progress('PR', `Reusing existing PR: ${existing.url}`);
      return { url: existing.url, alreadyMerged: false, created: false };
    }
    if (existing?.state === 'MERGED') {
      progress(
        'PR',
        `✅ PR for ${storyBranch} is already MERGED: ${existing.url} — ` +
          'reporting that outcome instead of opening a second PR.',
      );
      return { url: existing.url, alreadyMerged: true, created: false };
    }
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ \`gh pr list\` probe failed (continuing to create): ${err?.message ?? err}`,
    );
  }

  const emptyDiff = probeEmptyDiff({
    cwd: _cwd ?? process.cwd(),
    baseBranch,
    storyBranch,
    computeChangeSet: computeChangeSetFn,
  });
  if (emptyDiff.empty) {
    throw new Error(
      `[single-story-close] refusing to open a pull request for ${storyBranch}: ` +
        `the head-versus-base diff (${emptyDiff.baseRef}...${storyBranch}) contains no files. ` +
        'An empty diff has nothing to merge, and a PR opened on it can only squash an empty ' +
        'commit onto the base branch. If the work already landed, confirm the merge instead: ' +
        `node .agents/scripts/single-story-confirm-merge.js --story ${storyId}`,
    );
  }

  progress('PR', `Opening PR for ${storyBranch} → ${baseBranch}...`);
  const { title, body } = buildPullRequestFields({
    storyTitle,
    storyId,
    storyBody,
    storyBranch,
    baseBranch,
    cwd: _cwd ?? process.cwd(),
    progress,
  });
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
    return { url, alreadyMerged: false, created: true };
  } catch (err) {
    throw new Error(
      `[single-story-close] \`gh pr create\` failed: ${err?.message ?? err}`,
    );
  }
}
