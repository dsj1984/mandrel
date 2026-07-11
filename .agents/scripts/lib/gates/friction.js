/**
 * Friction-signal emit helper shared by the baseline gates. The gate
 * supplies the violation payload; this helper owns the canonical envelope
 * shape (`kind`/`ts`/`emitter`) and swallows append errors after a warn
 * so observability outages never block a gate run.
 *
 * `details` is normalised to an object (never a bare string) per the
 * Epic #4406 canonical contract — a string caller value is wrapped as
 * `{ message }`.
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
  const detailsObj =
    typeof details === 'string'
      ? { message: details }
      : details && typeof details === 'object'
        ? details
        : {};
  try {
    await appendSignal({
      epicId,
      storyId,
      signal: {
        kind: 'friction',
        ts: new Date().toISOString(),
        epicId,
        storyId,
        category,
        emitter: { tool },
        details: detailsObj,
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
