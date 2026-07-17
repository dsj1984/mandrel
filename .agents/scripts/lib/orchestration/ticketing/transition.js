/**
 * lib/orchestration/ticketing/transition.js — Single-ticket state mutators.
 *
 * Owns the one-ticket-at-a-time mutation surface: state-label
 * transitions, tasklist checkbox toggling, and structured-comment
 * posting. Extracted from `./state.js` under Story #3995 to break the
 * `state.js ↔ bulk.js` import cycle: `bulk.js`'s cascade walk needs these
 * single-ticket primitives, and `transitionTicketState` needs the upward
 * cascade. Pulling the primitives down into this leaf lets both
 * `state.js` and `bulk.js` depend **downward** on `transition.js`, so the
 * dependency graph is a DAG.
 *
 * Cascade wiring: `transitionTicketState` fires the upward parent cascade
 * (which lives in `bulk.js`) on every transition unless `cascade: false`.
 * To keep this module a leaf, the cascade implementation is **injected**
 * via {@link registerCascadeRunner} rather than imported. `bulk.js`
 * registers the real runner at module-evaluation time; until it does,
 * the cascade step is a safe no-op. Every production path that fires a
 * transition reaches `bulk.js` (directly, through the `./ticketing.js`
 * facade, or through `./state.js`, all of which load `bulk.js`), so the
 * runner is always registered before a cascade-bearing transition runs.
 *
 * Story #3661 — `_columnSyncRegistry` is a module-level WeakMap that
 * retains one `ColumnSync` instance per provider for the lifetime of the
 * process. `ColumnSync` already caches the project metadata (projectId,
 * fieldId, option ids) inside the instance after the first GraphQL fetch
 * (`this._meta`), but that cache was discarded on every label transition
 * because `syncProjectStatusColumn` constructed a fresh instance each
 * call. The registry lets the instance — and therefore its `_meta`
 * cache — survive across transitions, so the invariant metadata is
 * resolved exactly once per run rather than once per label flip.
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
 * Injected upward-cascade runner. `bulk.js` registers the real
 * implementation (`cascadeParentState` + `logCascadePartialFailures`) at
 * module load via {@link registerCascadeRunner}; until then this no-op
 * default keeps `transitionTicketState` safe to call in isolation (e.g.
 * a unit test that imports only this module).
 *
 * @type {(provider: object, ticketId: number, opts: object) => Promise<void>}
 */
let _runUpwardCascade = async () => {};

/**
 * Register the upward-cascade runner. Called once by `bulk.js` at
 * module-evaluation time to wire its `cascadeParentState` /
 * `logCascadePartialFailures` pair into `transitionTicketState` without
 * `transition.js` importing `bulk.js` (which would re-introduce the
 * Story #3995 cycle).
 *
 * @param {(provider: object, ticketId: number, opts: object) => Promise<void>} runner
 */
export function registerCascadeRunner(runner) {
  if (typeof runner === 'function') {
    _runUpwardCascade = runner;
  }
}

/**
 * One `ColumnSync` instance per provider, retained for the process
 * lifetime so the invariant project metadata (`projectId`, `fieldId`,
 * option ids) is fetched exactly once per run regardless of how many
 * label transitions fire. The `ColumnSync` instance already caches
 * the metadata internally (`_meta`), but that cache was thrown away on
 * every call to `syncProjectStatusColumn` because the function
 * constructed a fresh instance each time. Story #3661.
 *
 * `WeakMap` keys are GC-friendly: when a provider is collected the
 * entry is automatically removed without a manual eviction step.
 */
const _columnSyncRegistry = new WeakMap();

/**
 * Drop the cached `ColumnSync` for a given provider. Exposed as a
 * named export so unit tests that swap providers between assertions can
 * reset the registry without reloading the module.
 *
 * @param {object} provider
 */
export function _resetColumnSyncCache(provider) {
  _columnSyncRegistry.delete(provider);
}

