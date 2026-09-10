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
 *
 * Story #5267: a sync that lands tracked content also spends the worker's
 * pre-push full-suite capture stamp, because that stamp is keyed on the
 * tree. The phase now says so out loud — see
 * `buildStampInvalidatedWarning` — instead of leaving close's second full
 * suite looking like a bug.
 */

import { syncBranchFromBase } from '../../../git/sync-from-base.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';

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
 *   baseConfirmed?: boolean,
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
  baseConfirmed = false,
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
      baseConfirmed,
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
        `. Story transitioned to ${AGENT_LABELS.BLOCKED}; resolve in ${syncCwd} and re-run \`/mandrel-deliver ${storyId}\`.`,
    );
  }
  progress('SYNC', `✅ Synced from origin/${baseBranch} (${syncResult.kind}).`);
  for (const line of buildStampInvalidatedWarning({
    baseBranch,
    result: syncResult,
  })) {
    progress('SYNC', line);
  }
}

/**
 * How many changed paths the warning names before it stops listing.
 * Enough to recognise the change set; short enough that the warning still
 * reads as a warning rather than as a diff.
 */
const WARNED_PATH_LIMIT = 12;

/**
 * The loud "your capture stamp is spent" warning, or `[]` when the sync
 * changed nothing (Story #5267).
 *
 * The worker deposits ONE creditable full-suite stamp, keyed on the tree it
 * ran against. This sync runs after that, and when it brings tracked content
 * in it moves the tree out from under the stamp: close's `test` / `coverage`
 * gates find no credit and pay for a second full suite. That is correct
 * behaviour and not something to suppress — the defect was that it happened
 * silently, so the operator read a doubled close as a mystery rather than as
 * the base moving.
 *
 * Quiet by construction on the outcomes that cannot have spent it: a
 * `noop-already-current` sync never touched the tree, and a fast-forward or
 * merge that brought no tracked path in left the stamp's tree intact. A
 * content-changing fast-forward DOES warn — it invalidates the stamp exactly
 * as a merge commit does, and staying quiet there would be a lie of omission.
 *
 * Pure. Module-private: the phase is the seam tests drive it through
 * (`injectedSync` + a `progress` spy), so it needs no export of its own.
 *
 * @param {{ baseBranch: string, result: { kind?: string, changedPaths?: string[] } }} args
 * @returns {string[]} Progress lines, in order. Empty when nothing changed.
 */
function buildStampInvalidatedWarning({ baseBranch, result }) {
  const changed = Array.isArray(result?.changedPaths)
    ? result.changedPaths
    : [];
  if (changed.length === 0) return [];
  const shown = changed.slice(0, WARNED_PATH_LIMIT);
  const overflow = changed.length - shown.length;
  return [
    `⚠️  BASE MOVED: the ${result?.kind ?? 'sync'} from origin/${baseBranch} ` +
      `brought ${changed.length} tracked path(s) into this branch, so the tree ` +
      `is no longer the one the pre-push full-suite capture was stamped ` +
      `against. That stamp cannot be credited; the gates below will re-run the ` +
      `suite against the merged tree. This is expected, not a fault.`,
    ...shown.map((f) => `⚠️    ${f}`),
    ...(overflow > 0 ? [`⚠️    …and ${overflow} more`] : []),
  ];
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
 *   baseConfirmed?: boolean,
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
  baseConfirmed = false,
  storyBranch,
  result,
  progress,
}) {
  const body = buildSyncFailureCommentBody({
    storyId,
    storyBranch,
    baseBranch,
    baseConfirmed,
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

  // Story #4539 — the canonical mutator, not a direct label write: a bare
  // `provider.updateTicket` skips the Projects v2 column sync (Story
  // #2548) and strands the board on the Story's prior status.
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
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
 * Story #4891 — `baseConfirmed` gates the merge-the-base recovery block, and
 * defaults to `false` so it fails closed. Telling the operator to run
 * `git merge origin/<baseBranch>` is actively harmful when `<baseBranch>` is
 * not the base the Story was seeded from: it permanently contaminates the
 * branch and its PR diff with an unrelated base. Close confirms the base
 * against the run's `story-init` receipt before that advice is emitted; when
 * it could not (receipt absent, unreadable, or unpinned), the operator is
 * told to establish the real base first instead.
 *
 * @param {{ storyId: number, storyBranch: string, baseBranch: string, baseConfirmed?: boolean, syncCwd: string, result: { kind: string, conflictFiles?: string[], stderr?: string } }} args
 * @returns {string}
 */
export function buildSyncFailureCommentBody({
  storyId,
  storyBranch,
  baseBranch,
  baseConfirmed = false,
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
    '`/mandrel-deliver` close-validation passed, but the pre-push',
    `sync against \`origin/${baseBranch}\` could not complete. The Story has`,
    `been transitioned to \`agent::blocked\`. To resume:`,
    '',
    ...(baseConfirmed
      ? [
          '```bash',
          `cd ${syncCwd}`,
          `git fetch origin ${baseBranch}`,
          `git merge --no-edit origin/${baseBranch}`,
          '# resolve any conflicts, then:',
          `git add -A ; git commit --no-edit`,
          '# re-run close:',
          `node .agents/scripts/single-story-close.js --story ${storyId}`,
          '```',
        ]
      : [
          `⚠️ **No merge advice: \`${baseBranch}\` is unconfirmed.** This close could not`,
          `read the base branch \`${storyBranch}\` was seeded from off the run's`,
          '`story-init` receipt, so merging that base in could contaminate the branch',
          'and its PR diff with an unrelated base. Establish the real base first —',
          `check the \`story-init\` comment on this issue and \`project.baseBranch\` in`,
          '`.agentrc.json` / `.agentrc.local.json` — then merge that base and re-run:',
          '',
          '```bash',
          `node .agents/scripts/single-story-close.js --story ${storyId}`,
          '```',
        ]),
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
