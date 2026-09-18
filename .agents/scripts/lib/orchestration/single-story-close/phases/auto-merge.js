/**
 * phases/auto-merge.js — arm GitHub native auto-merge (squash, delete branch).
 * Non-fatal: a failure returns `{ enabled: false, reason }`. The arm runs from
 * the primary worktree so `--delete-branch`'s local `git checkout <base>`
 * cannot collide with a worktree holding the base.
 */

import { gh as defaultGh, describeGhFailure } from '../../../gh-exec.js';
import { resolveAutoMergeArmCwd } from '../../auto-merge-cwd.js';
import {
  decideAdvisoryGateBlock,
  deriveRedHeadRuns,
} from '../../merge-poll.js';

/**
 * The operator deliberately owns the merge, so close does not wait for it;
 * every other falsy arm outcome is a genuine fault.
 */
const OPERATOR_MERGE_ARM_REASONS = Object.freeze([
  'disabled-by-flag',
  'disabled-by-policy-strict',
]);

/**
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
export function isOperatorMergeReason(reason) {
  return OPERATOR_MERGE_ARM_REASONS.includes(reason);
}

/**
 * A `gh pr merge --delete-branch` failure whose only casualty is the LOCAL
 * head-branch delete after the remote merge/arm already happened. Deliberately
 * narrow: a refused remote merge, and the `'<base>' is already used by
 * worktree` checkout collision (which aborts before the merge), must still
 * fail the arm.
 */
const LOCAL_CLEANUP_FAILURE =
  /cannot delete branch[^\n]*used by worktree|failed to delete (?:the )?local branch/i;

/**
 * @param {string|undefined|null} stderr
 * @returns {boolean}
 */
function isLocalCleanupOnlyFailure(stderr) {
  return LOCAL_CLEANUP_FAILURE.test(String(stderr ?? ''));
}

/**
 * Whether `--auto` was refused because native auto-merge is unavailable —
 * the repo disallows it, or the PR is already clean with nothing to queue
 * behind (`enablePullRequestAutoMerge` "clean status"). Both are safe to
 * retry as a direct squash-merge; any other failure keeps blocking.
 *
 * @param {string|undefined|null} stderr
 * @returns {boolean}
 */
function isAutoMergeUnavailable(stderr) {
  const text = String(stderr ?? '').toLowerCase();
  return (
    text.includes('auto merge is not allowed') ||
    text.includes('auto-merge is not allowed') ||
    text.includes('enablepullrequestautomerge') ||
    text.includes('clean status') ||
    (text.includes('auto') && text.includes('not enabled'))
  );
}

/**
 * Direct (non-`--auto`) squash-merge, run from the same `armCwd`. A
 * local-cleanup-only failure still means the remote merge landed.
 *
 * @returns {Promise<{ enabled: boolean, directMerged?: boolean, localCleanupDeferred?: boolean, reason?: string }>}
 */
async function directMergeFallback({ exec, prNumber, armCwd, autoReason }) {
  const direct = await exec(
    ['pr', 'merge', String(prNumber), '--squash', '--delete-branch'],
    { cwd: armCwd },
  );
  if (direct.status === 0) {
    return { enabled: true, directMerged: true, reason: autoReason };
  }
  if (isLocalCleanupOnlyFailure(direct.stderr)) {
    return {
      enabled: true,
      directMerged: true,
      localCleanupDeferred: true,
      reason: autoReason,
    };
  }
  return {
    enabled: false,
    reason: `direct-merge fallback failed after auto-merge unavailable (${autoReason}); gh-exit-${direct.status}: ${(direct.stderr ?? '').trim().slice(0, 160)}`,
  };
}

/**
 * Enable GitHub native auto-merge on the PR. Non-fatal.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number,
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   runner?: (args: string[], opts: object) => ({ status: number, stdout?: string, stderr?: string } | Promise<{ status: number, stdout?: string, stderr?: string }>),
 *   resolveArmCwd?: (cwd: string) => string,
 * }} opts
 * @returns {Promise<{ enabled: boolean, reason?: string, localCleanupDeferred?: boolean, directMerged?: boolean }>}
 */
