/**
 * phases/graphql-preflight.js — pick the close's PR transport during `init`,
 * before any gate runs or anything is pushed. GraphQL unreachable (the proxy
 * 403) seeds the `gh-exec` latch so every `gh pr` call goes over repo-scoped
 * REST; only an auth fault, which REST would hit too, refuses the close. It
 * must never fail a healthy close: ambiguous or throwing probes are fail-open.
 */

import {
  describeGraphqlPreflight,
  probeGraphqlAvailability,
  setGraphqlAvailability,
} from '../../../gh-exec.js';
import { Logger } from '../../../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';

/**
 * Best-effort: a notification failure must not replace the real blocker.
 * Canonical mutators only, so the Projects v2 column syncs.
 *
 * @param {{ provider: object, storyId: number, reason: string,
 *   progress: (tag: string, msg: string) => void }} args
 * @returns {Promise<void>}
 */
async function announcePreflightBlock({ provider, storyId, reason, progress }) {
  const body = [
    '### Close refused during `init`: GitHub GraphQL preflight',
    '',
    reason,
    '',
    'Nothing was validated, committed, or pushed — the preflight runs before the',
    'gate chain, so re-running close once `gh` is authenticated starts from',
    'exactly where this Story stands now:',
    '',
    '```bash',
    `node .agents/scripts/single-story-close.js --story ${storyId}`,
    '```',
  ].join('\n');
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
    progress('PREFLIGHT', `📝 Posted friction comment on #${storyId}.`);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ Failed to post preflight friction comment on #${storyId}: ${err?.message ?? err}`,
    );
  }
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
    progress('PREFLIGHT', `🚧 Flipped Story #${storyId} → agent::blocked.`);
  } catch (err) {
    Logger.warn?.(
      `[single-story-close] ⚠️ Failed to flip Story #${storyId} to agent::blocked: ${err?.message ?? err}`,
    );
  }
}

/** The probe's verdict, or `null` when the (injected) probe threw. */
async function readVerdict({ probe, ghFacade, progress }) {
  try {
    return await probe(ghFacade ? { ghFacade } : undefined);
  } catch (err) {
    progress(
      'PREFLIGHT',
      `⚠️ GraphQL preflight could not run (close continues): ${err?.message ?? err}`,
    );
    return null;
  }
}

/** The line a proceeding verdict prints, keyed by its transport. */
const PROCEED_LINES = Object.freeze({
  graphql: (verdict) => `✅ GitHub GraphQL reachable (${verdict?.reason}).`,
  rest: () =>
    '↪ GitHub GraphQL is unavailable in this session (HTTP 403) — the pull-request ' +
    'surface runs over repo-scoped REST for this close.',
});

/** @returns {'graphql'|'rest'|null} the transport to proceed on, or null to refuse. */
function proceedingTransport(verdict) {
  if (verdict?.available !== false) return 'graphql';
  return verdict.verdict === 'unavailable' ? 'rest' : null;
}

/**
 * A throwing (injected) probe is treated as available.
 *
 * @param {{
 *   storyId: number,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   ghFacade?: { api: Function },
 *   probe?: typeof probeGraphqlAvailability,
 * }} args `ghFacade` is the run's own, so it asks the same boundary the PR phase will.
 * @returns {Promise<{ verdict: string, reason: string }|null>} null to proceed.
 */
export async function runGraphqlPreflight({
  storyId,
  provider,
  progress,
  ghFacade,
  probe = probeGraphqlAvailability,
}) {
  const verdict = await readVerdict({ probe, ghFacade, progress });
  if (verdict === null) return null;
  setGraphqlAvailability(verdict ?? null);
  const transport = proceedingTransport(verdict);
  if (transport) {
    progress('PREFLIGHT', PROCEED_LINES[transport](verdict));
    return null;
  }
  const reason = describeGraphqlPreflight(verdict);
  progress('PREFLIGHT', `🛑 ${reason}`);
  await announcePreflightBlock({ provider, storyId, reason, progress });
  return { verdict: verdict.verdict, reason };
}
