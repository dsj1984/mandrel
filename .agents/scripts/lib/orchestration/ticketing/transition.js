/**
 * lib/orchestration/ticketing/transition.js — Single-ticket state mutators:
 * state-label transitions, tasklist checkbox toggling, structured comments.
 *
 * A leaf module: the upward cascade lives in `bulk.js` and `state.js` injects
 * it via {@link registerCascadeRunner}, so both depend downward on this file
 * without a cycle.
 */

import { extractEpicIdFromBody } from '../../dependency-parser.js';
import { Logger } from '../../Logger.js';
import {
  eventSeverity,
  renderTransitionMessage,
} from '../../notifications/notifier.js';
import {
  emitBlockRecoveredFriction,
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../observability/runtime-friction.js';
import { ColumnSync } from '../column-sync.js';
import {
  ALL_STATES,
  assertValidStructuredCommentType,
  invalidateRawCommentsCache,
  STATE_LABELS,
} from './reads.js';

/**
 * Injected upward-cascade runner; a no-op until `state.js` registers the real
 * one at module load, so this module is safe to use in isolation.
 *
 * @type {(provider: object, ticketId: number, opts: object) => Promise<void>}
 */
let _runUpwardCascade = async () => {};

/**
 * Called once by `state.js` at module-evaluation time.
 *
 * @param {(provider: object, ticketId: number, opts: object) => Promise<void>} runner
 */
export function registerCascadeRunner(runner) {
  if (typeof runner === 'function') {
    _runUpwardCascade = runner;
  }
}

/**
 * One `ColumnSync` per provider for the process lifetime, so its cached
 * project metadata is fetched once per run rather than once per label flip.
 */
const _columnSyncRegistry = new WeakMap();

/**
 * @param {object} provider
 */
export function _resetColumnSyncCache(provider) {
  _columnSyncRegistry.delete(provider);
}

/**
 * @param {string} newState - Target `agent::*` label.
 * @returns {string} The validated newState, returned for fluent reuse.
 * @throws {Error} when `newState` is not a recognised state label.
 */
function validateTransitionInputs(newState) {
  if (!ALL_STATES.includes(newState)) {
    throw new Error(`Invalid state: ${newState}`);
  }
  return newState;
}

/**
 * Active states a blocked Story can recover into; `done`/`closing` are real
 * terminal outcomes, not recoveries.
 */
const BLOCK_RECOVERY_TARGETS = [STATE_LABELS.EXECUTING, STATE_LABELS.READY];

/**
 * Resolve the pre-transition snapshot, honoring `opts.ticketSnapshot`. Loaded
 * only when `notify` needs `fromState` or `needFromState` is set (recovery
 * detection must read the prior label before `updateTicket` overwrites it).
 * Returns `null` on transient failure.
 *
 * @param {object} provider
 * @param {{ notify?: Function, ticketSnapshot?: object|null }} opts
 * @param {number} ticketId
 * @param {boolean} [needFromState]
 * @returns {Promise<object|null>}
 */
async function loadTicketSnapshot(provider, opts, ticketId, needFromState) {
  if (opts.ticketSnapshot) return opts.ticketSnapshot;
  if (
    (!opts.notify && !needFromState) ||
    typeof provider.getTicket !== 'function'
  ) {
    return null;
  }
  try {
    return await provider.getTicket(ticketId);
  } catch (err) {
    Logger.debug(
      `[Ticketing] fromState lookup failed for #${ticketId}: ${err.message ?? err}`,
    );
    return null;
  }
}

/**
 * Mirror the new state onto the Projects v2 Status column. Best-effort: a
 * board failure is logged and never blocks the label transition. An injected
 * `_makeColumnSync` bypasses the registry so test stubs are never cached.
 *
 * @param {object} provider
 * @param {number} ticketId
 * @param {string} newState
 * @param {(opts: object) => { sync: (id: number, labels: string[]) => Promise<object> }} [_makeColumnSync]
 */
async function syncProjectStatusColumn(
  provider,
  ticketId,
  newState,
  _makeColumnSync,
  config,
) {
  try {
    let sync;
    if (_makeColumnSync) {
      sync = _makeColumnSync({ provider, logger: Logger });
    } else {
      // `config` is read at construction only; the first instance per
      // provider wins, so a later transition's config is ignored.
      if (!_columnSyncRegistry.has(provider)) {
        _columnSyncRegistry.set(
          provider,
          new ColumnSync({ provider, logger: Logger, config }),
        );
      }
      sync = _columnSyncRegistry.get(provider);
    }
    await sync.sync(ticketId, [newState]);
  } catch (err) {
    Logger.warn(
      `[Ticketing] column sync failed for #${ticketId} → ${newState}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Fire-and-forget state-transition notification, posted to the Epic when one
 * is referenced (else the ticket itself); failures are logged, not thrown.
 *
 * @param {{
 *   notify: Function,
 *   ticketId: number,
 *   ticketSnapshot: object|null,
 *   fromState: string|null,
 *   newState: string,
 * }} args
 */
function dispatchTransitionNotification(args) {
  const { notify, ticketId, ticketSnapshot, fromState, newState } = args;
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
  // The channel is event-allowlist gated, so the low-severity noise filter
  // lives at the emit point.
  if (severity === 'low') return;
  const message = renderTransitionMessage(event);
  const targetId = epicId ?? ticketId;
  const level =
    ticketType === 'epic' || ticketType === 'wave' || ticketType === 'story'
      ? ticketType
      : 'task';
  Promise.resolve(
    notify(targetId, {
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

/**
 * Emit a `story-blocked` friction signal on entering `agent::blocked` (the
 * single HITL pause point, so this one hook catches every block), or a
 * recovery marker on `blocked → active` so the retro can net out transient
 * blocks. The terminal-envelope hook skips `blocked` to avoid double counting.
 *
 * Awaited, not fire-and-forget: CLI entry points `process.exit` as soon as
 * `main` resolves, which would drop a pending append. The emitters never throw.
 *
 * @param {number} ticketId
 * @param {string|null} fromState  Prior state label, or null.
 * @param {string} newState
 * @param {{ config?: object }} opts
 * @returns {Promise<void>}
 */
async function emitBlockedFriction(ticketId, fromState, newState, opts) {
  if (newState === STATE_LABELS.BLOCKED) {
    await emitRuntimeFriction({
      storyId: ticketId,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 'transitionTicketState',
      details: { toState: newState },
      config: opts?.config,
    });
    return;
  }
  if (
    fromState === STATE_LABELS.BLOCKED &&
    BLOCK_RECOVERY_TARGETS.includes(newState)
  ) {
    await emitBlockRecoveredFriction({
      storyId: ticketId,
      fromState,
      toState: newState,
      config: opts?.config,
    });
  }
}

/**
 * Set a ticket's `agent::*` state label, removing the others; `done` also
 * closes the issue.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} newState - Must be one of STATE_LABELS.
 * @param {{ notify?: Function, cascade?: boolean, ticketSnapshot?: object, _makeColumnSync?: Function }} [opts]
 *   `notify` fires a state-transition notification after success.
 *   `cascade: false` suppresses the upward parent cascade.
 *   `ticketSnapshot` is a pre-fetched ticket that saves the `fromState` read
 *   and the provider's label-merge read. `_makeColumnSync` is a test seam.
 */
export async function transitionTicketState(
  provider,
  ticketId,
  newState,
  opts = {},
) {
  validateTransitionInputs(newState);

  const toRemove = ALL_STATES.filter((state) => state !== newState);

  const ticketSnapshot = await loadTicketSnapshot(
    provider,
    opts,
    ticketId,
    BLOCK_RECOVERY_TARGETS.includes(newState),
  );
  const fromState =
    ticketSnapshot?.labels?.find((l) => ALL_STATES.includes(l)) ?? null;

  const isDone = newState === STATE_LABELS.DONE;

  await provider.updateTicket(ticketId, {
    labels: {
      add: [newState],
      remove: toRemove,
    },
    state: isDone ? 'closed' : 'open',
    state_reason: isDone ? 'completed' : null,
    // Provider-internal: lets the label merge skip its own getTicket.
    _ticketSnapshot: ticketSnapshot,
  });

  await emitBlockedFriction(ticketId, fromState, newState, opts);

  await syncProjectStatusColumn(
    provider,
    ticketId,
    newState,
    opts._makeColumnSync,
    opts.config,
  );

  // Every transition re-derives parent state from children (not just `done`),
  // keeping the board accurate when work starts or a child blocks.
  if (opts.cascade !== false) {
    await _runUpwardCascade(provider, ticketId, {
      notify: opts.notify,
    });
  }

  if (typeof opts.notify === 'function') {
    dispatchTransitionNotification({
      notify: opts.notify,
      ticketId,
      ticketSnapshot,
      fromState,
      newState,
    });
  }
}

/**
 * Toggle `- [ ] #N` ↔ `- [x] #N` in the parent's body.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId - ID of parent ticket
 * @param {number} subIssueId - ID of child ticket
 * @param {{ checked: boolean }} opts
 */
export async function toggleTasklistCheckbox(
  provider,
  ticketId,
  subIssueId,
  { checked },
) {
  const ticket = await provider.getTicket(ticketId);
  const body = ticket.body || '';

  if (!body.includes(`#${subIssueId}`)) {
    return;
  }

  const targetBox = checked ? '- [x]' : '- [ ]';

  let newBody = body;

  if (checked) {
    const re = new RegExp(`-\\s*\\[\\s*\\]\\s+#${subIssueId}\\b`, 'g');
    newBody = newBody.replace(re, `${targetBox} #${subIssueId}`);
  } else {
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
 * Post a structured comment and evict the raw-comments cache so the next
 * read sees it.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {'progress'|'friction'|'notification'} type
 * @param {string} payload
 * @returns {Promise<unknown>} The provider's `postComment` result (may be
 *   `undefined`; treat any id as best-effort).
 */
export async function postStructuredComment(provider, ticketId, type, payload) {
  assertValidStructuredCommentType(type);
  const posted = await provider.postComment(ticketId, {
    type,
    body: payload,
  });
  invalidateRawCommentsCache(provider, ticketId);
  return posted;
}
