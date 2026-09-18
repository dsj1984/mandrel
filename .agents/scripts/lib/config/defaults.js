/**
 * `.agentrc.json` defaults from `.agents/docs/agentrc-reference.json`; a
 * parity test keeps them in lockstep with the runtime accessors' constants.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .agents/scripts/lib/config/ → .agents/
const AGENTS_ROOT = path.resolve(__dirname, '../../..');
export const FULL_AGENTRC_PATH = path.join(
  AGENTS_ROOT,
  'docs',
  'agentrc-reference.json',
);

/** Placeholder-valued paths: never auto-filled, never flagged redundant. */
export const IDENTITY_PLACEHOLDER_PATHS = Object.freeze([
  'github.owner',
  'github.repo',
  'github.operatorHandle',
]);

let _cache = null;

/**
 * @param {{ bustCache?: boolean }} [opts]
 * @returns {object}
 */
export function getAgentrcDefaults(opts = {}) {
  if (!opts.bustCache && _cache) return _cache;
  const raw = fs.readFileSync(FULL_AGENTRC_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  delete parsed.$schema;
  _cache = deepFreeze(parsed);
  return _cache;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

/**
 * Arrays are leaves.
 *
 * @param {object} defaults
 * @returns {Generator<[string, unknown]>}
 */
export function* iterDefaultLeaves(defaults, prefix = '') {
  if (defaults === null || typeof defaults !== 'object') return;
  if (Array.isArray(defaults)) {
    if (prefix) yield [prefix, defaults];
    return;
  }
  for (const [key, value] of Object.entries(defaults)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      yield* iterDefaultLeaves(value, dotted);
    } else {
      yield [dotted, value];
    }
  }
}

/**
 * @param {object|null|undefined} obj
 * @param {string} dottedPath
 */
export function lookupPath(obj, dottedPath) {
  if (obj == null || typeof obj !== 'object') {
    return { present: false, value: undefined };
  }
  const parts = dottedPath.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (
      cursor === null ||
      typeof cursor !== 'object' ||
      !Object.hasOwn(cursor, parts[i])
    ) {
      return { present: false, value: undefined };
    }
    cursor = cursor[parts[i]];
  }
  return { present: true, value: cursor };
}
