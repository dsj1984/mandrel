/**
 * handoff-state.js — where `story-handoff.js` keeps its per-Story state, and
 * the one read close makes of it: the credited run's lock wait and suite
 * timings. Kept apart from the handoff so close need not load its graph.
 */

import fs from 'node:fs';
import path from 'node:path';

import { orchestrationLogDir } from '../config/temp-paths.js';

/**
 * @param {string} logDir
 * @param {number} storyId
 * @returns {string}
 */
export function handoffStatePath(logDir, storyId) {
  return path.join(logDir, `story-handoff-${storyId}.json`);
}

/**
 * `null` unless the state's `creditTimings` is keyed to its current
 * `creditHead` and that run spawned a suite.
 *
 * @param {number} storyId
 * @param {object} config
 * @param {{ fsImpl?: typeof fs }} [opts]
 * @returns {{ head: string, lockWait: object|null, suiteTimings: object, spawns: object[] }|null}
 */
export function readCreditTimings(storyId, config, { fsImpl = fs } = {}) {
  let state;
  try {
    const file = handoffStatePath(orchestrationLogDir(config), storyId);
    state = JSON.parse(fsImpl.readFileSync(file, 'utf8'))?.state;
  } catch {
    return null;
  }
  const credit = state?.creditTimings;
  if (!credit?.suiteTimings || credit.head !== state.creditHead) return null;
  return credit;
}
