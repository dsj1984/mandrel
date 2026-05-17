/**
 * fire-escalation.js — escalation path triggered after N consecutive
 * `ProgressReporter.fire()` failures.
 *
 * Emits a `friction` signal against the Epic and transitions the Epic
 * ticket to `agent::blocked` so a persistent provider/auth/rate-limit
 * failure stops masquerading as a slow run. Both operations are
 * best-effort — a failure inside the escalation path is logged at warn
 * level but never thrown (the interval handler keeps the reporter alive
 * so recovery can still reset the counter).
 */

import { AGENT_LABELS } from '../../../label-constants.js';
import { appendSignal } from '../../../observability/signals-writer.js';

/**
 * @param {{
 *   provider: object,
 *   epicId: number,
 *   config?: object,
 *   threshold: number,
 *   err: unknown,
 *   logger?: { warn?: Function },
 * }} input
 */
export async function escalateFireFailure({
  provider,
  epicId,
  config,
  threshold,
  err,
  logger,
}) {
  const warn = (m) => logger?.warn?.(`[ProgressReporter] ${m}`);
  try {
    await appendSignal({
      epicId: Number(epicId),
      storyId: Number(epicId),
      signal: {
        kind: 'friction',
        timestamp: new Date().toISOString(),
        epicId: Number(epicId),
        category: 'progress-reporter-fire-failure',
        source: { tool: 'epic-runner/progress-reporter.js' },
        details: `${threshold} consecutive fire() failures; last error: ${String(err?.message ?? err).slice(0, 400)}`,
      },
      config,
    });
  } catch (signalErr) {
    warn(`escalation friction append failed: ${signalErr?.message ?? signalErr}`);
  }

  try {
    const epic = await provider.getTicket(epicId);
    const labels = (epic?.labels || [])
      .filter((l) => !l.startsWith('agent::'))
      .concat(AGENT_LABELS.BLOCKED);
    await provider.updateTicket(epicId, { labels });
    warn(
      `Epic #${epicId} → ${AGENT_LABELS.BLOCKED} after ${threshold} consecutive fire() failures`,
    );
  } catch (labelErr) {
    warn(`escalation label transition failed: ${labelErr?.message ?? labelErr}`);
  }
}
