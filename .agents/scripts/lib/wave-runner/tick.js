/**
 * `tick({ epic, collaborators })` — single callable entry point for
 * "advance this Epic one beat." Stateless adapter over the continuous
 * ready-set scheduling core (`lib/wave-runner/ready-set.js`).
 *
 * Story #4155 (Epic #4151) — the Epic `/deliver` runtime cut over from
 * the wave-batch scheduler to the ready-set core. Each tick:
 *
 *   1. reads the shrunk `epic-run-state` checkpoint (per-Story status map
 *      + the GLOBAL in-flight `concurrencyCap`),
 *   2. re-fetches the **live** Story records (body + labels + issue
 *      state) for every Story in scope,
 *   3. classifies each by live label (`classifyStory`), re-derives
 *      adjacency from the live bodies (`buildStoryAdjacency`, inside
 *      `selectReadySet`) and selects the ready set under a global
 *      in-flight cap with the file-overlap co-dispatch guard
 *      (`storiesOverlap`),
 *   4. returns a `WaveTickResult` describing the next action.
 *
 * There is **no wave barrier**: a Story whose own dependencies are all
 * done is dispatched the instant a slot is free, even while an unrelated
 * sibling Story is still `agent::executing`. The selector neither reads
 * GitHub nor a checkpoint nor the ledger — this adapter supplies the live
 * records, the `inFlight` count (from the lifecycle ledger), and the
 * `globalCap`, then maps its return into the `WaveTickResult` envelope.
 *
 * Contract (Story #1430, refined by #4155): stateless; caller owns
 * concurrency, worktrees, and the checkpoint. Expected failures (blocked
 * stories) flow back through result fields; unexpected failures (GH 5xx,
 * malformed / old-shape checkpoint) throw `WaveRunnerError`.
 *
 * Story #4183 — the `tick(args)` orchestrator was a 252-line SRP /
 * cognitive-load hotspot carrying six distinct responsibilities in one
 * body. It is now a thin coordinator (Coordinator-plus-Phases pattern,
 * `docs/patterns.md`) that wires four extracted stages:
 * `resolveTickCollaborators` (collaborator/fallback resolution),
 * `readAndValidateCheckpoint` (checkpoint read + shape validation, folding
 * in `assertNotOldShape`), `refetchStoryRecords` (force-fresh re-fetch),
 * and the **pure** `planTick` (classification → cycle detection → ready-set
 * selection → dispatch decision, returning the signals to emit rather than
 * emitting them, so it carries no I/O). The exported `tick(args)`
 * signature, the `tickResult` / `withInFlight` envelope shapes, and every
 * `WaveRunnerError` code are preserved verbatim — callers and tests are
 * unchanged.
 *
 * @module lib/wave-runner/tick
 */

import { existsSync, readFileSync } from 'node:fs';

import { epicLedgerPath } from '../config/temp-paths.js';
import { detectCycle } from '../Graph.js';
import { AGENT_LABELS } from '../label-constants.js';
import { appendEpicSignal } from '../observability/signals-writer.js';
import * as epicRunStateStoreModule from '../orchestration/epic-run-state-store.js';
import { detectRecurringFailures } from '../orchestration/recurring-failure-detector.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../orchestration/ticketing.js';
import { buildStoryAdjacency } from '../story-adjacency.js';

import { classifyStory, selectReadySet, storyIdOf } from './ready-set.js';
import { WaveRunnerError } from './wave-runner-error.js';

/**
 * The checkpoint fields whose presence marks an **old-shape** (wave-batch)
 * `epic-run-state` comment. The ready-set runtime cannot mis-schedule
 * against a wave-indexed plan — indexing the old wave grouping would silently
 * dispatch the wrong stories — so the tick fails closed on any of these
 * fields with an explicit operator message rather than guessing.
 */
const OLD_SHAPE_FIELDS = Object.freeze(['plan', 'currentWave', 'totalWaves']);

