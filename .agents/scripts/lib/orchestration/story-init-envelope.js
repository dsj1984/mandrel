/**
 * Read back the init envelope `single-story-init.js` writes — the record of
 * what a run was seeded with, including the `runScopedConfig` pin. Never
 * throws: anything unreadable is `null` (the temp tree is reapable).
 *
 * @module lib/orchestration/story-init-envelope
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../config/temp-paths.js';

/**
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
    // Markers bracket the JSON: take the outermost brace span.
    const fence = /\{[\s\S]*\}/.exec(readFileFn(file, 'utf8'));
    const payload = fence ? JSON.parse(fence[0]) : null;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
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
