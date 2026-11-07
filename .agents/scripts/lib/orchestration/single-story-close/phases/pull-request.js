/**
 * phases/pull-request.js — open, reuse, or decline to open the Story's PR.
 *
 * A MERGED PR on the head is reported as the outcome, not treated as absent:
 * a resumed close whose original PR auto-merged would otherwise open a second
 * PR and squash an empty commit onto `main`. Creation is also refused on a
 * positively empty diff; an unenumerable diff fails open.
 */

import {
  readDeferralMarker,
  rewriteDeferralLines,
} from '../../../coverage-deferral.js';
import { gh as defaultGh } from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import { computeChangeSet as defaultComputeChangeSet } from '../../change-set.js';
import { buildPullRequestFields } from './normalize-pr-title.js';

/**
 * OPEN wins, then the first MERGED; CLOSED-only resolves to null. A row with
 * no recognizable `state` reads as live, since guessing "no PR" opens a
 * duplicate. Close's landed short-circuit reads heads the same way.
 *
 * @param {Array<{url?: string, state?: string, mergedAt?: string}>} rows
 * @returns {{ url: string, state: 'OPEN'|'MERGED' }|null}
 */
export function pickHeadPullRequest(rows) {
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
 * @param {{ storyBranch: string, baseRef: string, storyId: number }} args
 * @returns {Error}
 */
function emptyDiffError({ storyBranch, baseRef, storyId }) {
  return new Error(
    `[single-story-close] refusing to open a pull request for ${storyBranch}: ` +
      `the head-versus-base diff (${baseRef}...${storyBranch}) contains no files. ` +
      'An empty diff has nothing to merge, and a PR opened on it can only squash an empty ' +
      'commit onto the base branch. If the work already landed, confirm the merge instead: ' +
      `node .agents/scripts/single-story-confirm-merge.js --story ${storyId}`,
  );
}

/**
 * A reused PR must carry this run's deferral marker, or confirm-merge skips
 * the CI ratchet. A null reason may mean "not measured", so no strip.
 */
async function syncDeferralMarker({ gh, url, body, coverageDeferred }) {
  if (!coverageDeferred || readDeferralMarker(body) === coverageDeferred) {
    return;
  }
  try {
    await gh.pr.edit(url, [
      '--body',
      rewriteDeferralLines(body, coverageDeferred),
    ]);
  } catch (err) {
    throw new Error(
      `[single-story-close] could not write \`Coverage-deferred: ${coverageDeferred}\` onto ${url}: ${err?.message ?? err}`,
    );
  }
}

/**
 * @param {{
 *   cwd: string,
 *   storyId: number,
 *   storyTitle: string,
 *   storyBody?: string,
 *   storyBranch: string,
 *   baseBranch: string,
 *   config?: object,
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   computeChangeSetFn?: typeof defaultComputeChangeSet,
 *   progress?: (tag: string, msg: string) => void,
 *   coverageDeferred?: 'over-budget'|'suite-of-record-ci'|null,
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
  config,
  gh = defaultGh,
  computeChangeSetFn = defaultComputeChangeSet,
  progress = () => {},
  coverageDeferred = null,
}) {
  // `gh-exec` spawns `gh` in the process cwd, not `_cwd`.
  let rows = [];
  let existing = null;
  try {
    // `--state all`, not `open`: a merged PR must be seen.
    rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['url', 'state', 'mergedAt', 'body'],
    );
    existing = pickHeadPullRequest(rows);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ \`gh pr list\` probe failed (continuing to create): ${err?.message ?? err}`,
    );
  }
  if (existing?.state === 'OPEN') {
    progress('PR', `Reusing existing PR: ${existing.url}`);
    const row = rows.find((r) => String(r?.url ?? '').trim() === existing.url);
    await syncDeferralMarker({
      gh,
      url: existing.url,
      body: row?.body,
      coverageDeferred,
    });
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

  const emptyDiff = probeEmptyDiff({
    cwd: _cwd ?? process.cwd(),
    baseBranch,
    storyBranch,
    computeChangeSet: computeChangeSetFn,
  });
  if (emptyDiff.empty) {
    throw emptyDiffError({ storyBranch, baseRef: emptyDiff.baseRef, storyId });
  }

  progress('PR', `Opening PR for ${storyBranch} → ${baseBranch}...`);
  const { title, body } = buildPullRequestFields({
    storyTitle,
    storyId,
    storyBody,
    storyBranch,
    baseBranch,
    cwd: _cwd ?? process.cwd(),
    config,
    progress,
    coverageDeferred,
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
