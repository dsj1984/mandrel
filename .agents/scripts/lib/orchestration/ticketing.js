/**
 * lib/orchestration/ticketing.js — Ticketing Operations SDK
 *
 * Stateless logic for updating ticket states, toggling checkboxes,
 * posting comments, and cascading completions.
 *
 * This module is the SDK layer — it delegates all API calls to the
 * provided ITicketingProvider instance.
 */

import { extractEpicIdFromBody } from '../dependency-parser.js';
import { Logger } from '../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import {
  eventSeverity,
  renderTransitionMessage,
} from '../notifications/notifier.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { WAVE_MARKER_RE } from './wave-marker.js';

/**
 * Cap on concurrent sibling re-reads inside `cascadeCompletion`. Bounded to
 * keep wide tasklists (many siblings under one parent) from saturating the
 * provider's connection pool while still amortising network latency.
 */
const CASCADE_SIBLING_READ_CONCURRENCY = 8;

export const STATE_LABELS = {
  READY: AGENT_LABELS.READY,
  EXECUTING: AGENT_LABELS.EXECUTING,
  DONE: AGENT_LABELS.DONE,
};

const ALL_STATES = Object.values(STATE_LABELS);

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
  // Story #908 — /story-execute upserts a `story-run-progress` snapshot
  // on each Story per Task transition. The /epic-deliver aggregator and
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
]);

export const WAVE_TYPE_PATTERN = WAVE_MARKER_RE;

/**
 * Pool-mode claim-comment marker. One marker per story-id (the comment is
 * upserted, so racing claims on the same story collapse to a single
 * authoritative entry — the label set is the actual race-detection signal).
 * Bounded to 1-9 digits to mirror the wave-marker safety margin.
 */
const CLAIM_TYPE_PATTERN = /^claim-([0-9]{1,9})$/;

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isValidStructuredCommentType(type) {
  if (typeof type !== 'string' || type.length === 0) return false;
  return (
    STRUCTURED_COMMENT_TYPES.includes(type) ||
    WAVE_TYPE_PATTERN.test(type) ||
    CLAIM_TYPE_PATTERN.test(type)
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
      `Accepted: ${STRUCTURED_COMMENT_TYPES.join(', ')} or patterns ${WAVE_TYPE_PATTERN}, ${CLAIM_TYPE_PATTERN}.`,
  );
}

/**
 * Transitions a ticket's label to the new state.
 * Removes other agent:: state labels.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} newState - Must be one of STATE_LABELS.
 * @param {{ notify?: Function }} [opts] - Optional notify function (the
 *   exported `notify(ticketId, payload, opts)` from `notify.js`, or any
 *   stub matching its shape). When provided, a state-transition
 *   notification fires after a successful transition. Story/Epic →
 *   `agent::done` events are dispatched as `medium`; all other transitions
 *   are `low` and filtered out at the default `medium` channel thresholds.
 *   The dispatched payload carries the typed envelope fields
 *   (`event: 'state-transition'`, `level: 'task'|'story'|'wave'|'epic'`,
 *   `epicId`) for routable webhook subscribers.
 */
