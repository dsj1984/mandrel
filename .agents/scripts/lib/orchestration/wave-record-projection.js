/**
 * wave-record-projection.js — pure projection helpers for the record-wave CLI.
 *
 * This module is the post-wave-record projection layer extracted from
 * `.agents/scripts/epic-execute-record-wave.js`. Every export here is pure:
 * no network I/O, no filesystem reads, no spawning. The parent CLI handles
 * the impure work (provider calls, checkpoint reads/writes, webhook emits,
 * manifest refresh) and threads the resolved inputs through these helpers
 * to produce the wave's new checkpoint record, rollup rows, and envelope
 * fields.
 *
 * Group the exports by responsibility:
 *
 *   - Input validation: `validateResults`, `validateReturnsEntry`,
 *     `classifyParsedReturn`, `validateEpicWave`, `validateResultsReturnsXor`,
 *     `selectInputFlag`, `resolveConcurrencyCap`.
 *   - Aggregation: `aggregateWaveStatus`, `countDoneStories`,
 *     `classifyWaveOutcome`.
 *   - Projection: `toRollupRow`, `projectWaveRecord`.
 *
 * The aggregator `projectWaveRecord` is the entry point: given the verified
 * per-Story rows, the prior checkpoint, the wave index, the resolved
 * concurrency cap, and a `titleById` map, it returns every derived shape the
 * CLI needs to (a) write the next checkpoint, (b) render `epic-run-progress`,
 * (c) classify the next slash-command action, and (d) assemble the stdout
 * envelope. It is the single source of truth for "what does the wave look
 * like after these results land?"
 */

import { parseStoryAgentReturn } from './epic-runner/sub-agent-return.js';

/** Valid wave-level rollup statuses. */
export const VALID_RESULT_STATUSES = new Set(['complete', 'blocked', 'failed']);

/** Per-Story return statuses we accept off `/story-execute` sub-agents. */
export const VALID_STORY_STATUSES = new Set(['done', 'blocked', 'failed']);

/**
 * Story status → rollup-row state. Post-fan-out every Story is in a
 * terminal state, so we only emit the three terminal forms here.
 */
export const STORY_STATUS_TO_ROW_STATE = {
  done: 'done',
  blocked: 'blocked',
  failed: 'failed',
};

/**
 * Validate and normalize an inbound `--results` array into the per-Story
 * shape the rest of the pipeline consumes.
 *
 * @param {unknown} raw
 */
export function validateResults(raw) {
  if (!Array.isArray(raw)) {
    throw new TypeError(
      'epic-execute-record-wave: --results must be a JSON array of per-Story result objects',
    );
  }
  return raw.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(
        `epic-execute-record-wave: results[${idx}] must be an object; got ${typeof entry}`,
      );
    }
    const storyId = Number(entry.storyId ?? entry.id);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      throw new TypeError(
        `epic-execute-record-wave: results[${idx}].storyId must be a positive integer; got ${JSON.stringify(entry.storyId)}`,
      );
    }
    const status = String(entry.status ?? '');
    if (!VALID_STORY_STATUSES.has(status)) {
      throw new RangeError(
        `epic-execute-record-wave: results[${idx}].status "${status}" must be one of: ${[...VALID_STORY_STATUSES].join(', ')}`,
      );
    }
    const out = { storyId, status };
    if (typeof entry.phase === 'string') out.phase = entry.phase;
    if (Number.isInteger(entry.tasksDone)) out.tasksDone = entry.tasksDone;
    if (Number.isInteger(entry.tasksTotal)) out.tasksTotal = entry.tasksTotal;
    if (entry.blockerCommentId != null) {
      out.blockerCommentId = String(entry.blockerCommentId);
    }
    return out;
  });
}

/**
 * Pure validator for a single `--returns[]` entry. Throws the same
 * `TypeError`s the outer loop used to throw inline, returning a
 * `{ storyId, returnText }` pair on success. Extracted so `normalizeReturns`
 * can route each entry through the same validate → parse → reconcile path
 * without nesting four conditionals deep.
 */
export function validateReturnsEntry(entry, idx) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(
      `epic-execute-record-wave: returns[${idx}] must be an object; got ${typeof entry}`,
    );
  }
  const storyId = Number(entry.storyId ?? entry.id);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError(
      `epic-execute-record-wave: returns[${idx}].storyId must be a positive integer; got ${JSON.stringify(entry.storyId)}`,
    );
  }
  let returnText;
  if (typeof entry.returnText === 'string') {
    returnText = entry.returnText;
  } else if (entry.returnText == null) {
    returnText = '';
  } else {
    returnText = JSON.stringify(entry.returnText);
  }
  return { storyId, returnText };
}

/**
 * Pure helper: classify a parsed sub-agent return for a known `storyId`.
 * Returns either `{ ok: true, value }` (use the parsed envelope as-is) or
 * `{ ok: false, error }` (caller must reconcile from GitHub and record a
 * parse failure with the message).
 */
