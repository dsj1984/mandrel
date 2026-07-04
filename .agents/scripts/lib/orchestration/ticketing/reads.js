/**
 * lib/orchestration/ticketing/reads.js — Ticketing read-side surface.
 *
 * Holds the read-only helpers, validators, and the process-level
 * structured-comment cache. Pure of state mutations; importing this
 * module never issues a `ticket-mutating` call to the provider.
 *
 * Split out of `../ticketing.js` under Story #1848 to keep the verb
 * families separated (`reads` / `state` / `bulk`). External callers
 * continue importing the same names from `../ticketing.js`, which
 * re-exports the surface defined here.
 */

import { AGENT_LABELS } from '../../label-constants.js';
import { WAVE_MARKER_RE } from '../wave-marker.js';

/**
 * Canonical agent-state label triad used by every state mutator. Kept on
 * the read side so `state.js` and `bulk.js` can both import without
 * pulling in any mutation helpers.
 */
export const STATE_LABELS = {
  READY: AGENT_LABELS.READY,
  EXECUTING: AGENT_LABELS.EXECUTING,
  // Story #2144 — intermediate state held by a Story between successful
  // close-preflight and a confirmed merge into `epic/<id>`. Included in
  // the state enum so `transitionTicketState` can apply the label via
  // the canonical one-state-at-a-time path (which removes every other
  // `agent::*` label in the same call) and so the read-side `ALL_STATES`
  // export — consumed by `state.js`'s `fromState` lookup — recognises
  // `agent::closing` as a valid prior state when a `--resume` flip back
  // to `done` fires post-merge.
  CLOSING: AGENT_LABELS.CLOSING,
  DONE: AGENT_LABELS.DONE,
  // Story #2004 — `agent::blocked` is the framework's single authoritative
  // HITL pause point (see `.agents/instructions.md` §1.J). Adding it to the
  // state enum lets `transitionTicketState` (and the
  // `update-ticket-state.js` CLI) apply the label through the canonical
  // one-state-at-a-time path; without it the workflow contract that names
  // `agent::blocked` cannot be honoured by the tooling.
  BLOCKED: AGENT_LABELS.BLOCKED,
};

/**
 * Frozen list of every recognised `agent::*` state label. Exposed for
 * downstream guards (e.g. transition predicates) that need to match
 * against the full set without re-enumerating `STATE_LABELS`.
 */
export const ALL_STATES = Object.values(STATE_LABELS);

/**
 * Enumerated structured-comment types accepted by `postStructuredComment` and
 * `upsertStructuredComment`. Parametric `wave-N-start` / `wave-N-end` types
 * are matched separately by {@link WAVE_TYPE_PATTERN}.
 */
