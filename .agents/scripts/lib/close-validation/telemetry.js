/**
 * close-validation/telemetry.js — gh-spawn telemetry emitter.
 */

import { writeFile as defaultWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { storyTempDir } from '../config/temp-paths.js';
import { getSpawnCount as defaultGetSpawnCount } from '../gh-exec.js';

/**
 * Throw-away ghSpawnCount emitter (Story #1795 / Epic #1788).
 *
 * Writes the current `gh-exec` spawn counter to
 * `temp/run-<id>/stories/story-<sid>/gh-spawn-count.json`.
 *
 * Story #4545 — its reader is gone: `analyze-execution.js` consumed this file
 * to emit a `ghSpawnCount` field on the `story-perf-summary` payload, and both
 * that CLI and that payload were deleted with the execution-analysis surface.
 * The writer itself already had no production caller before that (the
 * `runPostMergeClose` orchestrator named below went in the v2.0.0 cutover), so
 * this module is production-dead and kept alive only by its own test — the
 * test-importer blind spot the dead-exports ratchet cannot see. It is left in
 * place rather than deleted because reviving spawn telemetry against the live
 * close path is a decision, not a sweep.
 *
 * @param {object} opts
 * @param {number|string} opts.epicId
 * @param {number|string} opts.storyId
 * @param {object} [opts.config] - Resolved config bag so `tempRoot`
 *   resolution honours the consumer's configured path.
 * @param {() => number} [opts.getSpawnCountFn=defaultGetSpawnCount] - Test seam.
 * @param {typeof defaultWriteFile} [opts.writeFileFn=defaultWriteFile] - Test seam.
 * @param {{ warn?: (s: string) => void }} [opts.logger] - Best-effort
 *   failure-path logger; never throws.
 * @returns {Promise<{ status: 'ok'|'failed', path?: string, ghSpawnCount?: number, reason?: string }>}
 */
export async function emitGhSpawnCount({
  epicId,
  storyId,
  config,
  getSpawnCountFn = defaultGetSpawnCount,
  writeFileFn = defaultWriteFile,
  logger,
} = {}) {
  const eid = Number(epicId);
  const sid = Number(storyId);
  if (!Number.isInteger(eid) || eid < 1 || !Number.isInteger(sid) || sid < 1) {
    return { status: 'failed', reason: 'invalid-ids' };
  }
  let ghSpawnCount;
  try {
    ghSpawnCount = getSpawnCountFn();
  } catch (err) {
    logger?.warn?.(
      `[close-validation] gh-spawn-count read failed: ${err?.message ?? err}`,
    );
    return { status: 'failed', reason: 'counter-read-failed' };
  }
  const targetPath = path.join(
    storyTempDir(eid, sid, config),
    'gh-spawn-count.json',
  );
  const payload = {
    kind: 'gh-spawn-count',
    epicId: eid,
    storyId: sid,
    ghSpawnCount,
    capturedAt: new Date().toISOString(),
  };
  try {
    await writeFileFn(targetPath, JSON.stringify(payload, null, 2));
    return { status: 'ok', path: targetPath, ghSpawnCount };
  } catch (err) {
    logger?.warn?.(
      `[close-validation] gh-spawn-count emit failed: ${err?.message ?? err}`,
    );
    return { status: 'failed', reason: 'write-failed' };
  }
}
