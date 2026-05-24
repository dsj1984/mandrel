/**
 * `tick({ epic, collaborators })` — single callable entry point for
 * "advance this wave one step." Stateless planner: rebuilds wave state
 * from the `epic-run-state` checkpoint plus fresh Story labels on every
 * call, then returns a `WaveTickResult` describing the next action.
 *
 * Contract (Story #1430): stateless; caller owns concurrency,
 * worktrees, and checkpointing. Expected failures (blocked stories,
 * gate failures) flow back through result fields; unexpected failures
 * (GH 5xx, malformed checkpoint) throw `WaveRunnerError`.
 *
 * @module lib/wave-runner/tick
 */

import { existsSync, readFileSync } from 'node:fs';

import { epicLedgerPath } from '../config/temp-paths.js';
import { AGENT_LABELS } from '../label-constants.js';
import { appendEpicSignal } from '../observability/signals-writer.js';
import * as epicRunStateStoreModule from '../orchestration/epic-run-state-store.js';

import { WaveRunnerError } from './wave-runner-error.js';

/**
 * Advance the wave loop one step. Returns a `WaveTickResult`:
 *
 *   nextAction: { kind: 'dispatch', stories: [{ id, title?, worktree? }, ...] }
 *             | { kind: 'observe', waitingOn: number[] }
 *             | { kind: 'wave-complete', index: number }
 *             | { kind: 'epic-complete' }
 *   blockedStories: [{ storyId, reason, detail? }, ...]
 *   gateFailures:   [{ storyId, gate, detail? }, ...]
 *   currentWave:    number
 *   totalWaves:     number
 *
 * When `spec` is omitted, the planner falls back to the checkpoint's
 * `state.plan` (the GH-derived dependency-DAG grouping originally seeded
 * by /epic-plan) — behaviour is byte-identical to the pre-spec path.
 * When `spec` is supplied, wave grouping is driven by `spec.stories[].wave`
 * (the declarative SSOT from `.agents/epics/<epic-id>.yaml`) and slugs are
 * resolved to GH issue numbers via the sibling `<epic-id>.state.json`
 * mapping; the checkpoint is still consulted for `currentWave`,
 * `totalWaves`, and `waves[]` history but its `plan[]` is overridden.
 *
 * @typedef {object} WaveTickArgs
 * @property {number | { id: number }} epic
 * @property {object} [spec] Parsed epic-spec (see lib/spec/loader.js). When
 *   provided, wave grouping comes from `spec.stories[].wave`.
 * @property {object} [state] Parsed epic-state (see lib/spec/loader.js).
 *   When `spec` is provided, this must be supplied so slugs can resolve to
 *   issue numbers via `state.mapping[slug].issueNumber`.
 * @property {{
 *   provider?: object,
 *   epicRunStateStore?: { read: () => Promise<object|null> },
 *   signalEmit?: (signal: object) => Promise<unknown>,
 *   inFlightReader?: () => Promise<number[]>,
 * }} [collaborators]
 * @property {{ provider?: object, config?: object }} [ctx]
 *
 * @param {WaveTickArgs} args
 */