export async function enableAutoMergeWith({
  cwd,
  prNumber,
  gh,
  runner,
  resolveArmCwd = resolveAutoMergeArmCwd,
}) {
  const exec = runner ?? makeDefaultGhAutoMergeRunner(gh ?? defaultGh);
  const armCwd = resolveArmCwd(cwd);
  try {
    const result = await exec(
      [
        'pr',
        'merge',
        String(prNumber),
        '--auto',
        '--squash',
        '--delete-branch',
      ],
      { cwd: armCwd },
    );
    if (result.status === 0) return { enabled: true };
    const detail = `gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`;
    if (isLocalCleanupOnlyFailure(result.stderr)) {
      // The remote side stands; the land tail finishes the local ref reap.
      return { enabled: true, localCleanupDeferred: true, reason: detail };
    }
    if (isAutoMergeUnavailable(result.stderr)) {
      return directMergeFallback({
        exec,
        prNumber,
        armCwd,
        autoReason: detail,
      });
    }
    return { enabled: false, reason: detail };
  } catch (err) {
    return { enabled: false, reason: `gh-spawn-error: ${err?.message ?? err}` };
  }
}

/**
 * Adapt `gh.pr.merge` into the `{ status, stdout, stderr }` envelope,
 * mapping non-zero exits back to that envelope rather than throwing.
 */
function makeDefaultGhAutoMergeRunner(gh) {
  return async function defaultGhAutoMergeRunner(args, _opts) {
    const [, , prIdStr, ...flags] = args;
    try {
      const result = await gh.pr.merge(prIdStr, flags);
      return {
        status: 0,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
      };
    } catch (err) {
      // Any error with a numeric `.code`/`.status` maps to the envelope;
      // a codeless Error falls through to the caller's spawn-error reason.
      const numericCode =
        typeof err?.code === 'number'
          ? err.code
          : typeof err?.status === 'number'
            ? err.status
            : null;
      if (numericCode !== null) {
        return {
          status: numericCode,
          stdout:
            typeof err.stdout === 'string'
              ? err.stdout
              : (err.stdout?.toString?.() ?? ''),
          stderr:
            typeof err.stderr === 'string'
              ? err.stderr
              : (err.stderr?.toString?.() ?? String(err?.message ?? err)),
        };
      }
      throw err;
    }
  };
}

/**
 * Native auto-merge waits on REQUIRED contexts only, so mandrel must refuse
 * to arm over a red advisory gate itself.
 *
 * @param {object} args
 * @returns {Promise<{ blocked: boolean, blockingRuns?: Array<object>, reason?: string }>}
 */
async function readAdvisoryProbe({ prNumber, gh }) {
  const view = await (gh ?? defaultGh).pr.view(prNumber, [
    'mergeStateStatus',
    'statusCheckRollup',
  ]);
  return {
    mergeStateStatus:
      typeof view?.mergeStateStatus === 'string'
        ? view.mergeStateStatus
        : undefined,
    redHeadRuns: deriveRedHeadRuns(view?.statusCheckRollup),
  };
}

/**
 * A `gh` refusal meaning auto-merge was never armed — the PR is already in the
 * desired un-armed posture, unlike a genuine disarm failure.
 */
const NOT_ARMED = /not enabled|isn't enabled|is not set|no auto-?merge/i;

/**
 * Lives here because `lifecycle-lint` confines `gh pr merge` to this module.
 * Never throws.
 *
 * @param {{ prNumber?: number|string, prRef?: string, gh?: object,
 *   progress?: (tag: string, msg: string) => void }} args `prRef` wins over
 *   `prNumber` when both are given.
 * @returns {Promise<{ disarmed: boolean, alreadyUnarmed: boolean, detail: string }>}
 */
export async function disarmAutoMerge({ prNumber, prRef, gh, progress }) {
  const ref = String(prRef ?? prNumber);
  try {
    await (gh ?? defaultGh).pr.merge(ref, ['--disable-auto']);
    progress?.(
      'CONFIRM',
      `🔓 Auto-merge DISARMED on PR #${ref} — the PR stays open and hand-mergeable.`,
    );
    return { disarmed: true, alreadyUnarmed: false, detail: 'disarmed' };
  } catch (err) {
    const outcome = classifyDisarmFailure(describeGhFailure(err));
    warnIfStillArmed({ outcome, ref, progress });
    return outcome;
  }
}

/**
 * @param {string} detail The operator-legible `gh` failure line.
 * @returns {{ disarmed: boolean, alreadyUnarmed: boolean, detail: string }}
 */
function classifyDisarmFailure(detail) {
  const alreadyUnarmed = NOT_ARMED.test(detail);
  return {
    disarmed: alreadyUnarmed,
    alreadyUnarmed,
    detail: alreadyUnarmed
      ? `auto-merge was not armed: ${detail.slice(0, 160)}`
      : detail.slice(0, 200),
  };
}

function warnIfStillArmed({ outcome, ref, progress }) {
  if (outcome.disarmed) return;
  progress?.(
    'CONFIRM',
    `⚠️ Could not disarm auto-merge on PR #${ref} (${outcome.detail}) — ` +
      'GitHub may still land it when the required checks pass. Disarm by hand.',
  );
}