/**
 * Advance the Epic one beat. Returns a `WaveTickResult`:
 *
 *   nextAction: { kind: 'dispatch', stories: [{ id, title? }, ...] }
 *             | { kind: 'observe',  waitingOn: number[] }
 *             | { kind: 'halt', reason: string, stuckStories: number[],
 *                 cycle?: number[] }
 *             | { kind: 'epic-complete' }
 *   blockedStories: [{ storyId, reason, detail? }, ...]
 *   gateFailures:   [{ storyId, gate, detail? }, ...]
 *   readyCount:     number   // size of the ready set this beat
 *   inFlight:       number[] // ledger-derived dispatched-not-yet-ended ids
 *
 * Readiness comes entirely from the **live** Story bodies + labels — the
 * checkpoint contributes only the Story set in scope and the global cap.
 *
 * `epic-complete` is returned **only** when every in-scope Story is done.
 * If the ready set is empty and nothing is in flight but at least one Story
 * is still not done — a Story gated on an unsatisfiable dependency
 * (a dependency cycle, or a `blocked by #N` that survived adjacency closure)
 * — the tick returns a non-terminal `halt` naming the stuck Story ids rather
 * than silently reporting the Epic complete and stranding the Story. A
 * dependency cycle among the in-scope Stories is likewise surfaced as a
 * `halt` (with the offending `cycle`), never collapsed to `epic-complete`.
 *
 * Coordinator (Story #4183): this function is a thin dispatcher. It resolves
 * collaborators, reads + validates the checkpoint, re-fetches the live Story
 * records, runs the best-effort recurring-failure scan, delegates the pure
 * dispatch decision to `planTick`, then drains the `signals` `planTick`
 * returned through the configured emitter. Each stage is an independently
 * testable helper below.
 *
 * @typedef {object} WaveTickArgs
 * @property {number | { id: number }} epic
 * @property {{
 *   provider?: object,
 *   epicRunStateStore?: { read: () => Promise<object|null> },
 *   signalEmit?: (signal: object) => Promise<unknown>,
 *   inFlightReader?: () => Promise<number[]>,
 *   recurringFailureReporter?: () => Promise<void>,
 * }} [collaborators]
 * @property {{ provider?: object, config?: object }} [ctx]
 *
 * @param {WaveTickArgs} args
 */
export async function tick(args = {}) {
  const { epicId, provider, epicRunStateStore, emit, inFlightReader, ctx } =
    resolveTickCollaborators(args);

  const state = await readAndValidateCheckpoint(epicRunStateStore, epicId);

  const storyIds = checkpointStoryIds(state);

  if (storyIds.length === 0) {
    // No Stories in scope — the Epic has nothing to dispatch.
    return tickResult({
      nextAction: withInFlight({ kind: 'epic-complete' }, []),
      readyCount: 0,
      inFlight: [],
    });
  }

  // Re-fetch the live Story records (body + labels + issue state) for every
  // Story in scope. In-flight Stories are force-fresh-fetched so a label that
  // flipped since the last tick is observed; every other Story serves from
  // the provider's in-process cache.
  const inFlight = await safeReadInFlight(inFlightReader);
  const inFlightSet = new Set(inFlight);
  const records = await refetchStoryRecords(provider, storyIds, inFlightSet);

  // Best-effort recurring-failure scan (≥2 distinct Stories sharing the same
  // `close-validate.end` failedGate). Idempotent across re-ticks; a reporter
  // throw must not crash the planner.
  const recurringFailureReporter =
    args.collaborators?.recurringFailureReporter ??
    defaultRecurringFailureReporter({ provider, epicId, config: ctx?.config });
  await safeReportRecurringFailures(recurringFailureReporter);

  // Decide the next action from the live records + ledger in-flight set. The
  // decision is pure (no I/O); the signals it wants emitted come back in
  // `plan.signals` and are drained by the coordinator below.
  const plan = planTick(state, records, inFlight);
  for (const signal of plan.signals) {
    await emit(signal);
  }

  return tickResult({
    nextAction: withInFlight(plan.nextAction, inFlight),
    blockedStories: plan.blockedStories,
    gateFailures: plan.gateFailures,
    readyCount: plan.readyCount,
    inFlight,
  });
}

/**
 * Resolve the Epic id and the five injectable collaborators (with their
 * production-default fallbacks) from the `tick` args. The single home for the
 * collaborator/fallback wiring so the coordinator stays declarative.
 *
 * Throws `WaveRunnerError('invalid-input')` when the epic id is not a
 * positive integer (or `{ id: positiveInt }`) or when no provider is supplied
 * via either `collaborators.provider` or `ctx.provider`.
 *
 * @param {WaveTickArgs} args
 * @returns {{
 *   epicId: number,
 *   provider: object,
 *   epicRunStateStore: { read: () => Promise<object|null> },
 *   emit: (signal: object) => Promise<unknown>,
 *   inFlightReader: () => Promise<number[]>,
 *   ctx: object,
 * }}
 */