export async function tick(args = {}) {
  const epicId = resolveEpicId(args.epic);
  const {
    provider: collabProvider,
    epicRunStateStore: collabStore,
    signalEmit,
    inFlightReader: collabInFlightReader,
  } = args.collaborators ?? {};
  const ctx = args.ctx ?? {};
  const provider = collabProvider ?? ctx.provider;
  const spec = args.spec ?? null;
  const specState = args.state ?? null;
  if (!provider) {
    throw new WaveRunnerError('invalid-input', 'provider is required');
  }
  // Story #2409 — the wave-runner tick is stateless. When the caller
  // does not supply a collaborator shim, we read the `epic-run-state`
  // structured comment directly via the function-based store, mirroring
  // the pre-migration `.read()` shape exactly.
  const epicRunStateStore = collabStore ?? {
    read: () => epicRunStateStoreModule.read({ provider, epicId }),
  };
  const emit = signalEmit ?? defaultSignalEmit(epicId, ctx);
  const inFlightReader =
    collabInFlightReader ?? (() => defaultInFlightReader(epicId, ctx?.config));

  let state;
  try {
    state = await epicRunStateStore.read();
  } catch (err) {
    throw new WaveRunnerError('checkpoint-read', err);
  }
  if (!state || typeof state !== 'object') {
    throw new WaveRunnerError(
      'checkpoint-missing',
      `no epic-run-state comment on Epic #${epicId}`,
    );
  }

  const currentWave = positiveIntOrZero(state.currentWave);
  const { plan, totalWaves } = resolvePlan(state, spec, specState);
  const history = Array.isArray(state.waves) ? state.waves : [];

  if (totalWaves === 0 || currentWave >= totalWaves) {
    await emit({
      kind: 'epic-complete',
      totalWaves,
      completedWaves: history.length,
    });
    return tickResult({
      nextAction: { kind: 'epic-complete' },
      currentWave,
      totalWaves,
    });
  }

  const wavePlan = Array.isArray(plan[currentWave]) ? plan[currentWave] : [];
  if (wavePlan.length === 0) {
    await emit({
      kind: 'wave-complete',
      index: currentWave,
      totalWaves,
      empty: true,
    });
    return tickResult({
      nextAction: { kind: 'wave-complete', index: currentWave },
      currentWave,
      totalWaves,
    });
  }

  const baseTick = {
    kind: 'wave-tick',
    index: currentWave,
    totalWaves,
    wavePlanSize: wavePlan.length,
  };

  let waveStates;
  try {
    waveStates = await Promise.all(
      wavePlan.map(async (s) => {
        const id = storyIdOf(s);
        const ticket = await provider.getTicket(id, { fresh: true });
        return {
          id,
          title: s.title ?? ticket?.title,
          worktree: s.worktree,
          labels: Array.isArray(ticket?.labels) ? ticket.labels : [],
        };
      }),
    );
  } catch (err) {
    throw new WaveRunnerError('story-fetch', err);
  }

  const done = waveStates.filter((s) => s.labels.includes(AGENT_LABELS.DONE));
  const blocked = waveStates.filter((s) =>
    s.labels.includes(AGENT_LABELS.BLOCKED),
  );
  const executing = waveStates.filter((s) =>
    s.labels.includes(AGENT_LABELS.EXECUTING),
  );
  const undispatched = waveStates.filter((s) => isUndispatched(s.labels));

  const blockedStories = blocked.map((s) => ({
    storyId: s.id,
    reason: 'agent::blocked',
    detail: s.title,
  }));
  const gateFailures = readGateFailures(history, currentWave);

  // Story #2891 — compute in-flight Stories from the lifecycle ledger.
  // A Story is "in-flight" when the ledger carries a
  // `story.dispatch.start` record for it without a matching
  // `story.dispatch.end`. The reconciliation is purely additive on the
  // result envelope so callers can surface dispatched-but-uncompleted
  // Stories that the per-Wave label state alone cannot reveal.
  const inFlight = await safeReadInFlight(inFlightReader);

  // 6. Decide nextAction.
  let nextAction;
  let tickDetail;

  if (blockedStories.length) {
    nextAction = { kind: 'observe', waitingOn: blocked.map((s) => s.id) };
    tickDetail = { decision: 'observe-blocked' };
  } else if (undispatched.length) {
    // First dispatch of this wave fires `wave-start` exactly once.
    if (executing.length === 0 && done.length === 0) {
      await emit({
        kind: 'wave-start',
        index: currentWave,
        totalWaves,
        stories: wavePlan.map((s) => ({ id: storyIdOf(s), title: s.title })),
      });
    }
    nextAction = {
      kind: 'dispatch',
      stories: undispatched.map((s) => ({
        id: s.id,
        title: s.title,
        worktree: s.worktree,
      })),
    };
    tickDetail = {
      decision: 'dispatch',
      dispatchableCount: undispatched.length,
    };
  } else if (executing.length) {
    nextAction = { kind: 'observe', waitingOn: executing.map((s) => s.id) };
    tickDetail = { decision: 'observe-in-flight' };
  } else if (currentWave + 1 >= totalWaves) {
    await emit({
      kind: 'epic-complete',
      totalWaves,
      completedWaves: history.length + 1,
    });
    nextAction = { kind: 'epic-complete' };
    tickDetail = { decision: 'epic-complete' };
  } else {
    await emit({ kind: 'wave-complete', index: currentWave, totalWaves });
    nextAction = { kind: 'wave-complete', index: currentWave };
    tickDetail = { decision: 'wave-complete' };
  }

  await emit({ ...baseTick, nextAction: nextAction.kind, ...tickDetail });

  // Story #2891 — attach the in-flight ledger reconciliation to the
  // nextAction envelope. Always emit the field (empty array when the
  // ledger is silent) so downstream consumers can pattern-match on
  // presence without an existence check.
  nextAction['in-flight'] = inFlight;

  return tickResult({
    nextAction,
    blockedStories,
    gateFailures,
    currentWave,
    totalWaves,
  });
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
  return inFlight;
}

