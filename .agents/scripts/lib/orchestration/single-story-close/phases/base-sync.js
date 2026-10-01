/**
 * phases/base-sync.js — sync the Story branch from `origin/<baseBranch>`
 * before push, so a PR does not open behind a base a sibling's merge just
 * moved. Runs in the worktree (else the main checkout). A baseline-only
 * conflict resolves inside the sync; any other conflict against a confirmed
 * base goes back to the delivering agent (friction, labels unchanged); every
 * other failure blocks the Story. All failures throw.
 */

import { getQuality } from '../../../config/quality.js';
import { resolveConfig } from '../../../config-resolver.js';
import { filterFilesUnderTargets } from '../../../coverage-capture.js';
import { syncBranchFromBase } from '../../../git/sync-from-base.js';
import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { NEXT_COMMANDS } from '../../story-deliver-terminal.js';
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
    const { handedBack } = await handleSyncFailure({
      provider,
      storyId,
      syncCwd,
      baseBranch,
      baseConfirmed,
      storyBranch,
      result: syncResult,
      progress,
    });
    throw buildSyncFailureError({ storyId, syncCwd, syncResult, handedBack });
  }
  progress('SYNC', `✅ Synced from origin/${baseBranch} (${syncResult.kind}).`);
  const resolved = syncResult.resolvedBaselineFiles ?? [];
  if (resolved.length > 0) {
    progress(
      'SYNC',
      `♻️  Baseline-only conflict resolved to origin/${baseBranch}'s version ` +
        `(the insert-only seat and close's gates re-derive this Story's rows): ` +
        resolved.join(', '),
    );
  }
  for (const line of buildStampInvalidatedWarning({
    baseBranch,
    result: syncResult,
    targetDirs: resolveCrapTargetDirs(resolveConfigImpl, syncCwd),
  })) {
    progress('SYNC', line);
  }
}

/** A handed-back conflict re-runs close next (`closeNextCommand`). */
function buildSyncFailureError({ storyId, syncCwd, syncResult, handedBack }) {
  const err = new Error(
    `[single-story-close] Base-sync failed (${syncResult.kind})` +
      syncFailureDetail(syncResult) +
      (handedBack
        ? `. Labels unchanged — resolve the conflict in ${syncCwd}, commit, and re-run close.`
        : `. Story transitioned to ${AGENT_LABELS.BLOCKED}; resolve in ${syncCwd} and re-run \`/mandrel-deliver ${storyId}\`.`),
  );
  if (handedBack) err.closeNextCommand = NEXT_COMMANDS.close(storyId);
  return err;
}

function syncFailureDetail({ conflictFiles, stderr }) {
  if (conflictFiles) return `: conflicting files = ${conflictFiles.join(', ')}`;
  return stderr ? `: ${stderr.slice(0, 200)}` : '';
}

/**
 * A source conflict against a confirmed base is the delivering agent's to
 * resolve; every other sync failure needs a human.
 *
 * @param {{ kind: string }} result
 * @param {boolean} baseConfirmed
 * @returns {boolean}
 */
function isHandedBack(result, baseConfirmed) {
  return result.kind === 'conflict' && baseConfirmed === true;
}