function resolveTickCollaborators(args) {
  const epicId = resolveEpicId(args.epic);
  const {
    provider: collabProvider,
    epicRunStateStore: collabStore,
    signalEmit,
    inFlightReader: collabInFlightReader,
  } = args.collaborators ?? {};
  const ctx = args.ctx ?? {};
  const provider = collabProvider ?? ctx.provider;
  if (!provider) {
    throw new WaveRunnerError('invalid-input', 'provider is required');
  }
  // The ready-set tick is stateless. When the caller does not supply a
  // collaborator shim, read the `epic-run-state` structured comment directly
  // via the function-based store.
  const epicRunStateStore = collabStore ?? {
    read: () => epicRunStateStoreModule.read({ provider, epicId }),
  };
  const emit = signalEmit ?? defaultSignalEmit(epicId, ctx);
  const inFlightReader =
    collabInFlightReader ?? (() => defaultInFlightReader(epicId, ctx?.config));
  return { epicId, provider, epicRunStateStore, emit, inFlightReader, ctx };
}

/**
 * Read the `epic-run-state` checkpoint via the store, validate its shape, and
 * fail closed on a pre-ready-set (wave-batch) checkpoint.
 *
 * Throws:
 *   - `WaveRunnerError('checkpoint-read')` when the store read rejects,
 *   - `WaveRunnerError('checkpoint-missing')` when the read resolves to a
 *     non-object (no comment),
 *   - `WaveRunnerError('old-shape-checkpoint')` when the checkpoint still
 *     carries a `plan` / `currentWave` / `totalWaves` field (via
 *     `assertNotOldShape`). A `plan` / `currentWave` / `totalWaves` comment
 *     predates the ready-set cutover (Story #4155); the ready-set runtime
 *     would otherwise ignore those fields and re-derive readiness from live
 *     labels — silently discarding an in-progress wave-batch run's resume
 *     pointer. Refuse with an explicit operator remediation instead.
 *
 * @param {{ read: () => Promise<object|null> }} store
 * @param {number} epicId
 * @returns {Promise<object>} the validated checkpoint state.
 */
async function readAndValidateCheckpoint(store, epicId) {
  let state;
  try {
    state = await store.read();
  } catch (err) {
    throw new WaveRunnerError('checkpoint-read', err);
  }
  if (!state || typeof state !== 'object') {
    throw new WaveRunnerError(
      'checkpoint-missing',
      `no epic-run-state comment on Epic #${epicId}`,
    );
  }
  assertNotOldShape(state, epicId);
  return state;
}

/**
 * Re-fetch the live Story records (body + labels + issue state) for every
 * Story in scope. The body feeds `buildStoryAdjacency` (inside
 * `selectReadySet`) so the dependency edges are always read from the current
 * ticket text, never a stale checkpoint snapshot. Stories in `inFlightSet`
 * are force-fresh-fetched (`{ fresh: true }`) so a label that flipped since
 * the last tick is observed; every other Story serves from the provider's
 * in-process cache.
 *
 * Throws `WaveRunnerError('story-fetch')` when any `provider.getTicket`
 * rejects.
 *
 * @param {{ getTicket: (id: number, opts?: object) => Promise<object> }} provider
 * @param {number[]} storyIds Ascending, deduped in-scope Story ids.
 * @param {Set<number>} inFlightSet Ledger-derived in-flight Story ids.
 * @returns {Promise<Array<object>>} normalized Story records.
 */
async function refetchStoryRecords(provider, storyIds, inFlightSet) {
  try {
    return await Promise.all(
      storyIds.map(async (id) => {
        const opts = inFlightSet.has(id) ? { fresh: true } : {};
        const ticket = await provider.getTicket(id, opts);
        return {
          id,
          title: ticket?.title,
          body: ticket?.body ?? '',
          labels: Array.isArray(ticket?.labels) ? ticket.labels : [],
          state: ticket?.state,
          // Forward every declared file-footprint shape so the selector's
          // overlap co-dispatch guard (`storiesOverlap`) can withhold two
          // Stories that would race the same path on parallel branches.
          files: Array.isArray(ticket?.files) ? ticket.files : undefined,
          changes: Array.isArray(ticket?.changes) ? ticket.changes : undefined,
          changeset: Array.isArray(ticket?.changeset)
            ? ticket.changeset
            : undefined,
        };
      }),
    );
  } catch (err) {
    throw new WaveRunnerError('story-fetch', err);
  }
}

