/**
 * story-init-envelope.js — read back the envelope `single-story-init.js`
 * writes for one Story.
 *
 * Init routes its full result object to
 * `<tempRoot>/orchestration/story-init-result-<id>.log` through
 * `emitTerseResult`, wrapped in the same `--- STORY INIT RESULT ---` markers
 * the legacy inline dump used. Story #5343 retired the `story-init` ticket
 * comment that duplicated it, which makes this file the durable record of
 * what a run was seeded with — most load-bearingly the `runScopedConfig` pin
 * `run-scoped-config.js` compares against at close.
 *
 * Total and non-throwing: a missing, unreadable or unparseable envelope
 * resolves to `null`, and the caller reports the degrade. Reading it is
 * always best-effort — the temp tree is reapable by design.
 *
 * @module lib/orchestration/story-init-envelope
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../config/temp-paths.js';

/**
 * Read one Story's init envelope, or `null` when there is none to read.
 *
 * @param {{
 *   storyId: number|string,
 *   config?: object,
 *   readFileFn?: typeof readFileSync,
 * }} args
 * @returns {object|null} the parsed init result, or `null`.
 */
function readStoryInitEnvelope({ storyId, config, readFileFn = readFileSync }) {
  const file = path.join(
    orchestrationLogDir(config),
    `story-init-result-${storyId}.log`,
  );
  try {
    // The log brackets the pretty JSON with human markers, so take the
    // outermost brace span rather than parsing the whole file.
    const fence = /\{[\s\S]*\}/.exec(readFileFn(file, 'utf8'));
    const payload = fence ? JSON.parse(fence[0]) : null;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The `runScopedConfig` pin off one Story's init envelope, or `null` when the
 * envelope is absent or carries none. The write half is
 * `run-scoped-config.js#pinRunScopedConfig`, which `single-story-init.js`
 * records on the envelope this reads back.
 *
 * @param {{
 *   storyId: number|string,
 *   config?: object,
 *   readEnvelopeFn?: typeof readStoryInitEnvelope,
 * }} args
 * @returns {Record<string, unknown>|null}
 */
export function readRunScopedPin({
  storyId,
  config,
  readEnvelopeFn = readStoryInitEnvelope,
}) {
  const pin = readEnvelopeFn({ storyId, config })?.runScopedConfig;
  return pin && typeof pin === 'object' ? pin : null;
}