export function classifyParsedReturn(parsed, storyId) {
  if (parsed.ok && Number(parsed.value.storyId) === storyId) {
    return { ok: true, value: parsed.value };
  }
  const error = parsed.ok
    ? `parsed envelope storyId ${parsed.value.storyId} disagrees with expected ${storyId}`
    : parsed.error;
  return { ok: false, error };
}

/**
 * Aggregate validated per-Story rows into the wave-level outcome. Pure.
 *
 * @param {Array<{ storyId: number, status: string }>} results
 */
export function aggregateWaveStatus(results) {
  const rows = Array.isArray(results) ? results : [];
  const failed = rows.filter((r) => r.status === 'failed');
  const blocked = rows.filter((r) => r.status === 'blocked');
  let status;
  if (failed.length > 0) {
    status = 'failed';
  } else if (blocked.length > 0) {
    status = 'blocked';
  } else {
    status = 'complete';
  }
  return {
    status,
    blockedStoryIds: blocked.map((r) => r.storyId),
  };
}

/**
 * Classify the wave outcome into the next operator action. Pure helper —
 * exported so tests can pin each branch without touching the provider.
 *
 * @param {{ resultStatus: string, currentWave: number, totalWaves: number }} args
 */
export function classifyWaveOutcome({ resultStatus, currentWave, totalWaves }) {
  const remainingWaves = Math.max(
    0,
    Number(totalWaves) - (Number(currentWave) + 1),
  );
  if (resultStatus === 'blocked') {
    return { nextAction: 'halt-blocked', remainingWaves };
  }
  if (resultStatus === 'failed') {
    return { nextAction: 'halt-failed', remainingWaves };
  }
  if (resultStatus === 'complete') {
    return {
      nextAction: remainingWaves > 0 ? 'dispatch-next' : 'finalize',
      remainingWaves,
    };
  }
  throw new RangeError(
    `classifyWaveOutcome: resultStatus "${resultStatus}" must be one of: ${[...VALID_RESULT_STATUSES].join(', ')}`,
  );
}

/**
 * Build the rollup-row shape the unified `epic-run-progress` writer
 * consumes. Returns `{ id, title, state, tasksDone?, tasksTotal?,
 * blockerCommentId? }`.
 */
export function toRollupRow(verified, titleById) {
  const row = {
    id: verified.storyId,
    title: titleById.get(verified.storyId) ?? '',
    state: STORY_STATUS_TO_ROW_STATE[verified.status] ?? 'unknown',
  };
  if (Number.isInteger(verified.tasksDone)) row.tasksDone = verified.tasksDone;
  if (Number.isInteger(verified.tasksTotal))
    row.tasksTotal = verified.tasksTotal;
  if (verified.status === 'blocked' && verified.blockerCommentId != null) {
    row.blockerCommentId = String(verified.blockerCommentId);
  }
  return row;
}

/** Pure: count Stories already marked `done` across every recorded wave. */
export function countDoneStories(waves) {
  return waves.reduce(
    (acc, w) =>
      acc +
      (Array.isArray(w.stories)
        ? w.stories.filter((s) => s?.state === 'done').length
        : 0),
    0,
  );
}

/** Validate the core `{ epicId, wave }` invariants. Throws on bad input. */
export function validateEpicWave(epicId, wave) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicExecuteRecordWave: --epic must be a positive integer',
    );
  }
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError(
      'runEpicExecuteRecordWave: --wave must be a non-negative integer',
    );
  }
}

/** Validate the `results`/`returns` XOR. Throws on bad input. */
export function validateResultsReturnsXor(results, returns) {
  if (results == null && returns == null) {
    throw new TypeError(
      'runEpicExecuteRecordWave: either `results` or `returns` is required',
    );
  }
  if (results != null && returns != null) {
    throw new TypeError(
      'runEpicExecuteRecordWave: pass `results` OR `returns`, not both',
    );
  }
}

/** Resolve the effective concurrency cap, honouring CLI > checkpoint > config. */
export function resolveConcurrencyCap(
  concurrencyCapOverride,
  existing,
  deliverRunner,
) {
  const cap =
    concurrencyCapOverride ??
    Number(existing.concurrencyCap) ??
    Number(deliverRunner.concurrencyCap) ??
    1;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(
      `runEpicExecuteRecordWave: resolved concurrencyCap "${cap}" must be a positive integer; ` +
        'pass --concurrency-cap or set `orchestration.runners.deliverRunner.concurrencyCap`.',
    );
  }
  return cap;
}

/**
 * Pure helper: enforce the XOR contract between `--results` and `--returns`.
 * Throws on "neither" / "both"; otherwise returns the chosen flag name so
 * the CLI can route to `parseInputArg` with a single branch.
 */
export function selectInputFlag(hasResults, hasReturns) {
  if (hasResults && hasReturns) {
    throw new TypeError(
      'epic-execute-record-wave: pass --results OR --returns, not both',
    );
  }
  if (!hasResults && !hasReturns) {
    throw new TypeError(
      'epic-execute-record-wave: --results or --returns is required',
    );
  }
  return hasResults ? 'results' : 'returns';
}

