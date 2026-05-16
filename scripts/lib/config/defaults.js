/**
 * `getAgentrcDefaults()` — single source of `.agentrc.json` defaults.
 *
 * `.agents/full-agentrc.json` is the authoritative editor-reference
 * inventory of every field the framework supports plus its default
 * value. Runtime accessors under `lib/config/*.js` (`COMMANDS_DEFAULTS`,
 * `BRANCH_PROTECTION_DEFAULTS`, gate defaults, etc.) layer the same
 * values onto whatever the project config carries; a parity test
 * (tests/config/full-agentrc-runtime-parity.test.js) keeps the two in
 * lockstep.
 *
 * Story #1995: the `/agents-update` sync helper consults this module
 * (not the template directly) to decide whether a project value is
 * "just the default" and therefore safe to omit from `.agentrc.json`.
 *
 * Identity placeholders (`[OWNER]`, `[REPO]`, `@[USERNAME]`) carry no
 * meaningful default — the operator must set them. They survive in
 * the returned object so the consumer can see the expected shape, but
 * the sync helper treats them as "no usable default" via
 * `IDENTITY_PLACEHOLDER_PATHS`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .agents/scripts/lib/config/ → .agents/
const AGENTS_ROOT = path.resolve(__dirname, '../../..');
export const FULL_AGENTRC_PATH = path.join(AGENTS_ROOT, 'full-agentrc.json');

/**
 * Dotted paths whose template value is a human placeholder
 * (`[OWNER]`, `[REPO]`, `@[USERNAME]`). The sync helper treats these
 * as "no default" — they are never auto-filled, and a project value
 * present at one of these paths is never flagged as redundant.
 */
export const IDENTITY_PLACEHOLDER_PATHS = Object.freeze([
  'github.owner',
  'github.repo',
  'github.operatorHandle',
]);

let _cache = null;

/**
 * Parse `.agents/full-agentrc.json` and return a deep-frozen snapshot.
 *
 * @param {{ bustCache?: boolean }} [opts]
 * @returns {object}
 */
export function getAgentrcDefaults(opts = {}) {
  if (!opts.bustCache && _cache) return _cache;
  const raw = fs.readFileSync(FULL_AGENTRC_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Strip the `$schema` pointer — it's editor metadata, not a default.
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
 * Walk a default object and yield `[dottedPath, value]` for every
 * scalar / array leaf. Objects are descended into, not yielded.
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
 * Look up a dotted path inside an arbitrary nested object.
 * Returns `{ present: boolean, value: unknown }`.
 *
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

/**
 * Deep structural equality for JSON-shaped values (no Dates / Regexes /
 * functions). Used to decide whether a project value equals the
 * template default.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
