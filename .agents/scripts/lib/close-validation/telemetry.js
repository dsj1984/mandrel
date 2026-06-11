/**
 * close-validation/telemetry.js — gh-spawn telemetry emitter.
 */

import { writeFile as defaultWriteFile } from 'node:fs/promises';
import { storyArtifactPath } from '../config/temp-paths.js';
import { getSpawnCount as defaultGetSpawnCount } from '../gh-exec.js';

/**
 * Throw-away ghSpawnCount emitter (Story #1795 / Epic #1788).
 *
 * Writes the current `gh-exec` spawn counter to
 * `temp/epic-<eid>/stories/story-<sid>/gh-spawn-count.json` so the
 * `analyze-execution.js` child process can read it and emit a
 * `ghSpawnCount` field on the `story-perf-summary` payload. The Story-
 * close orchestrator calls this inside `runPostMergeClose` right before
 * the perf-summary phase, capturing every `gh` invocation from preflight
 * through the merge in one counter snapshot.
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
  const targetPath = storyArtifactPath(eid, sid, 'gh-spawn-count.json', config);
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
