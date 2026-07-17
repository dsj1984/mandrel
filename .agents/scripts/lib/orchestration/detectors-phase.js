/**
 * detectors-phase.js — pure phase that runs the per-Story signal detectors
 * (rework + retry) over the local NDJSON stream.
 *
 * Story #4545 — this phase has no production caller. Its sequencer
 * (`post-merge-pipeline.js`) went in the v2.0.0 cutover, and the
 * `analyze-execution.js` consumer it fed was deleted with the
 * execution-analysis surface. Kept alive only by its own test — the
 * test-importer blind spot the dead-exports ratchet cannot see.
 *
 * Extracted from `post-merge-pipeline.js` (Story #1770 / Task #1779) to
 * keep the parent sequencer's maintainability score above its baseline
 * after the new wiring layer landed. The phase contract is identical to
 * every other entry in `DEFAULT_POST_MERGE_PHASES`: take a context bag,
 * return a value the runner stitches under a `stateKey`.
 *
 * ### Contract
 *
 * - **Pure detectors.** Both `detectRework` and `detectRetry` are pure
 *   modules under `lib/signals/detectors/` — they read the per-Story
 *   `traces.ndjson` and return SignalEvent arrays. This phase resolves
 *   the operator-tunable thresholds via `getSignals(config)` (Epic
 *   #1720 — `delivery.signals.*`), invokes each detector, and persists
 *   each event through `appendSignal` so the per-Story `signals.ndjson`
 *   stream covers both kinds before the analyzer reads it.
 *
 * - **Failure isolation.** A failing detector or a per-event append
 *   MUST NOT block Task close. Each call is wrapped in try/catch;
 *   failures degrade to a warn and contribute 0 to the offending
 *   detector's count. The phase always resolves with a stable
 *   `{ rework: N, retry: N }` shape.
 *
 * - **One info line per close.** The summary log
 *   (`detectors: rework=N retry=M`) is the only stdout signal — one
 *   line per Story rather than two per detector + N per event.
 *
 * - **2-tier (Storyless) closure (Story #3127).** When `tasks` is
 *   empty (the 2-tier hierarchy shape), `resolveLastTaskId` returns
 *   `null` and both detectors run with `taskId: null`. The detector
 *   modules already accept a nullable `taskId` (see
 *   `lib/signals/detectors/{rework,retry}.js`), so no branching on
 *   hierarchy mode is required here.
 *
 * @module lib/orchestration/detectors-phase
 */

import path from 'node:path';
import { getSignals } from '../config/limits.js';
import { storyTempDir } from '../config/temp-paths.js';
import { Logger } from '../Logger.js';
import { appendSignal } from '../observability/signals-writer.js';
import { detectRetry, detectRework } from '../signals/detectors/index.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

function resolveLastTaskId(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const last = tasks[tasks.length - 1];
  const id = Number(last?.id ?? last);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function persistDetectorEvents({
  events,
  epicId,
  storyId,
  config,
  appendSignalFn,
  logger,
  kind,
}) {
  let count = 0;
  for (const evt of events) {
    try {
      await appendSignalFn({ epicId, storyId, signal: evt, config });
      count += 1;
    } catch (err) {
      logger?.warn?.(
        `[detectors-phase] ${kind} appendSignal failed (${err?.message ?? err})`,
      );
    }
  }
  return count;
}

async function runOneDetector({
  detectorFn,
  args,
  epicId,
  storyId,
  config,
  appendSignalFn,
  logger,
  kind,
}) {
  try {
    const events = await detectorFn(args);
    return await persistDetectorEvents({
      events,
      epicId,
      storyId,
      config,
      appendSignalFn,
      logger,
      kind,
    });
  } catch (err) {
    logger?.warn?.(
      `[detectors-phase] ${kind} detector threw (${err?.message ?? err})`,
    );
    return 0;
  }
}

function isValidIdPair(eid, sid) {
  return Number.isInteger(eid) && eid > 0 && Number.isInteger(sid) && sid > 0;
}

/**
 * Run the rework + retry detectors for one Story and persist every
 * emission to `temp/run-<id>/stories/story-<sid>/signals.ndjson`.
 *
 * @param {{
 *   epicId: number|string,
 *   storyId: number|string,
 *   tasks?: Array<{ id?: number|string }>,
 *   config?: object,
 *   progress?: Function,
 *   logger?: object,
 *   detectorsImpl?: { detectRework?: typeof detectRework, detectRetry?: typeof detectRetry },
 *   appendSignalFn?: typeof appendSignal,
 * }} ctx
 * @returns {Promise<{ rework: number, retry: number }>}
 */
export async function detectorsPhase(ctx) {
  const {
    epicId,
    storyId,
    tasks,
    config,
    progress,
    logger = Logger,
    detectorsImpl,
    appendSignalFn = appendSignal,
  } = ctx;
  const log = reapPhaseLogger(progress);
  const eid = Number(epicId);
  const sid = Number(storyId);
  if (!isValidIdPair(eid, sid)) {
    logger?.warn?.(
      `[detectors-phase] skipped: invalid epicId=${epicId} / storyId=${storyId}`,
    );
    return { rework: 0, retry: 0 };
  }

  let signalsCfg;
  try {
    signalsCfg = getSignals(config);
  } catch (err) {
    logger?.warn?.(
      `[detectors-phase] getSignals failed (${err?.message ?? err}); using zero counts`,
    );
    return { rework: 0, retry: 0 };
  }

  const tracesPath = path.join(storyTempDir(eid, sid, config), 'traces.ndjson');
  const taskId = resolveLastTaskId(tasks);
  const baseArgs = { tracesPath, epicId: eid, storyId: sid, taskId };
  const common = {
    epicId: eid,
    storyId: sid,
    config,
    appendSignalFn,
    logger,
  };

  const rework = await runOneDetector({
    ...common,
    detectorFn: detectorsImpl?.detectRework ?? detectRework,
    args: { ...baseArgs, threshold: signalsCfg.rework.editsPerFile },
    kind: 'rework',
  });
  const retry = await runOneDetector({
    ...common,
    detectorFn: detectorsImpl?.detectRetry ?? detectRetry,
    args: { ...baseArgs, threshold: signalsCfg.retry.repeatCount },
    kind: 'retry',
  });

  log('DETECTORS', `detectors: rework=${rework} retry=${retry}`);
  return { rework, retry };
}
