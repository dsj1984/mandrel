/**
 * Only a live close flips `agent::done`; a PR that merges after it is gone
 * closes the issue at `agent::closing` (or at `agent::blocked`, when its
 * merge wait gave up first). Boot finishes the flip AND the land tail via
 * `reconcileDoneLabel` (MERGED PR required, so a blocked Story whose PR never
 * merged is left untouched). Bounded; never throws.
 */

import { getStoryBranch } from '../git-utils.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { reconcileDoneLabel as defaultReconcile } from '../orchestration/single-story-close/phases/reconcile-done.js';

/** Candidates processed per sweep; a larger backlog drains across boots. */
export const DEFAULT_RECONCILE_LIMIT = 10;

/** Lifecycle labels a closed Story can strand at; one listing each. */
const STRANDED_LABELS = Object.freeze([
  AGENT_LABELS.CLOSING,
  AGENT_LABELS.BLOCKED,
]);

function isStrandedStory(ticket) {
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  return (
    labels.includes(TYPE_LABELS.STORY) && !labels.includes(AGENT_LABELS.DONE)
  );
}

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
 * Closed Stories at any stranded label, de-duplicated by id in listing order
 * (a Story can carry both labels).
 *
 * @returns {Promise<object[]>}
 */
async function listStranded(provider) {
  const byId = new Map();
  for (const labels of STRANDED_LABELS) {
    const tickets = await provider.listTicketsByLabel({
      state: 'closed',
      labels,
    });
    for (const ticket of Array.isArray(tickets) ? tickets : []) {
      if (!byId.has(ticket?.id)) byId.set(ticket?.id, ticket);
    }
  }
  return [...byId.values()];
}

export async function reconcileStrandedClosing({
  provider,
  config,
  cwd,
  gh,
  notify,
  sleep,
  runPostLandTail,
  logger = {},
  limit = DEFAULT_RECONCILE_LIMIT,
  reconcileFn = defaultReconcile,
}) {
  const outcome = { ok: true, reconciled: [], skipped: [] };
  if (typeof provider?.listTicketsByLabel !== 'function') return outcome;
  let tickets;
  try {
    tickets = await listStranded(provider);
  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.warn?.(
      `closed agent::closing / agent::blocked listing failed (host continues): ${msg}`,
    );
    return { ...outcome, ok: false, error: msg };
  }
  const candidates = tickets.filter(isStrandedStory).slice(0, limit);
  const deps = { provider, config, gh, notify, sleep, runPostLandTail };
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
      `🏷️  reconciled ${outcome.reconciled.length} closed Story(ies) stranded at agent::closing / agent::blocked → agent::done.`,
    );
  }
  return outcome;
}
