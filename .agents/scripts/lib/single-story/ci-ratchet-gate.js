/**
 * ci-ratchet-gate.js — confirm-merge's hold on a PR whose coverage was
 * deferred to CI. With `coverage.ciRatchetCheck` set, a merged PR carrying
 * the `Coverage-deferred:` key line is confirmed only once that check is
 * green on the PR head: absent or in flight stays pending; completed
 * without success (failure, error, timed out, cancelled, startup failure,
 * action required) blocks.
 */

import { resolveQuality } from '../config/quality.js';
import { readDeferralMarker } from '../coverage-deferral.js';
import { gh as defaultGh } from '../gh-exec.js';
import { Logger } from '../Logger.js';
import {
  checkVerdict,
  classifyRollupEntry,
} from '../orchestration/check-state.js';
import { isRunInFlight, readRunName } from '../orchestration/merge-poll.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../orchestration/ticketing.js';

/** @param {object} run @returns {boolean} */
function isGreen(run) {
  const verdict = String(run?.conclusion || run?.state || '').toUpperCase();
  return verdict === 'SUCCESS';
}

/**
 * The declared check's verdict on the PR head's rollup: a green re-run wins,
 * then one in flight, then red; no matching run is `absent`.
 *
 * @param {Array<object>|null|undefined} rollup @param {string} checkName
 * @returns {'green'|'in-flight'|'red'|'absent'}
 */
function ratchetVerdict(rollup, checkName) {
  const runs = (Array.isArray(rollup) ? rollup : []).filter(
    (run) => readRunName(run) === checkName,
  );
  if (runs.some(isGreen)) return 'green';
  if (runs.some(isRunInFlight)) return 'in-flight';
  return runs.some((run) => checkVerdict(classifyRollupEntry(run)) === 'fail')
    ? 'red'
    : 'absent';
}

/** Post the friction comment and flip `agent::blocked`; each write best-effort. */
async function blockOnRedRatchet({ provider, storyId, detail }) {
  try {
    await upsertStructuredComment(
      provider,
      storyId,
      'friction',
      `### confirm-merge blocked: ci-ratchet-red\n\n${detail}\n\nThe deferred code landed without its coverage and CRAP ratchet; an operator must decide, then re-run \`single-story-confirm-merge.js\`.`,
    );
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
  } catch (err) {
    Logger.warn(
      `[single-story-confirm-merge] ⚠️ ci-ratchet block write failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * `null` when confirmation may proceed; otherwise the result to return in
 * place of the `agent::done` flip.
 *
 * @param {{ config?: object, prNumber: number, storyId: number, provider: object,
 *   gh?: object, progress?: Function, blockFn?: typeof blockOnRedRatchet }} args
 * @returns {Promise<object|null>}
 */
export async function holdForCiRatchet({
  config,
  prNumber,
  storyId,
  provider,
  gh = defaultGh,
  progress,
  blockFn = blockOnRedRatchet,
}) {
  const coverage = config?.delivery?.quality?.gates?.coverage;
  const { ciRatchetCheck } = resolveQuality({ gates: { coverage } }).coverage;
  if (!ciRatchetCheck) return null;
  const view = await gh.pr.view(prNumber, ['body', 'statusCheckRollup']);
  if (!readDeferralMarker(view?.body)) return null;
  const verdict = ratchetVerdict(view?.statusCheckRollup, ciRatchetCheck);
  if (verdict === 'green') return null;
  const named = `CI ratchet check "${ciRatchetCheck}" on PR #${prNumber}`;
  if (verdict !== 'red') {
    progress?.(
      'CONFIRM',
      `⏳ ${named} is ${verdict}. Story stays at agent::closing.`,
    );
    return {
      storyId,
      action: 'pending',
      reason: 'ci-ratchet-pending',
      merged: false,
    };
  }
  const detail = `${named} is red: the coverage was deferred to CI and its ratchet failed after the merge.`;
  progress?.('CONFIRM', `🛑 ${detail} Story → agent::blocked.`);
  await blockFn({ provider, storyId, detail });
  return {
    storyId,
    action: 'blocked',
    reason: 'ci-ratchet-red',
    detail,
    merged: false,
  };
}

/**
 * Close's merge-wait outcome for a confirmation the ratchet held, else
 * `null`: `pending` (resumable) or `blocked` as `checks-failed`.
 *
 * @param {{ action: string, reason?: string, detail?: string }} confirmation
 * @param {{ prProbe?: object, elapsedSeconds?: number }} wait
 * @returns {object|null}
 */
export function ratchetWaitOutcome(confirmation, { prProbe, elapsedSeconds }) {
  if (!String(confirmation.reason ?? '').startsWith('ci-ratchet-')) return null;
  const common = {
    confirmed: false,
    elapsedSeconds,
    prProbe: { ...(prProbe ?? {}), state: 'MERGED' },
  };
  if (confirmation.action === 'pending') {
    return { ...common, terminal: 'pending', reason: confirmation.reason };
  }
  return {
    ...common,
    terminal: 'blocked',
    blockClass: 'checks-failed',
    reason: confirmation.detail,
    frictionCommentId: null,
  };
}