/**
 * Guard the inputs to {@link transitionTicketState}. Extracted from the
 * outer function so that the per-method cyclomatic complexity of
 * `transitionTicketState` lands below the CRAP-12 ceiling required by
 * Story #1848 (was CRAP 16 prior to the split — see baselines/crap.json).
 *
 * Currently a single label-membership predicate, but extracting it as a
 * named function lets future input guards (e.g. provider-shape checks,
 * concurrency-token validation) accrete here without re-inflating the
 * caller's complexity.
 *
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
 * Active states a `agent::blocked` Story can recover into (Story #4622). A
 * `blocked → {executing|ready}` transition is a self-resolved block; every
 * other target (`done`, `closing`) is a real terminal outcome, not a
 * recovery.
 */
const BLOCK_RECOVERY_TARGETS = [STATE_LABELS.EXECUTING, STATE_LABELS.READY];

/**
 * Resolve the pre-transition ticket snapshot that drives the notify
 * payload and the provider's label-merge path. Honors the caller-supplied
 * `opts.ticketSnapshot` (Story #1795) when present; otherwise issues a
 * best-effort `getTicket` and returns `null` on transient failure.
 *
 * The snapshot is loaded when a caller threads `notify` (its `fromState`
 * feeds the notification payload) OR when `needFromState` is set — Story
 * #4622's recovery detection needs the *prior* state, and `getTicket` after
 * `updateTicket` would already read the new label. Bounding the extra read
 * to recovery-target transitions keeps every other flip on the snapshot-free
 * fast path.
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
 * Mirror the post-flip label set onto the GitHub Projects v2 Status
 * column. Story #2548 — wiring this here makes every caller of
 * `transitionTicketState` (`single-story-init.js`, `single-story-close.js`,
 * `story-phase.js`, the LabelTransitioner lifecycle listener, the
 * update-ticket-state CLI, batch transitions) update the board automatically.
 * Prior to #2548 the sync was only wired from the deleted epic-runner against
 * the Epic ticket, so Stories and Tasks never had their `agent::executing` /
 * `agent::blocked` flips reflected on the board.
 *
 * Best-effort: a project-board misconfig, missing scope, or transient
 * GraphQL failure MUST NOT block the label transition itself. Errors
 * surface via `Logger.warn` and the function resolves cleanly.
 *
 * The `_makeColumnSync` default param is a DIP seam: production callers
 * accept the default (which constructs a real `ColumnSync`); tests inject
 * a factory stub that avoids the GraphQL dependency without mocking the
 * module. Story #3645.
 *
 * Story #3661 — when the caller uses the default factory (i.e. did not
 * inject a stub), the function looks up or creates a `ColumnSync`
 * instance in `_columnSyncRegistry` keyed by `provider`. This keeps the
 * instance — and therefore its `_meta` cache — alive across transitions
 * so the invariant project metadata is fetched exactly once per run.
 * Test-injected factories bypass the registry entirely; their synthetic
 * stubs are never stored in `_columnSyncRegistry`.
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
      // Test-injected factory: bypass the registry so stubs are never
      // accidentally cached and reused in subsequent calls.
      sync = _makeColumnSync({ provider, logger: Logger });
    } else {
      // Production path: look up or create the per-provider instance.
      // The instance's `_meta` cache survives across label transitions
      // so the invariant project metadata (projectId, fieldId, options)
      // is only fetched once per process run. Story #3661.
      //
      // Story #4252 — `config` is threaded so the on-disk board-metadata
      // cache lands under the project's configured tempRoot. It is read at
      // construction only; the registry caches the first instance per
      // provider, so a later transition's config is intentionally ignored.
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
 * Dispatch the state-transition notification once the label flip has
 * landed. Pulled out of `transitionTicketState` so the outer function
 * stays below the CRAP-12 ceiling: this is where the severity gating,
 * the ticket-type derivation, the level mapping, and the fire-and-forget
 * dispatch all live.
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
  // Suppress the dispatch entirely for low-severity transitions (task-
  // level, or non-terminal story / epic flips). Pre-migration the
  // comment channel filtered these out via `commentMinLevel: medium`;
  // post-migration the channel is event-allowlist gated and would
  // surface every transition equally, so the noise filter moves to
  // the emit point.
  if (severity === 'low') return;
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
 * Emit a runtime-derived `friction` signal when a ticket parks at
 * `agent::blocked` (Story #4578). No-op for every other target state.
 *
 * Why here: `agent::blocked` is the single runtime HITL pause point
 * (`.agents/instructions.md` § 1.J), and this is its canonical mutator — so
 * one hook catches every block regardless of which path drove it (the
 * `merge.unlanded` and `merge.flip-failed` paths in
 * `single-story-close/phases/confirm-merge.js`, the review-block path, an
 * operator's `update-ticket-state.js`, a Story worker giving up). Before
 * this, a block was only ever a *label* — it left no trace in the friction
 * stream the retro reads, so a run could park a worker and still produce a
 * zero-signal roll-up.
 *
 * This is also why the terminal-envelope hook deliberately skips `blocked`
 * (see `frictionForTerminal`): the two would otherwise count one incident
 * twice.
 *
 * Story #4622 extends the hook to the inverse edge: a `blocked → active`
 * transition emits a recovery marker so a transient block that self-resolved
 * can be netted out of the retro's `story-blocked` recurrence total.
 *
 * Best-effort and awaited: the friction emitters swallow their own failures
 * and resolve `false`, so this can neither throw nor block the transition.
 * It is awaited rather than fire-and-forget because CLI entry points exit
 * via `process.exit` as soon as `main` resolves (`cli-utils.runAsCli` with
 * `propagateExitCode`), which would discard a still-pending append.
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
  // Story #4622 — a transition *out* of `agent::blocked` into an active state
  // is a recovery: the earlier block self-resolved. Emit its recovery marker
  // so the retro composer can net the transient block out of the
  // `story-blocked` recurrence total (swarm-os friction #581). Only a genuine
  // block→active recovery qualifies; blocked→done/closing is a real
  // terminal outcome, not a recovery, so it is left counted.
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
 * Transitions a ticket's label to the new state.
 * Removes other agent:: state labels.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {string} newState - Must be one of STATE_LABELS.
 * @param {{ notify?: Function, cascade?: boolean, ticketSnapshot?: object, _makeColumnSync?: Function }} [opts]
 *   Optional notify function (the exported `notify(ticketId, payload, opts)`
 *   from `notify.js`, or any stub matching its shape). When provided, a
 *   state-transition notification fires after a successful transition.
 *   Story/Epic → `agent::done` events are dispatched as `medium`; all other
 *   transitions are `low` and filtered out at the default `medium` channel
 *   thresholds. The dispatched payload carries the typed envelope fields
 *   (`event: 'state-transition'`, `level: 'task'|'story'|'wave'|'epic'`,
 *   `epicId`) for routable webhook subscribers.
 *
 *   `cascade` (default `true`) controls whether a `done` transition fans the
 *   `cascadeCompletion` upward to parents. Per-Task closes invoked mid-Story
 *   from the retired per-Task progress writer (4-tier era, removed under
 *   #3157) passed `cascade: false` so the Story/Epic only flipped to
 *   `agent::done` at story-close (after the merge lands), not when the
 *   last Task commit landed on the still-unmerged Story branch. The
 *   parameter is preserved for callers that still suppress cascade
 *   explicitly (e.g. batch-transition helpers).
 *
 *   `ticketSnapshot` (Story #1795 / Epic #1788) is an optional pre-fetched
 *   ticket object. When the caller already holds the ticket (e.g.
 *   `batchTransitionTickets`, which loops over a list it just hydrated),
 *   passing the snapshot eliminates the two `getTicket` round-trips that
 *   `transitionTicketState` would otherwise issue — one for the notify
 *   `fromState` lookup and one inside `provider.updateTicket`'s label
 *   merge path. Backwards compatible: when omitted, behaviour is unchanged.
 *
 *   `_makeColumnSync` (Story #3645 DIP seam) — factory for the board-sync
 *   object. Production callers omit it (the default constructs a real
 *   `ColumnSync`); tests inject a stub to avoid GraphQL calls without
 *   module-level mocking.
 */
