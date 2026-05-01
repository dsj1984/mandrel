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
import { WAVE_MARKER_RE } from './wave-marker.js';

export const STATE_LABELS = {
  READY: AGENT_LABELS.READY,
  EXECUTING: AGENT_LABELS.EXECUTING,
  REVIEW: AGENT_LABELS.REVIEW,
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
  // Story #913 — /wave-execute upserts a `wave-run-progress` snapshot on
  // the Epic per wave, listing each child Story's terminal status. The
  // progress reporter and `/epic-execute` rollup read these comments to
  // compose the cross-wave epic-run-progress view.
  'wave-run-progress',
  // Story #908 — /story-execute upserts a `story-run-progress` snapshot
  // on each Story per Task transition. The wave-run-progress aggregator
  // and the epic-runner progress reporter both read this comment to
  // derive Story-level state without re-fetching ticket labels.
  'story-run-progress',
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
 *   are `low` and filtered out at the default `notifications.minLevel`.
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
    Promise.resolve(opts.notify(targetId, { severity, message })).catch(
      (err) => {
        Logger.warn(
          `[Ticketing] notify dispatch failed for #${targetId}: ${err?.message ?? err}`,
        );
      },
    );
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
 * type. The marker is embedded in the comment body so it can be discovered
 * on read-back via `findStructuredComment`.
 *
 * @param {string} type
 * @returns {string}
 */
export function structuredCommentMarker(type) {
  return `<!-- ap:structured-comment type="${type}" -->`;
}

/**
 * Find the most recent structured comment of a given type on a ticket.
 * Detection is based on the HTML marker produced by
 * `structuredCommentMarker(type)`.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type
 * @returns {Promise<object|null>} Raw comment object, or null if none found.
 */
export async function findStructuredComment(provider, ticketId, type) {
  const marker = structuredCommentMarker(type);
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
 * marker. If an existing comment with the same `type` marker exists it is
 * deleted first, then the new one is posted. The marker is prepended to
 * the body automatically.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} type - arbitrary structured-comment type (e.g.,
 *   `dispatch-manifest`, `retro`, `code-review`).
 * @param {string} body - markdown payload.
 * @returns {Promise<{ commentId: number }>}
 */
export async function upsertStructuredComment(provider, ticketId, type, body) {
  assertValidStructuredCommentType(type);
  const marker = structuredCommentMarker(type);
  const existing = await findStructuredComment(provider, ticketId, type);

  if (existing && typeof provider.deleteComment === 'function') {
    try {
      await provider.deleteComment(existing.id);
    } catch (err) {
      console.warn(
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
 * Per-parent errors are isolated: a failure updating one parent (network,
 * permission, stale ticket) never discards progress on sibling parents.
 * Failures are collected and returned so callers can log them with full
 * ticket context instead of seeing a single Promise.all rejection.
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

  await Promise.all(
    parsedParents.map(async (parentId) => {
      try {
        await toggleTasklistCheckbox(provider, parentId, ticketId, true);

        const subTickets = await provider.getSubTickets(parentId);
        const allDone = subTickets.every(
          (st) =>
            st.labels.includes(STATE_LABELS.DONE) || st.state === 'closed',
        );
        if (!allDone) return;

        // EXCLUSION: Epics and Planning tickets (PRDs, Tech Specs) do not
        // auto-close via cascade.
        //   - Epics close via formal /epic-close (their own machinery
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
          console.warn(
            `[Ticketing] Cascade reached ${isEpic ? 'Epic' : 'Planning'} #${parentId}. Skipping auto-close (reserved for epic-close).`,
          );
          return;
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
        console.warn(
          `[Ticketing] Cascade to parent #${parentId} failed: ${err.message ?? err}`,
        );
      }
    }),
  );

  return { cascadedTo, failed };
}
