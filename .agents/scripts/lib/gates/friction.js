/**
 * Friction-signal emit helper shared by the baseline gates. The gate
 * supplies the violation payload; this helper owns the envelope shape
 * (`kind`/`timestamp`/`source`) and swallows append errors after a warn
 * so observability outages never block a gate run.
 */

import { appendSignal } from '../signals/index.js';

export async function emitFrictionSignal({
  storyId,
  epicId,
  category,
  tool,
  details,
  payload,
  config,
  logger = console,
  logLabel = 'gate',
}) {
  if (!storyId || !epicId) return;
  try {
    await appendSignal({
      epicId,
      storyId,
      signal: {
        kind: 'friction',
        timestamp: new Date().toISOString(),
        epicId,
        storyId,
        category,
        source: { tool },
        details,
        ...payload,
      },
      config,
    });
  } catch (err) {
    logger.warn(
      `[${logLabel}] friction signal append failed: ${err?.message ?? err}`,
    );
  }
}