export async function transitionTicketState(
  provider,
  ticketId,
  newState,
  opts = {},
) {
  validateTransitionInputs(newState);

  const toRemove = ALL_STATES.filter((state) => state !== newState);

  // Snapshot prior state for the notification payload (best-effort; skip on
  // error). A transient read failure MUST NOT block a label transition —
  // the transition itself is idempotent and `fromState: null` is a valid
  // payload value.
  //
  // Story #1795 — when the caller threads `opts.ticketSnapshot` we reuse
  // it as the notify snapshot without issuing a fresh `getTicket`. The
  // snapshot is also forwarded to `provider.updateTicket` so the label
  // merge path skips its own `getTicket` call (the second of the two
  // round-trips this seam eliminates).
  const ticketSnapshot = await loadTicketSnapshot(
    provider,
    opts,
    ticketId,
    BLOCK_RECOVERY_TARGETS.includes(newState),
  );
  const fromState =
    ticketSnapshot?.labels?.find((l) => ALL_STATES.includes(l)) ?? null;

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
    // Internal-only escape hatch threaded through `provider.updateTicket`
    // to `_applyLabelMutations`. Honored by `providers/github.js`; ignored
    // by providers that don't recognise it. Underscore-prefixed to mark
    // it as a provider-internal contract rather than part of the public
    // `mutations` shape.
    _ticketSnapshot: ticketSnapshot,
  });

  // Story #4578 — derive a friction signal from the block, at the point the
  // runtime already knows. Story #4622 also emits the recovery marker on the
  // inverse block→active transition. Best-effort; never blocks the transition.
  await emitBlockedFriction(ticketId, fromState, newState, opts);

  // Story #2548 — mirror the new state onto the Projects v2 Status
  // column. Best-effort; never blocks the transition.
  // Story #3645 — thread the DIP seam so callers can inject a stub.
  await syncProjectStatusColumn(
    provider,
    ticketId,
    newState,
    opts._makeColumnSync,
    opts.config,
  );

  // Automatically trigger upward cascade on every transition (Story
  // #2676). The unified entry point is `cascadeParentState`, which:
  //   - delegates `agent::done` transitions to the legacy
  //     `cascadeCompletion` (preserving tasklist-checkbox toggling, the
  //     "All child tickets completed" progress comment, and the Epic
  //     close-exclusion);
  //   - for every other `agent::*` transition (`executing`, `blocked`,
  //     `closing`, …) walks the parent chain and updates each parent to
  //     the state derived from its children's current composition. This
  //     keeps the GitHub Project board accurate when work begins on a
  //     Task ("In Progress" surfaces up to the Story and Epic) or when a
  //     child enters the HITL pause state.
  //
  // The cascade implementation lives in `bulk.js` and is injected via
  // `registerCascadeRunner` (Story #3995) so this module stays a leaf in
  // the import graph. Callers that intentionally suppress propagation
  // (historically the per-Task progress writer, which closed Tasks at
  // commit-time but deferred the Story flip to story-close after the
  // branch was merged) opt out by passing `cascade: false`.
  if (opts.cascade !== false) {
    await _runUpwardCascade(provider, ticketId, {
      notify: opts.notify,
    });
  }

  // Fire the state-transition notification (fire-and-forget).
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
 * Mutates the tasklist checkbox in the parent's body.
 * E.g., `- [ ] #123` to `- [x] #123`
 *
 * Story #3645 — positional `checked` boolean replaced with a named
 * `{ checked }` options bag to eliminate the boolean-trap smell (SRP /
 * naming clarity audit finding). All call sites updated in the same PR
 * per the No-Shim cutover rule.
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
 * Returns whatever the provider's `postComment` resolved to (Story #4543).
 * Previously the result was swallowed, which made it impossible for a caller
 * to reference the comment it had just written — the terminal envelope's
 * `blocked.frictionCommentId` pointer needs exactly that, so an operator can
 * be sent straight to the remediation instead of told to go find it. Callers
 * that don't need the id simply ignore the return, so this is additive.
 *
 * The shape is provider-defined and may be `undefined` for providers that do
 * not surface one; callers must treat the id as best-effort.
 *
 * @param {import('../../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} ticketId
 * @param {'progress'|'friction'|'notification'} type
 * @param {string} payload
 * @returns {Promise<unknown>} The provider's `postComment` result.
 */
export async function postStructuredComment(provider, ticketId, type, payload) {
  assertValidStructuredCommentType(type);
  const posted = await provider.postComment(ticketId, {
    type,
    body: payload,
  });
  // Story #2465 — evict the raw-comments cache entry so the next
  // `findStructuredComment` against this ticket re-fetches and sees the
  // freshly-posted comment.
  invalidateRawCommentsCache(provider, ticketId);
  return posted;
}