export const STRUCTURED_COMMENT_TYPES = Object.freeze([
  // Legacy core set
  'progress',
  'friction',
  'notification',
  // Extended set (Story #449 — retro follow-ons)
  'code-review',
  'retro',
  'retro-partial',
  'epic-run-state',
  'epic-run-progress',
  'epic-plan-state',
  'parked-follow-ons',
  'dispatch-manifest',
  // Story #566 — per-phase wall-clock summary posted by story-close
  // and consumed by the epic-runner progress reporter to surface median /
  // p95 phase timings across completed stories.
  'phase-timings',
  // Story #831 — story-init upserts a `story-init` comment that
  // surfaces `dependenciesInstalled` (and the underlying installStatus) so
  // downstream workflow steps don't have to infer install state from
  // node_modules presence.
  'story-init',
  // Story #908 — /deliver upserts a `story-run-progress` snapshot
  // on each Story per Task transition. The /deliver aggregator and
  // the epic-runner progress reporter both read this comment to derive
  // Story-level state without re-fetching ticket labels.
  'story-run-progress',
  // Story #1123 — analyze-execution.js upserts perf summaries at close
  // time. Story-mode posts `story-perf-summary` on each Story; Epic-mode
  // posts `epic-perf-report` on the Epic. Both replace the legacy
  // per-Task `friction` fan-out and the standalone `phase-timings`
  // surface (Epic #1030).
  'story-perf-summary',
  'epic-perf-report',
  // Story #2128 — Phase 6 Epic Clarity Gate. `epic-plan-clarity.js` upserts
  // a `clarity-gate-update` comment on the Epic when the operator approves
  // a sharpened body rewrite, recording the persistence event for audit.
  'clarity-gate-update',
  // Story #2635 — Phase 7 Tech Spec freshness check. `epic-plan-spec.js`
  // upserts a `spec-freshness` comment on the Epic listing any
  // path-shaped references that don't exist at the base branch, so the
  // operator can correct drift before Phase 8 decomposes from a stale
  // spec. Advisory: the run continues regardless of the report contents.
  'spec-freshness',
  // Story #2681 — `/deliver` Phase 4 epic-audit helper upserts an
  // `audit-results` comment on the Epic listing the per-lens findings
  // returned by the change-set audit pass. The marker was prescribed by
  // `helpers/epic-audit.md` Step 4 long before it was added to this
  // registry; without the entry the helper's `post-structured-comment.js`
  // invocation always failed with "Invalid structured-comment type". One
  // entry per Epic; re-runs replace prior content.
  'audit-results',
  // Story #2813 — the per-Task progress writer (since retired under
  // #3157) upserted a `model-attribution` comment on a Task ticket at
  // the moment it transitioned to `agent::executing`, recording which
  // Claude model was actively executing the work. One entry per Task
  // (upsert is idempotent across resume re-runs). Story- and Epic-level
  // rollups are computed at query time by `rollupModelAttribution` in
  // `lib/orchestration/model-attribution.js` — no Story/Epic-scope
  // emissions are written. Schema:
  // `.agents/schemas/model-attribution.schema.json`.
  'model-attribution',
  // Story #2894 — `finalize/post-handoff-comment.js` upserts an
  // `epic-handoff` comment on the Epic at the end of the bus-owned
  // finalize flow (after `open-or-locate-pr`
  // succeed). The marker carries the freshly opened/located PR URL and
  // its number so operators can jump straight to the PR from the Epic
  // ticket. Re-invocations upsert the same marker rather than appending
  // duplicates.
  'epic-handoff',
  // Story #2899 (Epic #2880, F13) — `epic-deliver-preflight.js` upserts a
  // `delivery-preflight` comment on the Epic at the start of
  // /deliver Phase 1, surfacing estimated story count, install cost,
  // wave count, GitHub API request volume, Claude quota burn, and any
  // threshold breaches against `delivery.preflight.max*`. One entry per
  // Epic; re-runs replace prior content.
  'delivery-preflight',
  // Story #3062 (Epic #3051) — `wave-tick.js` upserts a
  // `recurring-failure-class` comment on the Epic when the cross-Story
  // detector finds two or more Stories that hit the same `failedGate` in
  // `close-validate.end`. One entry per Epic; re-ticks with the same
  // findings upsert in place (`upsertStructuredComment` diffs by body).
  'recurring-failure-class',
  // Story #3061 (Epic #3051) — the /deliver §2e Idle Watchdog
  // subsection instructs the parent host LLM to upsert a `wave-stall`
  // comment on the Epic whenever an in-flight Story has been silent for
  // longer than the configured cadence. `wave-tick.js --check-idle`
  // emits the matching envelope; registering the kind here is what makes
  // the documented remediation actually executable
  // (assertValidStructuredCommentType would otherwise throw).
  'wave-stall',
  // Story #3873 (Epic #3865) — `epic-plan-spec.js` upserts a `risk-verdict`
  // comment on the Epic at persist time, recording the planner-authored,
  // schema-validated risk verdict and the planningRisk envelope derived
  // from it (`deriveRiskEnvelope`). One entry per Epic; re-plans upsert in
  // place. Schema: `.agents/schemas/risk-verdict.schema.json`.
  'risk-verdict',
  // Story #4019 — `epic-plan-lease-guard.js` upserts a `plan-lease`
  // comment on the Epic at lease-acquire time, recording the claiming
  // operator and the claim timestamp. `/plan` emits no
  // `story.heartbeat`, so this claim-time is the liveness signal that
  // makes the documented `--steal` contract decidable: a foreign claim
  // older than the lease TTL is reclaimed automatically; a fresh one
  // refuses with the claim age. One entry per Epic; re-acquires upsert
  // in place.
  'plan-lease',
]);

export const WAVE_TYPE_PATTERN = WAVE_MARKER_RE;