export async function transitionTicketState(
  provider,
  ticketId,
  newState,
  opts = {},
) {
  if (!ALL_STATES.includes(newState)) {
    throw new Error(`Invalid state: ${newState}`);
  }

  const toRemove = ALL_STATES.filter((state) => state !== newState);

  // Snapshot prior state for the notification payload (best-effort; skip on
  // error). A transient read failure MUST NOT block a label transition —
  // the transition itself is idempotent and `fromState: null` is a valid
  // payload value.
  let fromState = null;
  let ticketSnapshot = null;
  if (opts.notify && typeof provider.getTicket === 'function') {
    try {
      ticketSnapshot = await provider.getTicket(ticketId);
      fromState =
        ticketSnapshot?.labels?.find((l) => ALL_STATES.includes(l)) ?? null;
    } catch (err) {
      Logger.debug(
        `[Ticketing] fromState lookup failed for #${ticketId}: ${err.message ?? err}`,
      );
    }
  }

  // Closing/reopening mirrors the label state so GitHub shows the correct
  // issue state without requiring a separate manual close step.
  const isDone = newState === STATE_LABELS.DONE;

  await provider.updateTicket(ticketId, {
    labels: {
      add: [newState],
      remove: toRemove,
    },
    state: isDone ? 'closed' : 'open',
    state_reason: isDone ? 'completed' : null,
  });

  // Automatically trigger upward cascade when a ticket is completed.
  // This ensures parents (Stories, Features) close as soon as their last
  // child is marked done. Per-parent failures are aggregated by
  // `cascadeCompletion`; surface any to the operator so a partial close
  // doesn't look like a clean one.
  if (isDone) {
    const cascade = await cascadeCompletion(provider, ticketId, {
      notify: opts.notify,
    });
    // Iterable hoisted out of the `for...of` initializer because the
    // typhonjs-escomplex maintainability analyser mis-parses optional
    // chaining inside that position (`traveler[node.type] is not a function`).
    const cascadeFailures = cascade?.failed ?? [];
    for (const { parentId, error } of cascadeFailures) {
      Logger.warn(
        `[Ticketing] Cascade from #${ticketId} hit partial-failure on parent #${parentId}: ${error}`,
      );
    }
  }

  // Fire the state-transition notification (fire-and-forget).
  if (typeof opts.notify === 'function') {
    const typeLabel =
      ticketSnapshot?.labels?.find((l) => l.startsWith('type::')) ?? '';
    const ticketType = typeLabel.replace(/^type::/, '') || 'ticket';
    const epicId = extractEpicIdFromBody(ticketSnapshot?.body) ?? null;
    const event = {
      kind: 'state-transition',
      ticket: {
        id: ticketId,
        title: ticketSnapshot?.title,
        type: ticketType,
      },
      fromState,
      toState: newState,
    };
    const severity = eventSeverity(event);
    const message = renderTransitionMessage(event);
    // Post to the epic so operators get a single timeline feed; fall back
    // to the transitioned ticket itself when no epic reference is present.
    // The dispatch is fire-and-forget by design (a failed notification must
    // not block the state transition itself), but surfacing the failure via
    // the logger preserves operator visibility — the previous empty-handler
    // .catch swallowed network blips and webhook 5xxs without any signal.
    const targetId = epicId ?? ticketId;
    const level =
      ticketType === 'epic' || ticketType === 'wave' || ticketType === 'story'
        ? ticketType
        : 'task';
    Promise.resolve(
      opts.notify(targetId, {
        severity,
        message,
        event: 'state-transition',
        level,
        epicId: epicId ?? undefined,
      }),
    ).catch((err) => {
      Logger.warn(
        `[Ticketing] notify dispatch failed for #${targetId}: ${err?.message ?? err}`,
      );
    });
  }
}

/**
 * Mutates the tasklist checkbox in the parent's body.
 * E.g., `- [ ] #123` to `- [x] #123`
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId - ID of parent ticket
 * @param {number} subIssueId - ID of child ticket
 * @param {boolean} checked
 */
export async function toggleTasklistCheckbox(
  provider,
  ticketId,
  subIssueId,
  checked,
) {
  const ticket = await provider.getTicket(ticketId);
  const body = ticket.body || '';

  if (!body.includes(`#${subIssueId}`)) {
    return; // sub-issue not directly referenced in body
  }

  const targetBox = checked ? '- [x]' : '- [ ]';

  let newBody = body;

  if (checked) {
    // replace `- [ ] #123` or `- [] #123` with `- [x] #123`
    const re = new RegExp(`-\\s*\\[\\s*\\]\\s+#${subIssueId}\\b`, 'g');
    newBody = newBody.replace(re, `${targetBox} #${subIssueId}`);
  } else {
    // replace `- [x] #123` or `- [X] #123` with `- [ ] #123`
    const re = new RegExp(`-\\s*\\[[xX]\\]\\s+#${subIssueId}\\b`, 'g');
    newBody = newBody.replace(re, `${targetBox} #${subIssueId}`);
  }

  if (newBody !== body) {
    await provider.updateTicket(ticketId, {
      body: newBody,
    });
  }
}

/**
 * Post a structured comment to a ticket.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {'progress'|'friction'|'notification'} type
 * @param {string} payload
 */