/**
 * Pure dispatch planner — the scheduler tick's decision core with **no I/O**.
 * Given the parsed checkpoint, the live Story records, and the ledger-derived
 * in-flight id list, it classifies every Story, detects a sibling dependency
 * cycle, selects the ready set under the global in-flight cap, and decides the
 * `nextAction`. It performs no fetching, no signal emission, and no ledger
 * read: the two wave-window forensics signals are returned in the `signals`
 * array for the coordinator to drain, so this function stays independently
 * unit-testable against fixture records without a provider stub or an emitter.
 *
 * @param {object} state Parsed `epic-run-state` checkpoint (for the global
 *   cap and the per-Story `failed` rows surfaced as gate failures).
 * @param {Array<object>} records Live Story records (id, title, body, labels,
 *   state, file-footprint shapes).
 * @param {number[]} inFlight Ledger-derived dispatched-not-yet-ended ids.
 * @returns {{
 *   nextAction: object,
 *   blockedStories: Array<{ storyId: number, reason: string, detail?: string }>,
 *   gateFailures: Array<{ storyId: number, gate: string, detail?: string }>,
 *   readyCount: number,
 *   signals: Array<object>,
 * }}
 */
export function planTick(state, records, inFlight) {
  const globalCap = positiveIntOrZero(state.concurrencyCap);
  const inFlightSet = new Set(inFlight);

  // 1. Classify by live label. `done` / `blocked` / `executing` / `ready`.
  const byClass = { done: [], blocked: [], executing: [], ready: [] };
  for (const rec of records) {
    byClass[classifyStory(rec)].push(rec);
  }

  // 1a. Detect a dependency cycle among the in-scope Stories BEFORE selecting.
  //     A cycle makes every Story on it permanently un-eligible (no member's
  //     deps can all be done), so `selectReadySet` would return an empty set
  //     and the terminal decision could otherwise mistake the stall for
  //     completion. Surface it as a `halt` so the workflow parks the Epic on
  //     a diagnosable condition instead of silently dropping the cycle. Build
  //     adjacency with `dropForeign: true` to match the Epic-scoped semantics
  //     (a cycle is only meaningful over the scheduled sibling set). Mirrors
  //     the cycle handling in `stories-wave-tick.js`.
  const epicAdjacency = buildStoryAdjacency(records, { dropForeign: true });
  const cycle = detectCycle(epicAdjacency);

  // 2. Select the ready set under the GLOBAL in-flight cap. The selector
  //    re-derives adjacency from the live bodies (with `dropForeign: true` so
  //    a `blocked by #N` whose target is outside this Epic's Story set — a
  //    foreign id or a typo — is pruned rather than treated as a permanent
  //    unsatisfiable gate that strands the dependent), and applies the
  //    file-overlap co-dispatch guard, returning the deterministic,
  //    overlap-free, dependency-satisfied subset capped at the remaining
  //    slots.
  //
  //    A Story recorded in-flight on the ledger (`story.dispatch.start`
  //    without a matching `.end`) but whose label has not yet flipped to
  //    `agent::executing` (the child is mid-`story-init`, or the host crashed
  //    after the dispatch-ledger write but before the label flip) still reads
  //    as `ready` by label alone. Re-dispatching it would put a second agent
  //    on the same `story-<id>` branch — the worst failure mode in the
  //    system. So the candidate set passed to the selector marks those
  //    Stories `executing`: they keep occupying a slot (and gate any
  //    dependent, since they are not done) but are never re-selected.
  //
  //    The slot denominator is the size of the UNION of (a) ledger-in-flight
  //    ids and (b) Stories carrying `agent::executing` by label. A Story that
  //    flipped to `agent::executing` but whose `story.dispatch.start` never
  //    landed in the ledger (e.g. the label flip raced ahead of the ledger
  //    write) occupies a real slot the ledger count alone misses; counting
  //    only the ledger would let the global cap be exceeded. The union is the
  //    authoritative occupied-slot count.
  const candidates = records.map((rec) =>
    inFlightSet.has(rec.id) && classifyStory(rec) === 'ready'
      ? { ...rec, labels: [...rec.labels, AGENT_LABELS.EXECUTING] }
      : rec,
  );
  const doneIds = byClass.done.map((s) => s.id);
  const occupiedSlotIds = new Set([
    ...inFlight,
    ...byClass.executing.map((s) => s.id),
  ]);
  const readySet = selectReadySet({
    stories: candidates,
    doneIds,
    inFlight: occupiedSlotIds.size,
    globalCap,
    dropForeign: true,
  });

  const blockedStories = byClass.blocked.map((s) => ({
    storyId: s.id,
    reason: 'agent::blocked',
    detail: s.title,
  }));
  const gateFailures = readGateFailures(state);

  // 3. Decide nextAction.
  //    - A blocked Story halts the Epic → observe (the workflow flips the
  //      Epic to agent::blocked and parks).
  //    - A dependency cycle among the in-scope Stories halts the Epic → halt
  //      (the cycle is an unsatisfiable gate; never collapse it to complete).
  //    - A non-empty ready set → dispatch it. Fire `wave-start` on the very
  //      first dispatch of the run (nothing executing / in-flight / done
  //      yet) so the perf-aggregator can bracket the run's wall-clock.
  //    - Otherwise, if any Story is still executing or in-flight → observe.
  //    - Otherwise, if EVERY in-scope Story is done → epic-complete.
  //    - Otherwise the ready set is empty, nothing is in flight, yet not all
  //      Stories are done: at least one Story is permanently gated (an
  //      unsatisfiable dependency that survived adjacency closure). Halt and
  //      name the stuck Story ids — never silently report the Epic complete.
  const allDone = byClass.done.length === records.length;
  const signals = [];
  let nextAction;
  if (blockedStories.length) {
    nextAction = {
      kind: 'observe',
      waitingOn: byClass.blocked.map((s) => s.id).sort((a, b) => a - b),
    };
  } else if (cycle) {
    const cycleIds = cycle
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
    nextAction = {
      kind: 'halt',
      reason: 'dependency-cycle',
      stuckStories: cycleIds,
      cycle,
    };
  } else if (readySet.length) {
    if (
      byClass.executing.length === 0 &&
      byClass.done.length === 0 &&
      inFlight.length === 0
    ) {
      signals.push({
        kind: 'wave-start',
        stories: records.map((s) => ({ id: s.id, title: s.title })),
      });
    }
    nextAction = {
      kind: 'dispatch',
      stories: readySet.map((s) => ({
        id: storyIdOf(s),
        title: s.title,
      })),
    };
  } else if (byClass.executing.length || inFlight.length) {
    const waitingOn = [
      ...new Set([...byClass.executing.map((s) => s.id), ...inFlight]),
    ].sort((a, b) => a - b);
    nextAction = { kind: 'observe', waitingOn };
  } else if (allDone) {
    // Every Story is done and nothing is in flight: the run is complete.
    signals.push({ kind: 'wave-complete' });
    nextAction = { kind: 'epic-complete' };
  } else {
    // Ready set empty, nothing in flight, but not all Stories are done — a
    // Story is gated on an unsatisfiable dependency. Halt with the stuck ids
    // (every not-done, not-in-flight Story) so the operator can see exactly
    // which Story stranded the run instead of a false epic-complete.
    const stuckStories = records
      .filter((rec) => classifyStory(rec) !== 'done')
      .map((rec) => rec.id)
      .filter((id) => Number.isInteger(id))
      .sort((a, b) => a - b);
    nextAction = {
      kind: 'halt',
      reason: 'unsatisfiable-dependency',
      stuckStories,
    };
  }

  return {
    nextAction,
    blockedStories,
    gateFailures,
    readyCount: readySet.length,
    signals,
  };
}

