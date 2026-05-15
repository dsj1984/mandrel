/**
 * hotspot-detection.js — pure helper that runs the Epic-scope hotspot
 * detector and persists every emission to the per-Epic `signals.ndjson`
 * stream via `appendEpicSignal`.
 *
 * Extracted from `progress-reporter.js` (Story #1770 / Task #1780) so the
 * reporter stays focused on the periodic-progress + comment-render
 * surface. The Epic-close orchestrator (`epic-deliver-finalize.js`)
 * imports this directly; `progress-reporter.js` re-exports for any
 * caller that previously imported the function from there.
 *
 * ### Contract
 *
 * - **Pure detector.** `detectHotspot` lives in
 *   `lib/signals/detectors/hotspot.js` — it walks every Story directory
 *   under `temp/epic-<eid>/`, aggregates edit counts per `targetHash`,
 *   and emits one `kind: 'hotspot'` SignalEvent per cross-Story hash
 *   whose count exceeds `p95(pool) * multiplier`.
 * - **Operator-tunable multiplier.** `getSignals(config).hotspot.p95Multiplier`
 *   is the only config surface — no direct SIGNALS_DEFAULTS import.
 * - **Failure isolation.** Detector / append failures degrade to a warn
 *   and contribute 0 to the count; the helper always resolves with a
 *   stable `{ hotspot: N }` shape so Epic close never blocks on
 *   observability.
 *
 * @module lib/orchestration/epic-runner/hotspot-detection
 */

import { getSignals } from '../../config/limits.js';
import { Logger } from '../../Logger.js';
import { appendEpicSignal } from '../../observability/signals-writer.js';
import { detectHotspot } from '../../signals/detectors/index.js';

async function persistHotspotEvents({
  events,
  epicId,
  config,
  append,
  logger,
}) {
  let count = 0;
  for (const evt of events) {
    try {
      await append({ epicId, signal: evt, config });
      count += 1;
    } catch (err) {
      logger?.warn?.(
        `[runHotspotDetection] appendEpicSignal failed (${err?.message ?? err})`,
      );
    }
  }
  return count;
}

/**
 * @param {{
 *   epicId: number|string,
 *   config?: object,
 *   logger?: object,
 *   detect?: typeof detectHotspot,
 *   append?: typeof appendEpicSignal,
 * }} opts
 * @returns {Promise<{ hotspot: number }>}
 */
export async function runHotspotDetection(opts = {}) {
  const {
    epicId,
    config,
    logger = Logger,
    detect = detectHotspot,
    append = appendEpicSignal,
  } = opts;
  const eid = Number(epicId);
  if (!Number.isInteger(eid) || eid <= 0) {
    logger?.warn?.(`[runHotspotDetection] skipped: invalid epicId=${epicId}`);
    return { hotspot: 0 };
  }

  let multiplier;
  try {
    multiplier = getSignals(config).hotspot.p95Multiplier;
  } catch (err) {
    logger?.warn?.(
      `[runHotspotDetection] getSignals failed (${err?.message ?? err}); skipping`,
    );
    return { hotspot: 0 };
  }

  let count = 0;
  try {
    const events = await detect({ epicId: eid, multiplier });
    count = await persistHotspotEvents({
      events,
      epicId: eid,
      config,
      append,
      logger,
    });
  } catch (err) {
    logger?.warn?.(
      `[runHotspotDetection] detector threw (${err?.message ?? err})`,
    );
  }

  logger?.info?.(
    `[runHotspotDetection] hotspot=${count} (multiplier=${multiplier})`,
  );
  return { hotspot: count };
}
