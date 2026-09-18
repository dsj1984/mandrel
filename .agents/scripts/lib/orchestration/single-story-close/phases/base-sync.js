/**
 * phases/base-sync.js — sync the Story branch from `origin/<baseBranch>`
 * before push, so a PR does not open behind a base a sibling's merge just
 * moved. Runs in the worktree (else the main checkout); a failure blocks the
 * Story and throws.
 */

import { getQuality } from '../../../config/quality.js';
import { resolveConfig } from '../../../config-resolver.js';
import { filterFilesUnderTargets } from '../../../coverage-capture.js';
import { syncBranchFromBase } from '../../../git/sync-from-base.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';

/**
 * `--skip-sync` is the caller's concern.
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
 *   resolveConfigImpl?: typeof resolveConfig,
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
  resolveConfigImpl = resolveConfig,
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
    targetDirs: resolveCrapTargetDirs(resolveConfigImpl, syncCwd),
  })) {
    progress('SYNC', line);
  }
}

/**
 * The CRAP scoring scope, or `[]` when unresolvable.
 *
 * @param {typeof resolveConfig} resolveConfigImpl
 * @param {string} cwd
 * @returns {string[]}
 */
function resolveCrapTargetDirs(resolveConfigImpl, cwd) {
  try {
    return getQuality(resolveConfigImpl({ cwd }))?.crap?.targetDirs ?? [];
  } catch {
    return [];
  }
}

const WARNED_PATH_LIMIT = 12;

/**
 * Warn that the sync spent pre-push credit, or `[]` when it changed nothing.
 * Gate evidence is keyed on the tree, so any tracked path spends it; the
 * full-suite capture stamp is spent only by a path under `crap.targetDirs`.
 * A content-changing fast-forward warns just as a merge does.
 *
 * @param {{ baseBranch: string, result: { kind?: string, changedPaths?: string[] }, targetDirs?: string[] }} args
 * @returns {string[]} Progress lines, in order. Empty when nothing changed.
 */
function buildStampInvalidatedWarning({ baseBranch, result, targetDirs }) {
  const changed = Array.isArray(result?.changedPaths)
    ? result.changedPaths
    : [];
  if (changed.length === 0) return [];
  const dirs = Array.isArray(targetDirs) ? targetDirs : [];
  // An unresolvable scope cannot prove the stamp survived: fail closed.
  const scored =
    dirs.length === 0 ? changed : filterFilesUnderTargets(changed, dirs);
  const shown = changed.slice(0, WARNED_PATH_LIMIT);
  const overflow = changed.length - shown.length;
  return [
    `⚠️  BASE MOVED: the ${result?.kind ?? 'sync'} from origin/${baseBranch} ` +
      `brought ${changed.length} tracked path(s) into this branch, so the tree ` +
      `hash the pre-push lint/typecheck evidence was keyed on has changed. ` +
      `That evidence cannot be credited; those gates re-run below.`,
    scored.length > 0
      ? `⚠️  The full-suite capture stamp is spent too: ${scored.length} of ` +
        `those path(s) fall under the CRAP target dirs [${dirs.join(', ')}], ` +
        `so the suite re-runs against the merged tree. This is expected, not a fault.`
      : `⚠️  The full-suite capture stamp SURVIVES: no merged path falls under ` +
        `the CRAP target dirs [${dirs.join(', ')}], so the coverage artifact still ` +
        `describes this tree and the suite is not re-run.`,
    ...shown.map((f) => `⚠️    ${f}`),
    ...(overflow > 0 ? [`⚠️    …and ${overflow} more`] : []),
  ];
}

/**
 * Post a `friction` comment and block the Story; both best-effort.
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

  // Comment first so the recovery surface lands even if the flip fails; a
  // notification failure must never mask why close threw.
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
    progress('SYNC', `📝 Posted friction comment on #${storyId}.`);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ Failed to post sync-failure friction comment on #${storyId}: ${err?.message ?? err}`,
    );
  }

  // The canonical mutator: a bare label write skips the Projects v2 sync.
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
 * `baseConfirmed` (default false, fail-closed) gates the merge-the-base
 * advice: merging a base the Story was not seeded from contaminates the
 * branch and PR diff, so an unconfirmed base gets "establish it first".
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
          'init receipt, so merging that base in could contaminate the branch',
          'and its PR diff with an unrelated base. Establish the real base first —',
          `check \`temp/orchestration/story-init-result-${storyId}.log\` and \`project.baseBranch\` in`,
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