function tickResult({
  nextAction,
  blockedStories = [],
  gateFailures = [],
  currentWave,
  totalWaves,
}) {
  return { nextAction, blockedStories, gateFailures, currentWave, totalWaves };
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

function storyIdOf(s) {
  if (typeof s === 'number') return s;
  return s.id ?? s.storyId ?? s.number;
}

/**
 * Walk `spec.features[].stories[]` and bucket entries by their `wave`
 * value, mapping slugs → GH issue numbers via the sibling state file.
 * Returns `Story[][]` indexed by wave number; missing waves between 0 and
 * the highest declared wave are emitted as empty arrays so wave N is
 * always reachable as `plan[N]`.
 *
 * Each emitted entry is shaped to match the checkpoint plan's
 * `{ id, title }` contract that the rest of `tick()` already consumes:
 *
 *   - `id` is the GH issue number resolved from `state.mapping[slug].issueNumber`
 *     so the same provider.getTicket(id) path used by the spec-less plan
 *     keeps working unchanged.
 *   - `title` is carried through from `story.title` so the wave-start
 *     signal can include the Story's human-readable name without an
 *     extra provider round-trip.
 *   - `slug` is preserved on the entry so observability + future
 *     re-resolution paths can re-key against the spec.
 *
 * When a Story slug has no resolved `issueNumber` in `state.mapping`
 * (a fresh spec entry the reconciler has not materialised yet), the entry
 * is skipped — un-materialised Stories cannot be dispatched anyway, and
 * including them with a `null` id would surface as a `story-fetch`
 * failure inside `tick()`. The reconciler will close the loop on the
 * next apply; until then, an empty wave is a faithful reflection of
 * GitHub state.
 *
 * Pure function — does not read disk, does not call GH. Callers are
 * expected to compose it with `loadSpec` + `loadState` from
 * `lib/spec/loader.js`.
 *
 * @param {object} spec Parsed epic-spec (see lib/spec/loader.js).
 * @param {{mapping?: Record<string, {issueNumber?: number}>}|null} [state]
 *   Parsed epic-state. May be omitted; if missing, no entries can be
 *   resolved and `groupByWave` returns `[]`.
 * @returns {Array<Array<{id: number, title?: string, slug: string}>>}
 */
export function groupByWave(spec, state = null) {
  const mapping =
    state && typeof state.mapping === 'object' && state.mapping !== null
      ? state.mapping
      : {};
  const entries = extractValidStoryEntries(spec, mapping);
  if (entries.length === 0) return [];
  const byWave = new Map();
  let maxWave = -1;
  for (const { wave, entry } of entries) {
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push(entry);
    if (wave > maxWave) maxWave = wave;
  }
  if (maxWave < 0) return [];
  const out = [];
  for (let i = 0; i <= maxWave; i += 1) {
    out.push(byWave.get(i) ?? []);
  }
  return out;
}

/**
 * Walk every feature/story pair in `spec` and emit only the entries that
 * survive the spec-validity cascade: the story must be a non-null object,
 * declare a non-negative integer `wave`, declare a string `slug`, and
 * resolve to a numeric `issueNumber` in `mapping`. Each surviving entry
 * is returned as `{ wave, entry }` where `entry` carries the same shape
 * (`{ id, title, slug }`) that `groupByWave` previously pushed into its
 * per-wave bucket.
 *
 * Extracted from `groupByWave` so the bucketing transform stays
 * straight-line; this predicate owns the entire defensive guard cascade
 * and is the right place to add new validation rules going forward.
 *
 * @param {object|null|undefined} spec Parsed epic-spec.
 * @param {Record<string, {issueNumber?: number}>} mapping
 *   Slug → issue-number lookup from the sibling state file.
 * @returns {Array<{wave: number, entry: {id: number, title?: string, slug: string}}>}
 */
export function extractValidStoryEntries(spec, mapping) {
  const out = [];
  const features = Array.isArray(spec?.features) ? spec.features : [];
  for (const feature of features) {
    const stories = Array.isArray(feature?.stories) ? feature.stories : [];
    for (const story of stories) {
      const resolved = resolveStoryEntry(story, mapping);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

/**
 * Validate a single `story` against the spec-validity cascade and return
 * `{ wave, entry }` when every guard passes, or `null` when any guard
 * trips. Splitting the per-story cascade out keeps both
 * `extractValidStoryEntries` (which owns iteration) and `resolveStoryEntry`
 * (which owns validation) below CRAP 5 even when none of the branches are
 * exercised at runtime — the predicate's cyclomatic footprint is small
 * enough that uncovered branches do not blow the baseline budget.
 *
 * @param {*} story Candidate story from `spec.features[].stories[]`.
 * @param {Record<string, {issueNumber?: number}>} mapping Slug → issue lookup.
 * @returns {{wave: number, entry: {id: number, title?: string, slug: string}} | null}
 */
function resolveStoryEntry(story, mapping) {
  if (!story || typeof story !== 'object') return null;
  if (!Number.isInteger(story.wave) || story.wave < 0) return null;
  if (typeof story.slug !== 'string' || !story.slug) return null;
  const mapped = mapping[story.slug];
  if (!mapped || typeof mapped.issueNumber !== 'number') return null;
  return {
    wave: story.wave,
    entry: { id: mapped.issueNumber, title: story.title, slug: story.slug },
  };
}

/**
 * Resolve which plan + totalWaves drive this tick. When `spec` is
 * supplied, the spec-derived grouping wins (and totalWaves comes from
 * the spec since the checkpoint may lag); otherwise the checkpoint's
 * plan is used unchanged. Extracted so `tick()`'s cyclomatic complexity
 * stays inside its baseline budget — the route choice is now a single
 * call, not three ternaries inline.
 *
 * @param {object} state Checkpoint state (already validated as object).
 * @param {object|null} spec Parsed epic-spec or `null` when omitted.
 * @param {object|null} specState Parsed epic-state for slug mapping.
 * @returns {{plan: Array<Array<object>>, totalWaves: number}}
 */
function resolvePlan(state, spec, specState) {
  if (spec) {
    const specPlan = groupByWave(spec, specState);
    return { plan: specPlan, totalWaves: specPlan.length };
  }
  const plan = Array.isArray(state.plan) ? state.plan : [];
  return { plan, totalWaves: positiveIntOrZero(state.totalWaves) };
}

function isUndispatched(labels) {
  return (
    !labels.includes(AGENT_LABELS.DONE) &&
    !labels.includes(AGENT_LABELS.BLOCKED) &&
    !labels.includes(AGENT_LABELS.EXECUTING)
  );
}

function readGateFailures(history, currentWave) {
  const prior = history[currentWave - 1];
  if (!prior || !Array.isArray(prior.stories)) return [];
  return prior.stories
    .filter((s) => s.status === 'failed' && typeof s.detail === 'string')
    .map((s) => ({
      storyId: s.storyId,
      gate: s.gate ?? 'unspecified',
      detail: s.detail,
    }));
}

/**
 * Default emitter — appends to per-Epic `signals.ndjson`. Best-effort;
 * never throws. Tests override via `collaborators.signalEmit`.
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