/** `handBack`: the merge wait, whose PR is open, hands every failure back. */
function resolveHandedBack({ result, baseConfirmed, handBack }) {
  return handBack === true || isHandedBack(result, baseConfirmed);
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
 * Post a `friction` comment, then block the Story unless the failure is
 * handed back to the delivering agent; both best-effort.
 *
 * @param {{
 *   provider: object,
 *   storyId: number,
 *   syncCwd: string,
 *   baseBranch: string,
 *   baseConfirmed?: boolean,
 *   storyBranch: string,
 *   result: { kind: string, conflictFiles?: string[], stderr?: string },
 *   handBack?: boolean,
 *   progress: (tag: string, msg: string) => void,
 * }} args `handBack` leaves the labels alone for every failure kind.
 * @returns {Promise<{ handedBack: boolean }>}
 */
export async function handleSyncFailure({
  provider,
  storyId,
  syncCwd,
  baseBranch,
  baseConfirmed = false,
  storyBranch,
  result,
  handBack = false,
  progress,
}) {
  const body = buildSyncFailureCommentBody({
    storyId,
    storyBranch,
    baseBranch,
    baseConfirmed,
    syncCwd,
    result,
    handBack,
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

  const handedBack = resolveHandedBack({ result, baseConfirmed, handBack });
  await settleSyncFailureLabels({ provider, storyId, handedBack, progress });
  return { handedBack };
}

/** A handed-back conflict leaves the labels alone; anything else blocks. */
async function settleSyncFailureLabels({
  provider,
  storyId,
  handedBack,
  progress,
}) {
  if (handedBack) {
    progress(
      'SYNC',
      `↩️  Conflict handed back to the delivering agent; Story #${storyId} labels unchanged.`,
    );
    return;
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

const CLOSE_RERUN = (storyId) =>
  `node .agents/scripts/single-story-close.js --story ${storyId}`;

function commentLede(handedBack, baseBranch) {
  if (handedBack) {
    return [
      `**For the delivering agent:** the pre-push sync against \`origin/${baseBranch}\``,
      'conflicts. Labels are unchanged — this is not a block. Resolve the',
      'conflict in the worktree, commit, and re-run close:',
    ];
  }
  return [
    `The pre-push sync against \`origin/${baseBranch}\` could not complete. The`,
    'Story has been transitioned to `agent::blocked`. To resume:',
  ];
}

function mergeAdvice({ storyId, syncCwd, baseBranch, handedBack }) {
  const lines = [
    '```bash',
    `cd ${syncCwd}`,
    `git fetch origin ${baseBranch}`,
    `git merge --no-edit origin/${baseBranch}`,
    '# resolve any conflicts, then:',
    `git add -A ; git commit --no-edit`,
    '# re-run close:',
    CLOSE_RERUN(storyId),
    '```',
  ];
  if (!handedBack) return lines;
  return [
    ...lines,
    '',
    'Only an agent that cannot resolve it takes the blocked path: post why,',
    `then \`node .agents/scripts/update-ticket-state.js --ticket ${storyId} --state agent::blocked\`.`,
  ];
}

function unconfirmedBaseAdvice({ storyId, storyBranch, baseBranch }) {
  return [
    `⚠️ **No merge advice: \`${baseBranch}\` is unconfirmed.** This close could not`,
    `read the base branch \`${storyBranch}\` was seeded from off the run's`,
    'init receipt, so merging that base in could contaminate the branch',
    'and its PR diff with an unrelated base. Establish the real base first —',
    `check \`temp/orchestration/story-init-result-${storyId}.log\` and \`project.baseBranch\` in`,
    '`.agentrc.json` / `.agentrc.local.json` — then merge that base and re-run:',
    '',
    '```bash',
    CLOSE_RERUN(storyId),
    '```',
  ];
}

function failureEvidence(kind, result) {
  const files = result.conflictFiles ?? [];
  if (kind === 'conflict' && files.length > 0) {
    return [
      '',
      '**Conflicting files:**',
      '',
      ...files.map((f) => `- \`${f}\``),
    ];
  }
  if (!result.stderr) return [];
  return [
    '',
    '**git stderr:**',
    '',
    '```',
    result.stderr.slice(0, 1000),
    '```',
  ];
}

/**
 * `baseConfirmed` (default false, fail-closed) gates the merge-the-base
 * advice: merging a base the Story was not seeded from contaminates the
 * branch and PR diff, so an unconfirmed base gets "establish it first".
 *
 * @param {{ storyId: number, storyBranch: string, baseBranch: string, baseConfirmed?: boolean, syncCwd: string, result: { kind: string, conflictFiles?: string[], stderr?: string }, handBack?: boolean }} args
 * @returns {string}
 */
export function buildSyncFailureCommentBody({
  storyId,
  storyBranch,
  baseBranch,
  baseConfirmed = false,
  syncCwd,
  result,
  handBack = false,
}) {
  const kind = result.kind ?? 'unknown';
  const handedBack = resolveHandedBack({ result, baseConfirmed, handBack });
  const heading =
    kind === 'conflict'
      ? `Base-sync conflict on close: ${storyBranch} ↔ origin/${baseBranch}`
      : `Base-sync failed on close (${kind}): ${storyBranch} ↔ origin/${baseBranch}`;
  const advice = baseConfirmed
    ? mergeAdvice({ storyId, syncCwd, baseBranch, handedBack })
    : unconfirmedBaseAdvice({ storyId, storyBranch, baseBranch });
  return [
    `### ${heading}`,
    '',
    ...commentLede(handedBack, baseBranch),
    '',
    ...advice,
    ...failureEvidence(kind, result),
  ].join('\n');
}