export async function postStructuredComment(provider, ticketId, type, payload) {
  assertValidStructuredCommentType(type);
  await provider.postComment(ticketId, {
    type,
    body: payload,
  });
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
 * Find the most recent structured comment of a given type on a ticket.
 * Detection is based on the HTML marker produced by
 * `structuredCommentMarker(type, attrs)`.
 *
 * When `attrs` is provided, only comments whose marker carries the same
 * discriminator attributes are returned — see `structuredCommentMarker` for
 * the per-wave `wave-run-progress` use case.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
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
  const marker = structuredCommentMarker(type, attrs);
  const comments = (await provider.getTicketComments(ticketId)) ?? [];
  // Return latest match (comments API sorts ascending by creation; take last).
  const matches = comments.filter(
    (c) => typeof c.body === 'string' && c.body.includes(marker),
  );
  if (matches.length === 0) return null;
  return matches[matches.length - 1];
}

/**
 * Idempotently post a structured comment identified by an embedded HTML
 * marker. If an existing comment with the same `type` marker (and matching
 * `attrs`, when supplied) exists it is deleted first, then the new one is
 * posted. The marker is prepended to the body automatically.
 *
 * `attrs` lets the same `type` carry multiple in-place snapshots keyed by
 * an additional dimension — e.g., one `wave-run-progress` comment per wave
 * via `{ wave: N }` so the cross-wave rollup can read every wave's snapshot
 * instead of only the most recent one.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type - arbitrary structured-comment type (e.g.,
 *   `dispatch-manifest`, `retro`, `code-review`).
 * @param {string} body - markdown payload.
 * @param {Record<string, string|number>} [attrs]
 * @returns {Promise<{ commentId: number }>}
 */
export async function upsertStructuredComment(
  provider,
  ticketId,
  type,
  body,
  attrs = null,
) {
  assertValidStructuredCommentType(type);
  const marker = structuredCommentMarker(type, attrs);
  const existing = await findStructuredComment(provider, ticketId, type, attrs);

  if (existing && typeof provider.deleteComment === 'function') {
    try {
      await provider.deleteComment(existing.id);
    } catch (err) {
      Logger.warn(
        `[Ticketing] Failed to delete prior ${type} comment #${existing.id}: ${err.message}`,
      );
    }
  }

  const annotated = `${marker}\n\n${body}`;
  return provider.postComment(ticketId, { type, body: annotated });
}

/**
 * Recursively cascade upward.
 * If ticket reaches DONE, it toggles its checkbox in its parent.
 * Then checks if parent's sub-tickets are ALL DONE.
 * If yes, transitions parent to DONE and cascades up.
 *
 * Parents are processed **sequentially** (a `for ... of` over the parsed
 * parent list) so cascade logs preserve input order and concurrent
 * transitions cannot interleave when two parents share an ancestor. Within
 * each parent, sibling re-reads fan out via `concurrentMap` with a fixed
 * cap (8) — see `CASCADE_SIBLING_READ_CONCURRENCY`.
 *
 * Per-parent errors are isolated: a failure updating one parent (network,
 * permission, stale ticket) never discards progress on sibling parents.
 * Failures are collected and returned so callers can log them with full
 * ticket context instead of seeing a single rejection.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {{ notify?: Function }} [opts] - Forwarded to any recursive
 *   `transitionTicketState` fired on parent tickets.
 * @returns {Promise<{ cascadedTo: number[], failed: Array<{ parentId: number, error: string }> }>}
 */