/** Fail-open: a probe error or disabled knob never blocks the arm. */
async function evaluateAdvisoryGate({
  prNumber,
  gh,
  blockOnAdvisoryFailure,
  advisoryAllowlist,
  readPrWaitProbeFn,
  progress,
}) {
  if (!blockOnAdvisoryFailure) return { blocked: false };
  let probe;
  try {
    probe = await readPrWaitProbeFn({ prNumber, gh });
  } catch (err) {
    progress?.(
      'PR',
      `⚠️ Advisory-gate probe failed (${err?.message ?? err}) — arming anyway.`,
    );
    return { blocked: false };
  }
  if (probe?.error) {
    progress?.(
      'PR',
      `⚠️ Advisory-gate probe unavailable (${probe.error}) — arming anyway.`,
    );
    return { blocked: false };
  }
  // Same evaluator as the merge wait's mid-wait gate, so the verdicts cannot drift.
  const verdict = decideAdvisoryGateBlock({
    probe,
    blockOnAdvisoryFailure,
    advisoryAllowlist,
  });
  if (!verdict) return { blocked: false };
  return {
    blocked: true,
    blockingRuns: verdict.blockingRuns,
    blockClass: verdict.blockClass,
    reason: verdict.reason,
  };
}

/**
 * Dispatch auto-merge enablement.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number|null,
 *   prUrl: string,
 *   noAutoMerge: boolean,
 *   autoMergePolicy?: 'trust-ci'|'strict',
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null, localCleanupDeferred?: boolean, directMerged?: boolean }>}
 *   `localCleanupDeferred`: the arm stands but the land tail owns the local
 *   ref reap. `directMerged`: landed by direct squash-merge instead.
 */
export async function runAutoMergePhase({
  cwd,
  prNumber,
  prUrl,
  noAutoMerge,
  autoMergePolicy = 'trust-ci',
  blockOnAdvisoryFailure = true,
  advisoryAllowlist = [],
  gh,
  progress,
  readPrWaitProbeFn = readAdvisoryProbe,
}) {
  if (noAutoMerge) {
    progress('PR', '⏭  Auto-merge disabled (--no-auto-merge).');
    return { autoMergeEnabled: false, autoMergeReason: 'disabled-by-flag' };
  }
  if (autoMergePolicy === 'strict') {
    progress(
      'PR',
      '⏭  Auto-merge skipped (delivery.ci.autoMerge="strict") — operator merges.',
    );
    return {
      autoMergeEnabled: false,
      autoMergeReason: 'disabled-by-policy-strict',
    };
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
  // Covers a gate ALREADY red at close time; the merge wait owns one that
  // reddens after arming.
  const advisory = await evaluateAdvisoryGate({
    prNumber,
    gh,
    blockOnAdvisoryFailure,
    advisoryAllowlist,
    readPrWaitProbeFn,
    progress,
  });
  if (advisory.blocked) {
    progress(
      'PR',
      `🛑 Auto-merge NOT armed on PR #${prNumber}: ${advisory.reason}`,
    );
    return {
      autoMergeEnabled: false,
      autoMergeReason: 'advisory-gate-red',
      advisoryGate: {
        blockingRuns: advisory.blockingRuns,
        blockClass: advisory.blockClass,
        reason: advisory.reason,
      },
    };
  }
  const result = await enableAutoMergeWith({ cwd, prNumber, gh });
  if (result.enabled) {
    if (result.directMerged) {
      progress(
        'PR',
        `✅ Native auto-merge unavailable on PR #${prNumber} — direct squash-merge landed it` +
          (result.localCleanupDeferred
            ? " (gh's LOCAL branch cleanup deferred to the land tail; the merge stands)."
            : '.'),
      );
      return {
        autoMergeEnabled: true,
        autoMergeReason: null,
        directMerged: true,
        localCleanupDeferred: Boolean(result.localCleanupDeferred),
      };
    }
    if (result.localCleanupDeferred) {
      progress(
        'PR',
        `⚠️ Auto-merge armed on PR #${prNumber}, but gh's LOCAL branch cleanup failed ` +
          `(${result.reason}) — deferring the local ref reap to the land tail; the merge stands.`,
      );
      return {
        autoMergeEnabled: true,
        autoMergeReason: null,
        localCleanupDeferred: true,
      };
    }
    progress(
      'PR',
      `✅ Auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
    );
    return {
      autoMergeEnabled: true,
      autoMergeReason: null,
      localCleanupDeferred: false,
    };
  }
  progress(
    'PR',
    `⚠️ Auto-merge enablement failed (${result.reason}) — operator can merge manually.`,
  );
  return {
    autoMergeEnabled: false,
    autoMergeReason: result.reason,
    localCleanupDeferred: false,
  };
}
