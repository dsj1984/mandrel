/**
 * phases/graphql-preflight.js — the one precondition a standalone close
 * checks before it spends anything (Story #5355).
 *
 * A Story delivered from a Claude Code web session ran the entire
 * close-validation gate chain, synced from the base branch and pushed, then
 * died in the `pull-request` phase on `gh pr create` with a raw HTTP 403:
 * GitHub's GraphQL API is unreachable from that session, and `gh` routes the
 * whole `gh pr` surface through it. That 403 was a fact about the session,
 * knowable before the first gate ran, that the operator paid roughly five
 * minutes of gates to learn.
 *
 * ## Why this is not a pre-gate step
 *
 * It sits beside `pre-gate-steps.js` and inverts every clause of that
 * module's contract, which is why it does not live inside it. Those steps
 * commit to `story-<id>`, run from the gate phase, and may **never** fail the
 * close, because each is the refresh half of a loop whose enforcement half
 * runs immediately afterwards. This one commits nothing, runs from the runner
 * during `init`, and exists precisely to fail the close — before a single
 * gate is spawned and before anything is pushed. One module, one contract.
 *
 * What it must never do is fail a *healthy* close, which is why an ambiguous
 * probe is fail-open at its source (`probeGraphqlAvailability`) and a
 * throwing probe is fail-open here.
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
 * Announce a refused preflight on the Story: a `friction` comment carrying
 * the blocker and its remedy, then the `agent::blocked` transition the
 * terminal envelope's `blocked` status promises the operator.
 *
 * Both writes are best-effort and warn rather than throw, for the reason
 * `handleSyncFailure` gives: a notification-side failure must not replace the
 * real blocker with a secondary one — and here the notification travels the
 * very API surface that is already suspect. Both go through the canonical
 * mutators; a bare `updateTicket` would skip the Projects v2 column sync and
 * strand the board on the Story's prior status.
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
 * Preflight GitHub's GraphQL reachability before the close spends anything.
 *
 * One cheap API read decides it. An `available` verdict returns null and the
 * close proceeds exactly as a run with no preflight would; a refusing verdict
 * announces the block on the Story and returns the descriptor the runner
 * turns into a `blocked` terminal envelope at phase `init`.
 *
 * The probe cannot throw, but a caller-injected one can, and a preflight that
 * takes down a close it was meant to protect is the one outcome worse than
 * the late 403 — so a throwing probe is logged and treated as available.
 *
 * @param {{
 *   storyId: number,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   ghFacade?: { api: Function },
 *   probe?: typeof probeGraphqlAvailability,
 * }} args
 *   `ghFacade` is the run's own `gh` facade, so the preflight asks the same
 *   boundary the pull-request phase will later ask rather than a second one
 *   that could answer differently.
 * @returns {Promise<{ verdict: string, reason: string }|null>} null when the
 *   close may proceed.
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
