/**
 * phases/graphql-preflight.js — refuse the close during `init` when GitHub
 * GraphQL (which all of `gh pr` needs) is unreachable, before any gate runs
 * or anything is pushed. It must never fail a healthy close: ambiguous or
 * throwing probes are fail-open.
 */

import {
  describeGraphqlPreflight,
  probeGraphqlAvailability,
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
    'gate chain, so re-running close from a session that can reach GraphQL starts',
    'from exactly where this Story stands now:',
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
  let verdict;
  try {
    verdict = await probe(ghFacade ? { ghFacade } : undefined);
  } catch (err) {
    progress(
      'PREFLIGHT',
      `⚠️ GraphQL preflight could not run (close continues): ${err?.message ?? err}`,
    );
    return null;
  }
  if (verdict?.available !== false) {
    progress('PREFLIGHT', `✅ GitHub GraphQL reachable (${verdict?.reason}).`);
    return null;
  }
  const reason = describeGraphqlPreflight(verdict);
  progress('PREFLIGHT', `🛑 ${reason}`);
  await announcePreflightBlock({ provider, storyId, reason, progress });
  return { verdict: verdict.verdict, reason };
}