/**
 * Pool-mode claim-comment marker. One marker per story-id (the comment is
 * upserted, so racing claims on the same story collapse to a single
 * authoritative entry — the label set is the actual race-detection signal).
 * Bounded to 1-9 digits to mirror the wave-marker safety margin.
 */
export const CLAIM_TYPE_PATTERN = /^claim-([0-9]{1,9})$/;

/**
 * Lifecycle-listener marker pattern (Story #2239 / #2241 / #2242). The
 * lifecycle StructuredCommentPoster writes minimal markers prefixed with
 * `lifecycle-` (e.g. `lifecycle-wave-0-start`, `lifecycle-epic-blocked`,
 * `lifecycle-epic-unblocked`). Treated as a generic prefix so future
 * listener-owned events can mint new markers without touching this enum.
 */
export const LIFECYCLE_TYPE_PATTERN = /^lifecycle-[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
 * Throws if `type` is not a recognized structured-comment type. Error
 * message lists the accepted enum plus the wave pattern to make the
 * schema discoverable from the failure alone.
 *
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
 * Build an HTML marker that uniquely identifies a structured comment by
 * type plus an optional discriminator attribute bag. The marker is embedded
 * in the comment body so it can be discovered on read-back via
 * `findStructuredComment`.
 *
 * `attrs` lets a single `type` namespace coexist with multiple in-place
 * snapshots keyed by an additional dimension. The canonical use is the
 * per-wave `wave-run-progress` comment: each wave upserts its own snapshot
 * via `{ wave: N }` so subsequent waves don't overwrite prior rows.
 * Without the discriminator the next wave's upsert finds (and deletes) the
 * prior wave's comment, leaving the cross-wave epic-run-progress rollup
 * with a single row.
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
 * Per-provider cache mapping `${ticketId}|${type}|${attrsHash}` to the
 * comment id (and the cached comment payload) returned by the most
 * recent `findStructuredComment` / `upsertStructuredComment` call.
 * Story #1795 — every Epic run owns its process for the duration of
 * the run, so a single seed-then-reuse window saves one
 * `getTicketComments` per repeat upsert on the hot path (wave-level
 * `story-run-progress`, `wave-N-end`, etc).
 *
 * Lifecycle:
 *   - First call to `findStructuredComment(provider, t, type, attrs)`
 *     hits `getTicketComments` and seeds the cache with the resolved
 *     comment (or `null` to record the "no comment yet" miss).
 *   - Subsequent calls with the same provider return the cached row
 *     without a list call.
 *   - `upsertStructuredComment` refreshes the cache to the new
 *     comment id after `postComment` succeeds.
 *   - `deleteComment` paths inside this module evict the entry.
 *
 * Cache is scoped to the provider instance via a WeakMap — different
 * providers (including per-test fakes) get isolated caches so state
 * cannot leak across boundaries. Tests reset via the exported
 * `_resetStructuredCommentCache()` seam.
 */
export const _structuredCommentCache = new WeakMap();

/**
 * Build a well-formed ticket snapshot for a Story that has zero child
 * Tasks. Story #3097 (Wave-0 additive, Epic #3078 Strategy B) — the
 * 2-tier hierarchy collapses Epic → Story → Task into
 * Epic → Story, so a Story may legitimately have no Task
 * children. Read-side callers that expect a `subTickets` array on the
 * Story can route through this helper to materialise an empty-children
 * snapshot without paying a provider round-trip and without risk of
 * `undefined.map` dereferences. Pure / synchronous; never touches the
 * provider.
 *
 * The function preserves every field on the input `ticket` and merely
 * pins `subTickets` to `[]` when omitted. Callers that already hold a
 * resolved children list pass it through; the Storyless path is the
 * default.
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
 * Lookup (or lazily create) the per-provider cache map.
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
 * Build a stable cache key for `(ticketId, type, attrs)`. Attrs object
 * is normalised by sorted JSON so equivalent keys collide. Story #1795.
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
 * Per-provider raw-comments cache mapping ticketId → the full comment
 * array returned by the most recent `provider.getTicketComments(ticketId)`
 * call. Story #2465 — `findStructuredComment` is invoked back-to-back for
 * different `type` discriminators against the same ticket (e.g.
 * `story-run-progress` + `epic-run-progress` + a `friction` probe during
 * an Epic-close wave). Without this cache each lookup pays a full
 * pagination round-trip even when the prior call already fetched the
 * same comments. The structured-comment-id cache short-circuits *repeat*
 * lookups for the same `(type, attrs)` tuple but does not help across
 * different types on the same ticket.
 *
 * Lifecycle:
 *   - `findStructuredComment` consults this raw cache before issuing
 *     `provider.getTicketComments`; on cache miss it seeds the entry
 *     from the response.
 *   - `postStructuredComment` and `upsertStructuredComment` evict the
 *     entry for the mutated ticketId — any cached array is stale once
 *     a new comment lands.
 *   - Scoped per-provider via WeakMap so test fakes never share state
 *     with the real GitHubProvider.
 */
export const _rawCommentsCache = new WeakMap();

/**
 * Lookup (or lazily create) the per-provider raw-comments cache.
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
 * Evict the cached raw-comments array for a given ticket on a provider.
 * Called from the structured-comment write paths after a `postComment`
 * lands. Safe to call when no entry exists.
 *
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
 * Test seam — reset the raw-comments cache for a provider. Mirrors
 * `_resetStructuredCommentCache` for the structured-id cache.
 *
 * @param {object} [provider]
 */
export function _resetRawCommentsCache(provider) {
  if (provider && typeof provider === 'object') {
    _rawCommentsCache.delete(provider);
  }
}

/**
 * Test seam — reset the structured-comment ID cache.
 * Exported so unit tests can isolate cases without restarting the
 * process. Without arguments the entire WeakMap is dropped by
 * reassigning the per-provider map of every known provider — in
 * practice tests just hand in their fresh provider instance which
 * has no cached state yet. Production callers never invoke this.
 *
 * @param {object} [provider] When supplied, clears just that
 *   provider's cache; otherwise no-op (per-provider caches are
 *   already isolated by WeakMap and tests creating fresh providers
 *   get clean state automatically).
 */
export function _resetStructuredCommentCache(provider) {
  if (provider && typeof provider === 'object') {
    _structuredCommentCache.delete(provider);
  }
}

/**
 * Test seam — peek at a provider's cache contents. Returns the raw
 * Map for read-only inspection (do not mutate). Story #1795.
 *
 * @param {object} [provider] If supplied, returns that provider's
 *   cache Map; otherwise returns an empty Map for callers that just
 *   want a stable shape.
 */
export function _peekStructuredCommentCache(provider) {
  if (provider && typeof provider === 'object') {
    return _structuredCommentCache.get(provider) ?? new Map();
  }
  return new Map();
}

/**
 * Find the most recent structured comment of a given type on a ticket.
 * Detection is based on the HTML marker produced by
 * `structuredCommentMarker(type, attrs)`.
 *
 * When `attrs` is provided, only comments whose marker carries the same
 * discriminator attributes are returned — see `structuredCommentMarker` for
 * the per-wave `wave-run-progress` use case.
 *
 * Story #1795 — results are memoised in a process-level cache keyed by
 * `(ticketId, type, attrsHash)`. The first call seeds the cache with
 * the resolved comment (or `null` for the "no such comment yet" miss);
 * every subsequent call returns the cached row without issuing another
 * `getTicketComments`. `upsertStructuredComment` refreshes the cache
 * after a successful repost, and its delete path evicts the entry.
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
  // Story #2465 — consult the per-ticketId raw-comments cache before
  // hitting the wire. Two back-to-back `findStructuredComment` calls for
  // different types against the same ticket would otherwise both pay a
  // full `getTicketComments` round-trip.
  const rawCache = getProviderRawCommentsCache(provider);
  let comments;
  if (rawCache.has(ticketId)) {
    comments = rawCache.get(ticketId);
  } else {
    comments = (await provider.getTicketComments(ticketId)) ?? [];
    rawCache.set(ticketId, comments);
  }
  // Return latest match (comments API sorts ascending by creation; take last).
  const matches = comments.filter(
    (c) => typeof c.body === 'string' && c.body.includes(marker),
  );
  const resolved = matches.length === 0 ? null : matches[matches.length - 1];
  cache.set(cacheKey, resolved);
  return resolved;
}
