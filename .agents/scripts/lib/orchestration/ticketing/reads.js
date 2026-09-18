/**
 * lib/orchestration/ticketing/reads.js — Ticketing read-side surface:
 * validators, markers, and the per-provider structured-comment caches.
 * Never issues a mutating provider call.
 */

import { AGENT_LABELS } from '../../label-constants.js';

const WAVE_MARKER_RE = /^wave-([0-9]{1,3})-(start|end)$/;

export const STATE_LABELS = {
  READY: AGENT_LABELS.READY,
  EXECUTING: AGENT_LABELS.EXECUTING,
  // Held between close-preflight and a confirmed PR merge; must be a valid
  // prior state for the post-merge `--resume` flip to `done`.
  CLOSING: AGENT_LABELS.CLOSING,
  DONE: AGENT_LABELS.DONE,
  // The single HITL pause point (instructions.md § 1.J).
  BLOCKED: AGENT_LABELS.BLOCKED,
};

export const ALL_STATES = Object.values(STATE_LABELS);

/**
 * Structured-comment types accepted by the post/upsert paths; parametric
 * `wave-N-start|end` types match {@link WAVE_TYPE_PATTERN}. A kind nothing
 * emits any more is dead wiring and is removed. Some kinds stay registered
 * only so historical comments remain readable.
 */
export const STRUCTURED_COMMENT_TYPES = Object.freeze([
  'progress',
  'friction',
  'notification',
  // Single findings contract for code review and lens findings.
  'verification-results',
  'retro',
  'retro-partial',
  'follow-ups',
  'plan-run-audit-roster',
  'epic-run-state',
  'epic-run-progress',
  'epic-plan-state',
  'phase-timings',
  'clarity-gate-update',
  // Advisory: path references missing at the base branch.
  'spec-freshness',
  'epic-handoff',
  'delivery-preflight',
  'recurring-failure-class',
  'wave-stall',
  // Records claimant + claim time; the guard fails closed, so a stranded
  // claim is cleared with `--steal`, not by TTL.
  'plan-lease',
  // Discriminated by a `graduator="<name>"` attr so graduators don't clobber
  // each other.
  'cross-repo-deferred',
  // The only comment persist posts on each Story; the marker makes a
  // re-persist upsert in place.
  'story-plan-state',
  // Posted before closing a superseded source issue; the marker keeps
  // re-runs from double-commenting.
  'superseded-by',
]);

export const WAVE_TYPE_PATTERN = WAVE_MARKER_RE;

/**
 * Pool-mode claim marker, upserted per story-id; the label set, not the
 * comment, is the race-detection signal.
 */
const CLAIM_TYPE_PATTERN = /^claim-([0-9]{1,9})$/;

/** Generic `lifecycle-*` prefix so listeners can mint markers freely. */
const LIFECYCLE_TYPE_PATTERN = /^lifecycle-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isValidStructuredCommentType(type) {
  if (typeof type !== 'string' || type.length === 0) return false;
  return (
    STRUCTURED_COMMENT_TYPES.includes(type) ||
    WAVE_TYPE_PATTERN.test(type) ||
    CLAIM_TYPE_PATTERN.test(type) ||
    LIFECYCLE_TYPE_PATTERN.test(type)
  );
}

/**
 * @param {string} type
 */
export function assertValidStructuredCommentType(type) {
  if (isValidStructuredCommentType(type)) return;
  throw new Error(
    `Invalid structured-comment type: ${JSON.stringify(type)}. ` +
      `Accepted: ${STRUCTURED_COMMENT_TYPES.join(', ')} or patterns ${WAVE_TYPE_PATTERN}, ${CLAIM_TYPE_PATTERN}, ${LIFECYCLE_TYPE_PATTERN}.`,
  );
}

/**
 * HTML marker identifying a structured comment. `attrs` discriminates
 * several snapshots of one type (e.g. one per wave) so an upsert doesn't
 * overwrite a sibling.
 *
 * @param {string} type
 * @param {Record<string, string|number>} [attrs]
 * @returns {string}
 */
export function structuredCommentMarker(type, attrs = null) {
  let attrStr = '';
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      attrStr += ` ${key}="${String(value)}"`;
    }
  }
  return `<!-- ap:structured-comment type="${type}"${attrStr} -->`;
}

