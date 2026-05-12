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
 * @param {{
 *   epic: number | { id: number },
 *   collaborators?: {
 *     provider?: object,
 *     checkpointer?: { read: () => Promise<object|null> },
 *     signalEmit?: (signal: object) => Promise<unknown>,
 *   },
 *   ctx?: { provider?: object, config?: object },
 * }} args
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

  const totalWaves = positiveIntOrZero(state.totalWaves);
  const currentWave = positiveIntOrZero(state.currentWave);
  const plan = Array.isArray(state.plan) ? state.plan : [];
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
