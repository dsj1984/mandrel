/**
 * source-rewrite.js — rewrite a one-for-one `/mandrel-plan --tickets` source
 * ticket in place instead of filing a new Story and closing the source as its
 * duplicate. Eligibility is decided here from the flags and one fresh probe of
 * the source; every other shape keeps the create-and-close path.
 *
 * @module lib/orchestration/plan-persist/source-rewrite
 */

import { AGENT_LABELS, TYPE_LABELS } from '../../label-constants.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';

/** First write wins: a re-plan never replaces the pre-plan record. */
const PLAN_REWRITE_COMMENT_TYPE = 'plan-rewrite';

/** An open PR (`closing`) is as live as an implementing session. */
const MID_DELIVERY_LABELS = Object.freeze([
  AGENT_LABELS.EXECUTING,
  AGENT_LABELS.CLOSING,
]);

/**
 * @typedef {object} RewriteResolution
 * @property {{ id: number, ticket: object }|null} target The source to
 *   rewrite, carrying the probe's fresh copy so the rewrite needs no re-read.
 * @property {number|null} ticketId The rewritten source's id, or null.
 * @property {string|null} reason Why there is no target.
 * @property {string[]} warnings One entry when a one-for-one shape was refused
 *   on the source's state — the operator expected a rewrite and gets a new
 *   Story.
 */

/**
 * @param {string} reason
 * @param {string[]} [warnings]
 * @returns {RewriteResolution}
 */
function noRewrite(reason, warnings = []) {
  return { target: null, ticketId: null, reason, warnings };
}

/**
 * @param {object} ticket
 * @returns {string|null} Why this source cannot be rewritten in place.
 */
function stateRefusal(ticket) {
  if (String(ticket.state ?? 'open').toLowerCase() === 'closed') {
    return 'closed';
  }
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  // A container has children and is never a work item.
  if (labels.includes(TYPE_LABELS.EPIC)) return 'epic-container';
  // Its contract is mid-delivery; rewriting it would move the goalposts.
  if (MID_DELIVERY_LABELS.some((label) => labels.includes(label))) {
    return 'mid-delivery';
  }
  return null;
}

/**
 * @param {object} provider
 * @param {number} id
 * @returns {Promise<{ ticket: object|null, reason: string|null }>}
 */
async function probeSource(provider, id) {
  try {
    const ticket = await provider.getTicket(id, { fresh: true });
    if (!ticket) return { ticket: null, reason: 'not-found' };
    return { ticket, reason: stateRefusal(ticket) };
  } catch (err) {
    return { ticket: null, reason: `inaccessible: ${err.message}` };
  }
}

/**
 * One source ticket planned into one Story is a rewrite, unless the operator
 * opted out (`--no-rewrite-source`) or asked to keep the source open
 * (`--no-close-superseded`: the remainder must survive as itself).
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {number} args.storyCount
 * @param {number[]} args.sourceTicketIds
 * @param {boolean} [args.rewriteSource=true]
 * @param {boolean} [args.closeSuperseded=true]
 * @returns {Promise<RewriteResolution>}
 */
export async function resolveRewriteTarget({
  provider,
  storyCount,
  sourceTicketIds,
  rewriteSource = true,
  closeSuperseded = true,
}) {
  const ids = Array.isArray(sourceTicketIds) ? sourceTicketIds : [];
  if (ids.length !== 1 || storyCount !== 1) return noRewrite('not-one-for-one');
  if (!rewriteSource) return noRewrite('disabled-by-flag');
  if (!closeSuperseded) return noRewrite('no-close-superseded');
  const [id] = ids;
  const { ticket, reason } = await probeSource(provider, id);
  if (reason !== null) {
    return noRewrite(reason, [
      `source ticket #${id} cannot be rewritten in place (${reason}) — ` +
        `filing a new Story and closing #${id} instead.`,
    ]);
  }
  return { target: { id, ticket }, ticketId: id, reason: null, warnings: [] };
}

/**
 * @param {{ title?: string, body?: string }} ticket
 * @returns {string}
 */
function buildPlanRewriteCommentBody(ticket) {
  const body = (ticket.body ?? '').trim();
  return [
    '**Rewritten in place by `/mandrel-plan`.** The original title and body ' +
      'are kept below as the pre-plan record; the issue body now carries the ' +
      'delivery contract.',
    '',
    `<details><summary>Original: ${ticket.title ?? '(untitled)'}</summary>`,
    '',
    body === '' ? '_(empty body)_' : body,
    '',
    '</details>',
  ].join('\n');
}

/**
 * Preserve the original (once), then rewrite title, body and labels in one
 * PATCH. The caller strips every `agent::*` label in that PATCH, so a source
 * already at `agent::ready` is never deliverable mid-rewrite; the ready flip
 * stays the persist's terminal step.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {{ id: number, ticket: object }} args.target
 * @param {string} args.title
 * @param {string} args.body
 * @param {{ add: string[], remove: string[] }} args.labels
 * @returns {Promise<void>}
 */
export async function rewriteSourceTicket({
  provider,
  target,
  title,
  body,
  labels,
}) {
  const { id, ticket } = target;
  const preserved = await findStructuredComment(
    provider,
    id,
    PLAN_REWRITE_COMMENT_TYPE,
  );
  if (!preserved) {
    await upsertStructuredComment(
      provider,
      id,
      PLAN_REWRITE_COMMENT_TYPE,
      buildPlanRewriteCommentBody(ticket),
    );
  }
  await provider.updateTicket(id, {
    title,
    body,
    labels,
    _ticketSnapshot: ticket,
  });
}