/**
 * Per-provider `(ticketId, type, attrs)` → resolved comment (or `null` miss).
 * Upsert refreshes and delete evicts entries. WeakMap-scoped so fakes stay
 * isolated.
 */
const _structuredCommentCache = new WeakMap();

/**
 * Snapshot of a ticket with `subTickets` pinned (default `[]`); pure.
 *
 * @param {object|null|undefined} ticket
 * @param {{ subTickets?: Array<object> }} [opts]
 * @returns {object|null} The augmented snapshot, or `null` when `ticket`
 *   is falsy.
 */
export function buildStorylessTicketSnapshot(ticket, opts = {}) {
  if (ticket == null) return null;
  const subTickets = Array.isArray(opts.subTickets) ? opts.subTickets : [];
  return { ...ticket, subTickets };
}

/**
 * @param {object} provider
 * @returns {Map<string, object|null>}
 */
export function getProviderCommentCache(provider) {
  if (!provider || typeof provider !== 'object') return new Map();
  let map = _structuredCommentCache.get(provider);
  if (!map) {
    map = new Map();
    _structuredCommentCache.set(provider, map);
  }
  return map;
}

/**
 * Attrs are key-sorted so equivalent bags collide.
 *
 * @param {number} ticketId
 * @param {string} type
 * @param {Record<string, string|number>|null} attrs
 * @returns {string}
 */
export function structuredCommentCacheKey(ticketId, type, attrs) {
  if (!attrs || typeof attrs !== 'object') {
    return `${ticketId}|${type}|`;
  }
  const sorted = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${String(attrs[k])}`)
    .join('&');
  return `${ticketId}|${type}|${sorted}`;
}

/**
 * Per-provider ticketId → full comment array, so lookups for different types
 * on one ticket share one fetch. Structured-comment writes evict the entry.
 */
const _rawCommentsCache = new WeakMap();

/**
 * @param {object} provider
 * @returns {Map<number, object[]>}
 */
export function getProviderRawCommentsCache(provider) {
  if (!provider || typeof provider !== 'object') return new Map();
  let map = _rawCommentsCache.get(provider);
  if (!map) {
    map = new Map();
    _rawCommentsCache.set(provider, map);
  }
  return map;
}

/**
 * @param {object} provider
 * @param {number} ticketId
 */
export function invalidateRawCommentsCache(provider, ticketId) {
  if (!provider || typeof provider !== 'object') return;
  const map = _rawCommentsCache.get(provider);
  if (!map) return;
  map.delete(ticketId);
}

/**
 * @param {object} [provider]
 */
export function _resetRawCommentsCache(provider) {
  if (provider && typeof provider === 'object') {
    _rawCommentsCache.delete(provider);
  }
}

/**
 * @param {object} [provider] Clears that provider's cache; otherwise no-op.
 */
export function _resetStructuredCommentCache(provider) {
  if (provider && typeof provider === 'object') {
    _structuredCommentCache.delete(provider);
  }
}

/**
 * Read-only view of a provider's cache (do not mutate).
 *
 * @param {object} [provider]
 */
export function _peekStructuredCommentCache(provider) {
  if (provider && typeof provider === 'object') {
    return _structuredCommentCache.get(provider) ?? new Map();
  }
  return new Map();
}

/**
 * Latest comment carrying `structuredCommentMarker(type, attrs)`; memoised
 * per `(ticketId, type, attrs)`, including misses.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type
 * @param {Record<string, string|number>} [attrs]
 * @returns {Promise<object|null>} Raw comment object, or null if none found.
 */
export async function findStructuredComment(
  provider,
  ticketId,
  type,
  attrs = null,
) {
  const cacheKey = structuredCommentCacheKey(ticketId, type, attrs);
  const cache = getProviderCommentCache(provider);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const marker = structuredCommentMarker(type, attrs);
  const rawCache = getProviderRawCommentsCache(provider);
  let comments;
  if (rawCache.has(ticketId)) {
    comments = rawCache.get(ticketId);
  } else {
    comments = (await provider.getTicketComments(ticketId)) ?? [];
    rawCache.set(ticketId, comments);
  }
  // Comments sort ascending by creation; take the last match.
  const matches = comments.filter(
    (c) => typeof c.body === 'string' && c.body.includes(marker),
  );
  const resolved = matches.length === 0 ? null : matches[matches.length - 1];
  cache.set(cacheKey, resolved);
  return resolved;
}
