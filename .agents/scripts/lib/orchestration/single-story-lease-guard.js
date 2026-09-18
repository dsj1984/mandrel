/**
 * Story lease for single-Story delivery: take the assignee lease at init,
 * clear it at close, so two runs never drive one Story. Fail-closed — a
 * foreign assignee refuses unless `--steal`.
 */

import {
  acquireLeaseFailClosed,
  resolveOperatorFromCandidates,
} from './lease-guard-shared.js';
import { releaseLease } from './ticket-lease.js';

/**
 * Missing-handle policy is `'throw'`: init has no best-effort leg to degrade.
 *
 * @param {object} config
 * @returns {string} Bare operator handle.
 * @throws {Error} When `github.operatorHandle` is unset or the placeholder.
 */
export function resolveOperator(config) {
  return resolveOperatorFromCandidates({
    candidates: [config?.github?.operatorHandle],
    missingHandleBehavior: 'throw',
    missingHandleMessage:
      'single-story lease: no operator identity is configured. ' +
      'github.operatorHandle is unset or still the shipped `@[USERNAME]` ' +
      'placeholder, so the standalone Story lease has no owner. Set your own ' +
      'handle in .agentrc.local.json (e.g. { "github": { "operatorHandle": ' +
      '"@your-login" } }) and re-run.',
  });
}

/**
 * @param {object} opts
 * @param {object} opts.provider
 * @param {number} opts.storyId
 * @param {object} opts.config
 * @param {string} [opts.operator]         Test override.
 * @param {boolean} [opts.steal=false]
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 * @throws {Error} When a foreign claim refuses the acquire (no `steal`).
 */
export async function acquireStoryLease({
  provider,
  storyId,
  config,
  operator,
  steal = false,
}) {
  const owner = operator ?? resolveOperator(config);
  return acquireLeaseFailClosed({
    provider,
    ticketId: storyId,
    operator: owner,
    steal,
    renderRefusal: (result) =>
      `single-story lease: Story #${storyId} is currently held by @${result.owner}. ` +
      'Another /mandrel-deliver run owns this Story. Coordinate with that ' +
      'operator, or re-run with --steal to forcibly transfer the claim once you ' +
      'have confirmed the other run is dead. (A foreign assignee always ' +
      'blocks unless stolen.)',
  });
}

/**
 * @param {object} opts
 * @param {object} opts.provider
 * @param {number} opts.storyId
 * @param {object} opts.config
 * @param {string} [opts.operator]  Test override.
 * @returns {Promise<{ released: boolean, owner: string|null, reason: string }>}
 */
export async function releaseStoryLease({
  provider,
  storyId,
  config,
  operator,
}) {
  const owner = operator ?? resolveOperator(config);
  return releaseLease({ provider, ticketId: storyId, operator: owner });
}