/**
 * Normalize a return-text array into the parsed-results shape, returning the
 * envelopes that parsed cleanly and a list of failures for entries that
 * disagreed with their expected `storyId` or were not envelope-shaped. This
 * is the pure half of `normalizeReturns` in the CLI; the impure half
 * (`reconcileStoryFromGitHub` on each failure) is bound by the caller via
 * the `reconcile` dependency.
 *
 * Tests pin the success path without binding `reconcile`; the CLI binds it
 * to the network helper.
 *
 * @param {object} args
 * @param {Array<{ storyId: number, returnText: string }>} args.returns
 * @param {(args: { storyId: number }) => Promise<object> | object} [args.reconcile]
 *   Optional async hook used to fetch a fallback row when parsing fails. If
 *   omitted, parse failures push a placeholder `{ storyId, status: 'failed' }`
 *   row so the caller can still aggregate without I/O.
 */
export async function normalizeReturnsPure({ returns, reconcile } = {}) {
  if (!Array.isArray(returns)) {
    throw new TypeError(
      'epic-execute-record-wave: --returns must be a JSON array of { storyId, returnText } objects',
    );
  }
  const results = [];
  const parseFailures = [];
  for (const [idx, entry] of returns.entries()) {
    const { storyId, returnText } = validateReturnsEntry(entry, idx);
    const parsed = parseStoryAgentReturn(returnText);
    const classified = classifyParsedReturn(parsed, storyId);
    if (classified.ok) {
      results.push(classified.value);
      continue;
    }
    const fallback = reconcile
      ? await reconcile({ storyId })
      : { storyId, status: 'failed' };
    results.push(fallback);
    parseFailures.push({ storyId, error: classified.error, returnText });
  }
  return { results, parseFailures };
}

/**
 * Project the post-wave-record state from verified per-Story rows. Pure
 * end-to-end: every derived field the CLI needs after `verifyWaveResults`
 * lands here. The CLI hands us the verified rows, the existing checkpoint
 * (so we can splice this wave's record), the wave index, the resolved cap,
 * the manifest title map, and a `now` clock.
 *
 * Returns the union of:
 *   - the new `epic-run-state` shape (`nextWaves`, `nextCurrentWave`,
 *     `totalWaves`),
 *   - the rollup payload (`rollupRows`, `rollupWaves`),
 *   - the wave-level outcome (`status`, `blockedStoryIds`),
 *   - the slash-command next action (`nextAction`, `remainingWaves`).
 *
 * The CLI handles I/O around this projection: writing the checkpoint,
 * upserting `epic-run-progress`, emitting webhooks, refreshing the local
 * manifest. None of those impure side-effects live here.
 *
 * @param {object} args
 * @param {number} args.wave
 * @param {Array<object>} args.verified
 * @param {object} args.existing
 * @param {number} args.concurrencyCap
 * @param {Map<number, string>} args.titleById
 * @param {() => Date} [args.now]
 */
export function projectWaveRecord({
  wave,
  verified,
  existing,
  concurrencyCap,
  titleById,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(wave) || wave < 0) {
    throw new TypeError(
      'projectWaveRecord: wave must be a non-negative integer',
    );
  }
  if (!existing || typeof existing !== 'object') {
    throw new TypeError('projectWaveRecord: existing checkpoint is required');
  }
  if (!(titleById instanceof Map)) {
    throw new TypeError('projectWaveRecord: titleById must be a Map');
  }

  const totalWaves = Number(existing.totalWaves ?? 0);
  const verifiedRows = Array.isArray(verified) ? verified : [];

  const { status, blockedStoryIds } = aggregateWaveStatus(verifiedRows);
  const rollupRows = verifiedRows.map((r) => toRollupRow(r, titleById));

  const priorWaves = Array.isArray(existing.waves) ? existing.waves : [];
  const newRecord = {
    index: wave,
    status,
    concurrencyCap,
    stories: rollupRows,
    completedAt: now().toISOString(),
  };
  const filtered = priorWaves.filter((w) => Number(w?.index) !== Number(wave));
  const nextWaves = [...filtered, newRecord].sort(
    (a, b) => Number(a.index) - Number(b.index),
  );

  const nextCurrentWave =
    status === 'complete'
      ? Math.min(totalWaves, wave + 1)
      : Number(existing.currentWave ?? wave);

  const rollupWaves = nextWaves.map((w) => ({
    wave: Number(w.index),
    concurrencyCap: Number(w.concurrencyCap) || concurrencyCap,
    stories: Array.isArray(w.stories) ? w.stories : [],
  }));

  const { nextAction, remainingWaves } = classifyWaveOutcome({
    resultStatus: status,
    currentWave: wave,
    totalWaves,
  });

  return {
    status,
    blockedStoryIds,
    rollupRows,
    newRecord,
    priorWaves,
    nextWaves,
    nextCurrentWave,
    totalWaves,
    rollupWaves,
    nextAction,
    remainingWaves,
  };
}