/**
 * Throw `WaveRunnerError('old-shape-checkpoint')` when the checkpoint still
 * carries any wave-batch field. The message names the offending field(s) and
 * the operator remediation so a stuck delivery is diagnosable from the
 * thrown error alone.
 *
 * @param {object} state Parsed checkpoint.
 * @param {number} epicId
 */
function assertNotOldShape(state, epicId) {
  const present = OLD_SHAPE_FIELDS.filter((f) => Object.hasOwn(state, f));
  if (present.length === 0) return;
  throw new WaveRunnerError(
    'old-shape-checkpoint',
    `Epic #${epicId} carries a pre-ready-set (wave-batch) epic-run-state ` +
      `checkpoint (fields: ${present.join(', ')}). The ready-set /deliver ` +
      `runtime cannot resume a wave-batch run. Re-run ` +
      `\`node .agents/scripts/epic-deliver-prepare.js --epic ${epicId}\` to ` +
      `re-seed the checkpoint in the per-Story-status shape, then re-run ` +
      `/deliver.`,
  );
}

/**
 * Extract the in-scope Story ids from the shrunk checkpoint's per-Story
 * `stories` status map (`{ [storyId]: { status, ... } }`). Returns an
 * ascending-sorted, deduped array of positive integers; tolerates an absent
 * / malformed map by returning `[]`.
 *
 * @param {object} state
 * @returns {number[]}
 */
