/**
 * single-story-sweep/reconcile-closing.js — heal Stories GitHub closed while
 * still at `agent::closing`.
 *
 * Close arms auto-merge and only a live local process (close's merge wait or
 * `single-story-confirm-merge.js`) flips `agent::done`. When the PR merges
 * after that process is gone, the `Closes #<id>` footer closes the issue and
 * the label strands. The boot surfaces run on every delivery, so they finish
 * the flip here — through the close path's own `reconcileDoneLabel`, which
 * requires a MERGED `story-<id>` PR. Bounded per sweep; never throws.
 */

import { getStoryBranch } from '../git-utils.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { reconcileDoneLabel as defaultReconcile } from '../orchestration/single-story-close/phases/reconcile-done.js';

/** Candidates processed per sweep; a larger backlog drains across boots. */
export const DEFAULT_RECONCILE_LIMIT = 10;

/**
 * @param {{ labels?: string[] }} ticket
 * @returns {boolean} A Story still owed its `agent::done` flip.
 */
function isStrandedStory(ticket) {
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  return (
    labels.includes(TYPE_LABELS.STORY) && !labels.includes(AGENT_LABELS.DONE)
  );
}

/** One candidate's outcome; a throw is an `error` outcome, never a rejection. */
async function reconcileOne({ story, cwd, deps, logger, reconcileFn }) {
  try {
    return await reconcileFn(
      {
        storyId: story.id,
        storyBranch: getStoryBranch(story.id),
        story,
        options: { cwd },
      },
      deps,
      (_tag, msg) => logger.info?.(msg),
    );
  } catch (err) {
    logger.warn?.(
      `could not reconcile Story #${story.id} (host continues): ${err?.message ?? err}`,
    );
    return 'error';
  }
}

/**
 * @param {{
 *   provider: object,
 *   config: object,
 *   cwd: string,
 *   gh?: object,
 *   notify?: Function,
 *   sleep?: Function,
 *   logger?: { info?: Function, warn?: Function },
 *   limit?: number,
 *   reconcileFn?: typeof defaultReconcile,
 * }} args
 * @returns {Promise<{ ok: boolean, reconciled: number[],
 *   skipped: Array<{ storyId: number, reason: string }>, error?: string }>}
 */
export async function reconcileStrandedClosing({
  provider,
  config,
  cwd,
  gh,
  notify,
  sleep,
  logger = {},
  limit = DEFAULT_RECONCILE_LIMIT,
  reconcileFn = defaultReconcile,
}) {
  const outcome = { ok: true, reconciled: [], skipped: [] };
  if (typeof provider?.listTicketsByLabel !== 'function') return outcome;
  let tickets;
  try {
    tickets = await provider.listTicketsByLabel({
      state: 'closed',
      labels: AGENT_LABELS.CLOSING,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.warn?.(
      `closed agent::closing listing failed (host continues): ${msg}`,
    );
    return { ...outcome, ok: false, error: msg };
  }
  const candidates = (Array.isArray(tickets) ? tickets : [])
    .filter(isStrandedStory)
    .slice(0, limit);
  const deps = { provider, config, gh, notify, sleep };
  for (const story of candidates) {
    const storyId = story.id;
    const result = await reconcileOne({
      story,
      cwd,
      deps,
      logger,
      reconcileFn,
    });
    if (result === 'done') outcome.reconciled.push(storyId);
    else outcome.skipped.push({ storyId, reason: result });
  }
  if (outcome.reconciled.length > 0) {
    logger.info?.(
      `🏷️  reconciled ${outcome.reconciled.length} closed Story(ies) stranded at agent::closing → agent::done.`,
    );
  }
  return outcome;
}
