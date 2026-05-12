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

import { AGENT_LABELS } from '../label-constants.js';
import { appendEpicSignal } from '../observability/signals-writer.js';
import { Checkpointer } from '../orchestration/epic-runner/checkpointer.js';

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
 *   checkpointer?: { read: () => Promise<object|null> },
 *   signalEmit?: (signal: object) => Promise<unknown>,
 * }} [collaborators]
 * @property {{ provider?: object, config?: object }} [ctx]
 *
 * @param {WaveTickArgs} args
 */
export async function tick(args = {}) {
  const epicId = resolveEpicId(args.epic);
  const {
    provider: collabProvider,
    checkpointer: collabCheckpointer,
    signalEmit,
  } = args.collaborators ?? {};
  const ctx = args.ctx ?? {};
  const provider = collabProvider ?? ctx.provider;
  const spec = args.spec ?? null;
  const specState = args.state ?? null;
  if (!provider) {
    throw new WaveRunnerError('invalid-input', 'provider is required');
  }
  const checkpointer =
    collabCheckpointer ?? new Checkpointer({ provider, epicId });
  const emit = signalEmit ?? defaultSignalEmit(epicId, ctx);

  let state;
  try {
    state = await checkpointer.read();
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
  const specPlan = spec ? groupByWave(spec, specState) : null;
  const plan = specPlan ?? (Array.isArray(state.plan) ? state.plan : []);
  // When spec drives planning, totalWaves comes from the spec — the
  // checkpoint's totalWaves may lag spec edits between reconciliations.
  const totalWaves = specPlan
    ? specPlan.length
    : positiveIntOrZero(state.totalWaves);
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

  return tickResult({
    nextAction,
    blockedStories,
    gateFailures,
    currentWave,
    totalWaves,
  });
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
 * Walk `spec.features[].stories[]` and bucket entries by `wave`. Returns
 * `Story[][]` indexed by wave number; missing waves are emitted as empty
 * arrays so wave N is always `plan[N]`.
 *
 * Task #1533 scope: read wave numbers from `spec.stories[].wave` and emit
 * a plan-shaped grouping where each entry carries the Story's slug as
 * `id`. The slug → GH issue-number resolution (via `state.mapping`) is
 * the explicit subject of Task #1535 and lands as a refactor that
 * promotes this helper to a named export.
 *
 * @param {object} spec
 * @param {{mapping?: Record<string, {issueNumber?: number}>}|null} [_state]
 * @returns {Array<Array<{id: string, title?: string, slug?: string}>>}
 */
function groupByWave(spec, _state) {
  const byWave = new Map();
  let maxWave = -1;
  const features = Array.isArray(spec?.features) ? spec.features : [];
  for (const feature of features) {
    const stories = Array.isArray(feature?.stories) ? feature.stories : [];
    for (const story of stories) {
      if (!story || typeof story !== 'object') continue;
      const wave = Number.isInteger(story.wave) ? story.wave : null;
      if (wave === null || wave < 0) continue;
      const slug = typeof story.slug === 'string' ? story.slug : null;
      const entry = { id: slug, title: story.title, slug };
      if (!byWave.has(wave)) byWave.set(wave, []);
      byWave.get(wave).push(entry);
      if (wave > maxWave) maxWave = wave;
    }
  }
  if (maxWave < 0) return [];
  const out = [];
  for (let i = 0; i <= maxWave; i += 1) {
    out.push(byWave.get(i) ?? []);
  }
  return out;
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