function checkpointStoryIds(state) {
  const stories = state?.stories;
  if (!stories || typeof stories !== 'object') return [];
  const ids = new Set();
  for (const key of Object.keys(stories)) {
    const id = Number(key);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Attach the ledger-derived in-flight Story-id list to a `nextAction`
 * envelope under the `in-flight` key. Always present (empty array when the
 * ledger is silent) so downstream consumers pattern-match on presence
 * without an existence check.
 *
 * @param {object} nextAction
 * @param {number[]} inFlight
 * @returns {object} the same nextAction (mutated) for call-site convenience
 */
function withInFlight(nextAction, inFlight) {
  nextAction['in-flight'] = inFlight;
  return nextAction;
}

/**
 * Wrap the configured `inFlightReader` with a defensive guard so an
 * unreadable ledger never crashes the tick. The default reader already
 * returns `[]` on missing files; this catches any other shape of
 * accidental throw and degrades to an empty list so the planner can
 * still make a decision.
 *
 * @param {() => Promise<number[]>} reader
 * @returns {Promise<number[]>}
 */
async function safeReadInFlight(reader) {
  try {
    const raw = await reader();
    return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Default `recurringFailureReporter` collaborator — reads the per-Epic
 * lifecycle ledger via `detectRecurringFailures`, and when at least one
 * recurring-failure-class finding is returned, upserts a
 * `recurring-failure-class` structured comment on the Epic ticket.
 *
 * The body carries the findings array verbatim in a JSON fence plus a
 * compact human-readable bullet list keyed by gate. Idempotent across
 * re-ticks: `upsertStructuredComment` diffs body bytes, so a tick that
 * produces the same findings does not generate a new comment.
 *
 * Story #3062 (Epic #3051).
 *
 * @param {object} args
 * @param {object} args.provider Ticketing provider passed to upsert.
 * @param {number} args.epicId
 * @param {object} [args.config]
 * @returns {() => Promise<void>}
 */
function defaultRecurringFailureReporter({ provider, epicId, config }) {
  return async () => {
    const ledgerPath = epicLedgerPath(epicId, config);
    const findings = detectRecurringFailures(epicId, { ledgerPath });
    if (findings.length === 0) return;
    const body = renderRecurringFailureBody(findings);
    await defaultUpsertStructuredComment(
      provider,
      epicId,
      'recurring-failure-class',
      body,
    );
  };
}

/**
 * Render the comment body the recurring-failure-class reporter upserts.
 * The body is deterministic given a deterministic findings array (the
 * detector sorts findings by gate and storyIds ascending), which is what
 * makes the upsert idempotent across re-ticks.
 *
 * @param {Array<{gate: string, storyIds: number[], firstSeenAt: string, lastSeenAt: string}>} findings
 * @returns {string}
 */
export function renderRecurringFailureBody(findings) {
  const lines = ['### 🔁 Recurring failure classes detected', ''];
  for (const f of findings) {
    const storiesList = f.storyIds.map((id) => `#${id}`).join(', ');
    lines.push(
      `- **\`${f.gate}\`** — ${f.storyIds.length} stories (${storiesList}); first \`${f.firstSeenAt}\`, last \`${f.lastSeenAt}\``,
    );
  }
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify({ kind: 'recurring-failure-class', findings }, null, 2),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Wrap the reporter so a throw (e.g. transient provider error, malformed
 * ledger) never crashes the stateless tick. Best-effort — the next tick
 * will retry.
 *
 * @param {() => Promise<void>} reporter
 */
async function safeReportRecurringFailures(reporter) {
  try {
    await reporter();
  } catch {
    // best-effort
  }
}

/**
 * Default `inFlightReader` — parses `temp/epic-<id>/lifecycle.ndjson`
 * and returns the Story IDs that have a `story.dispatch.start`
 * `emitted` record without a matching `story.dispatch.end` `emitted`
 * record. The check is order-insensitive (the wave-runner records the
 * pair on the same Bus, so the start always lands first, but we don't
 * depend on that here).
 *
 * Returns `[]` when the ledger file does not yet exist or is empty —
 * the tick is stateless and must not throw when nothing has been
 * dispatched on this Epic yet.
 *
 * @param {number} epicId
 * @param {object|undefined} config Resolved config (forwarded to
 *   `epicLedgerPath` so `project.paths.tempRoot` overrides apply).
 * @returns {Promise<number[]>}
 */
async function defaultInFlightReader(epicId, config) {
  const ledgerPath = epicLedgerPath(epicId, config);
  if (!existsSync(ledgerPath)) return [];
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  if (!raw) return [];
  const started = new Set();
  const ended = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.kind !== 'emitted') continue;
    const storyId = record.payload?.storyId;
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    if (record.event === 'story.dispatch.start') started.add(storyId);
    else if (record.event === 'story.dispatch.end') ended.add(storyId);
  }
  const inFlight = [];
  for (const id of started) {
    if (!ended.has(id)) inFlight.push(id);
  }
  return inFlight.sort((a, b) => a - b);
}

function tickResult({
  nextAction,
  blockedStories = [],
  gateFailures = [],
  readyCount = 0,
  inFlight = [],
}) {
  return { nextAction, blockedStories, gateFailures, readyCount, inFlight };
}

function resolveEpicId(epic) {
  const id = typeof epic === 'number' ? epic : epic?.id;
  if (Number.isInteger(id) && id > 0) return id;
  throw new WaveRunnerError(
    'invalid-input',
    `epic must be a positive integer or { id: positiveInt }; got ${
      epic === null ? 'null' : typeof epic
    }`,
  );
}

function positiveIntOrZero(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Derive gate-failure rows from the checkpoint's per-Story `stories` status
 * map: every Story recorded as `failed` surfaces as a gate failure so the
 * operator workflow can act on it. The shrunk checkpoint no longer carries a
 * per-wave history with explicit gate names, so the gate is reported as
 * `unspecified` and the recorded `title` (when present) is the detail.
 *
 * @param {object} state Parsed checkpoint.
 * @returns {Array<{ storyId: number, gate: string, detail?: string }>}
 */
function readGateFailures(state) {
  const stories = state?.stories;
  if (!stories || typeof stories !== 'object') return [];
  const out = [];
  for (const [key, rec] of Object.entries(stories)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (rec?.status !== 'failed') continue;
    const row = { storyId: id, gate: 'unspecified' };
    if (typeof rec.title === 'string' && rec.title) row.detail = rec.title;
    out.push(row);
  }
  return out.sort((a, b) => a.storyId - b.storyId);
}

/**
 * Default emitter — appends to per-Epic `signals.ndjson`. Best-effort;
 * never throws. Tests override via `collaborators.signalEmit`.
 *
 * Story #3909 / #4155 — the planner emits only the two wave-window
 * forensics events with a live consumer: `wave-start` (fired on the run's
 * first dispatch) and `wave-complete` (fired when the run finishes), which
 * the perf-aggregator (`waveParallelism` report) brackets into the run's
 * wall-clock. The write-only per-call telemetry and `epic-complete` emits
 * were dropped — they duplicated the `epic-run-state` checkpoint and the
 * `epic-run-progress` rollup and nothing consumed them.
 */
function defaultSignalEmit(epicId, ctx) {
  return async (signal) => {
    await appendEpicSignal({
      epicId,
      signal: { ts: new Date().toISOString(), epic: epicId, ...signal },
      config: ctx?.config,
    });
  };
}