export async function cascadeCompletion(provider, ticketId, opts = {}) {
  const ticket = await provider.getTicket(ticketId);

  // Determine if this ticket is agent::done
  if (!ticket.labels.includes(STATE_LABELS.DONE)) {
    return { cascadedTo: [], failed: [] };
  }

  const { blocks: parentIds } = await provider.getTicketDependencies(ticketId);

  // Fallback: parse `parent: #NNN` from the body when `blocks` syntax isn't used (C-5).
  let parsedParents = parentIds;
  if (!parsedParents || parsedParents.length === 0) {
    const parentMatch = ticket.body
      ? [...ticket.body.matchAll(/parent:\s*#(\d+)/gi)]
      : [];
    parsedParents = parentMatch.map((m) => Number.parseInt(m[1], 10));
  }

  const cascadedTo = [];
  const failed = [];

  // Outer parent loop is intentionally **sequential**. Cascades fan upward
  // (Story → Feature → Epic), and processing parents one at a time keeps the
  // cascade log readable in input order and avoids interleaved transitions
  // when two parents share an ancestor. Per-parent failures are caught so a
  // single bad parent never aborts the cascade for its siblings.
  for (const parentId of parsedParents) {
    try {
      await toggleTasklistCheckbox(provider, parentId, ticketId, true);

      const subTickets = await provider.getSubTickets(parentId);
      // Re-fetch each sibling with fresh reads before the all-done check.
      // `getSubTickets` populates each row via `getTicket`, which honors the
      // per-instance ticket cache — a stale CLOSED entry for a sibling that
      // has since been reopened (operator action, prior failed cascade) would
      // otherwise let the cascade close the parent while a sibling is still
      // open. Cache invalidation here is cheap (one HTTP read per sibling)
      // and only fires when the closing ticket itself reaches `agent::done`,
      // so the cost is bounded.
      //
      // The sibling-read fan-out is bounded via `concurrentMap` (cap=8) so a
      // wide tasklist does not saturate the provider's connection pool. The
      // mapper preserves input order and the per-row try/catch guarantees a
      // transient read failure falls back to the (possibly stale) row from
      // `getSubTickets` rather than rejecting the whole cascade.
      const freshSubTickets = await concurrentMap(
        subTickets,
        async (st) => {
          if (typeof provider.invalidateTicket === 'function') {
            try {
              provider.invalidateTicket(st.id);
            } catch {
              // Cache invalidation is best-effort — fall through to whatever
              // `getTicket` returns even if the invalidation hook throws.
            }
          }
          if (typeof provider.getTicket !== 'function') return st;
          try {
            return await provider.getTicket(st.id, { fresh: true });
          } catch {
            // A transient read failure must not silently flip the cascade
            // to "all done"; fall back to the (possibly stale) row from
            // `getSubTickets` so the existing label check still applies.
            return st;
          }
        },
        { concurrency: CASCADE_SIBLING_READ_CONCURRENCY },
      );
      const allDone = freshSubTickets.every(
        (st) => st.labels.includes(STATE_LABELS.DONE) || st.state === 'closed',
      );
      if (!allDone) continue;

      // EXCLUSION: Epics and Planning tickets (PRDs, Tech Specs) do not
      // auto-close via cascade.
      //   - Epics close via formal /epic-deliver (their own machinery
      //     handles branch merges, version bumps, release tags).
      //   - Planning tickets (context::prd, context::tech-spec) close by
      //     operator once the Epic is finalized.
      //
      // Features, by contrast, DO auto-close via cascade. A Feature is a
      // purely hierarchical grouping — no standalone branch, no merge
      // step. When its last child Story closes, the Feature is complete
      // by definition. Operators who need Feature-level AC verification
      // should encode it in the final child Story, not rely on a manual
      // close step.
      const parent = await provider.getTicket(parentId);
      const isEpic = parent.labels.includes(TYPE_LABELS.EPIC);
      const isPlanning =
        parent.labels.includes('context::prd') ||
        parent.labels.includes('context::tech-spec');
      if (isEpic || isPlanning) {
        Logger.warn(
          `[Ticketing] Cascade reached ${isEpic ? 'Epic' : 'Planning'} #${parentId}. Skipping auto-close (Epics close via the operator's PR merge; Planning tickets close manually post-merge).`,
        );
        continue;
      }

      await transitionTicketState(provider, parentId, STATE_LABELS.DONE, {
        notify: opts.notify,
      });
      await postStructuredComment(
        provider,
        parentId,
        'progress',
        'All child tickets completed via recursive cascade.',
      );
      cascadedTo.push(parentId);

      const nested = await cascadeCompletion(provider, parentId, {
        notify: opts.notify,
      });
      cascadedTo.push(...nested.cascadedTo);
      failed.push(...nested.failed);
    } catch (err) {
      failed.push({ parentId, error: err.message ?? String(err) });
      Logger.warn(
        `[Ticketing] Cascade to parent #${parentId} failed: ${err.message ?? err}`,
      );
    }
  }

  return { cascadedTo, failed };
}
