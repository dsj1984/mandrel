/**
 * phases/base-sync.js — pre-push base-sync phase for `single-story-close`.
 *
 * Story #2580: sync the Story branch from `origin/<baseBranch>` before
 * push so the PR opens with the latest base commits already integrated.
 * Defends against the parallel-`/single-story-deliver` race where one
 * Story's auto-merge bumps `main` while sibling Stories are mid-flight —
 * without the sync, the lagging PRs open "behind base" and stall against
 * the `up-to-date branch` protection rule.
 *
 * The sync runs INSIDE the worktree (where the Story branch is checked
 * out); falls back to the main checkout when the worktree is absent.
 * On a merge conflict the Story is transitioned to `agent::blocked` via
 * `handleSyncFailure` and the caller throws — the operator resolves in
 * the worktree and re-runs.
 */

import { syncBranchFromBase } from '../../../git/sync-from-base.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { upsertStructuredComment } from '../../ticketing/state.js';

/**
 * Orchestrate the pre-push base-sync step: run `syncBranchFromBase`
 * inside the worktree (or main checkout when no worktree exists). On
 * failure, post a friction comment, flip the Story to `agent::blocked`,
 * and throw so the caller fails non-zero. The `--skip-sync` flag is
 * handled by the caller; this function assumes the sync is desired.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   baseBranch: string,
 *   storyBranch: string,
 *   storyId: number,
 *   provider: object,
 *   injectedSync?: typeof syncBranchFromBase,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 */
export async function runBaseSyncPhase({
  cwd,
  worktreePath,
  baseBranch,
  storyBranch,
  storyId,
  provider,
  injectedSync,
  progress,
}) {
  const syncCwd = worktreePath ?? cwd;
  progress(
    'SYNC',
    `Syncing ${storyBranch} from origin/${baseBranch} in ${syncCwd}...`,
  );
  const syncFn = injectedSync ?? syncBranchFromBase;
  const syncResult = await syncFn({
    cwd: syncCwd,
    baseBranch,
    log: (tag, msg) => progress(tag, msg),
  });
  if (!syncResult.synced) {
    await handleSyncFailure({
      provider,
      storyId,
      syncCwd,
      baseBranch,
      storyBranch,
      result: syncResult,
      progress,
    });
    throw new Error(
      `[single-story-close] Base-sync failed (${syncResult.kind})` +
        (syncResult.conflictFiles
          ? `: conflicting files = ${syncResult.conflictFiles.join(', ')}`
          : syncResult.stderr
            ? `: ${syncResult.stderr.slice(0, 200)}`
            : '') +
        `. Story transitioned to ${AGENT_LABELS.BLOCKED}; resolve in ${syncCwd} and re-run \`/single-story-deliver\`.`,
    );
  }
  progress('SYNC', `✅ Synced from origin/${baseBranch} (${syncResult.kind}).`);
}

/**
 * Post a `friction` structured comment summarising a base-sync failure
 * and transition the Story to `agent::blocked`. Exported for testing.
 *
 * @param {{
 *   provider: object,
 *   storyId: number,
 *   syncCwd: string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   result: { kind: string, conflictFiles?: string[], stderr?: string },
 *   progress: (tag: string, msg: string) => void,
 * }} args
 */
export async function handleSyncFailure({
  provider,
  storyId,
  syncCwd,
  baseBranch,
  storyBranch,
  result,
  progress,
}) {
  const body = buildSyncFailureCommentBody({
    storyId,
    storyBranch,
    baseBranch,
    syncCwd,
    result,
  });

  // Post the structured comment first so the operator's recovery
  // surface lands even if the label flip fails. Both are best-effort:
  // we never want a notification-side failure to mask the real reason
  // close threw.
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
    progress('SYNC', `📝 Posted friction comment on #${storyId}.`);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ Failed to post sync-failure friction comment on #${storyId}: ${err?.message ?? err}`,
    );
  }

  try {
    await provider.updateTicket(storyId, {
      labels: {
        add: [AGENT_LABELS.BLOCKED],
        remove: [AGENT_LABELS.EXECUTING, AGENT_LABELS.READY, AGENT_LABELS.DONE],
      },
    });
    progress('SYNC', `🚧 Flipped Story #${storyId} → ${AGENT_LABELS.BLOCKED}.`);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ Failed to flip Story #${storyId} to ${AGENT_LABELS.BLOCKED}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Build the markdown body posted on a base-sync failure. Pure; exported
 * for tests so the operator-recoverable surface stays reviewable.
 *
 * @param {{ storyId: number, storyBranch: string, baseBranch: string, syncCwd: string, result: { kind: string, conflictFiles?: string[], stderr?: string } }} args
 * @returns {string}
 */
export function buildSyncFailureCommentBody({
  storyId,
  storyBranch,
  baseBranch,
  syncCwd,
  result,
}) {
  const kind = result.kind ?? 'unknown';
  const heading =
    kind === 'conflict'
      ? `Base-sync conflict on close: ${storyBranch} ↔ origin/${baseBranch}`
      : `Base-sync failed on close (${kind}): ${storyBranch} ↔ origin/${baseBranch}`;
  const fileList = (result.conflictFiles ?? []).map((f) => `- \`${f}\``);
  const lines = [
    `### ${heading}`,
    '',
    '`/single-story-deliver` close-validation passed, but the pre-push',
    `sync against \`origin/${baseBranch}\` could not complete. The Story has`,
    `been transitioned to \`agent::blocked\`. To resume:`,
    '',
    '```bash',
    `cd ${syncCwd}`,
    `git fetch origin ${baseBranch}`,
    `git merge --no-edit origin/${baseBranch}`,
    '# resolve any conflicts, then:',
    `git add -A ; git commit --no-edit`,
    '# re-run close:',
    `node .agents/scripts/single-story-close.js --story ${storyId}`,
    '```',
  ];
  if (kind === 'conflict' && fileList.length > 0) {
    lines.push('', '**Conflicting files:**', '', ...fileList);
  } else if (result.stderr) {
    lines.push(
      '',
      '**git stderr:**',
      '',
      '```',
      result.stderr.slice(0, 1000),
      '```',
    );
  }
  return lines.join('\n');
}
