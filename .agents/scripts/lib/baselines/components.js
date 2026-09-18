// Component resolver and row grouper: slice a baseline into named glob
// buckets for per-component floors. The `*` component is the whole-repo
// rollup and matches every row; overlap between components is allowed.

import { Minimatch } from 'minimatch';

const DEFAULT_COMPONENTS = Object.freeze({ '*': Object.freeze(['**']) });

/**
 * Compiled matchers keyed by glob: `groupRows` runs over tens of thousands of
 * rows, and re-parsing each glob per row dominated its cost.
 *
 * @type {Map<string, import('minimatch').Minimatch>}
 */
const GLOB_MATCHER_CACHE = new Map();

/**
 * @param {string} glob
 * @returns {import('minimatch').Minimatch}
 */
function matcherFor(glob) {
  let matcher = GLOB_MATCHER_CACHE.get(glob);
  if (!matcher) {
    matcher = new Minimatch(glob, { dot: true });
    GLOB_MATCHER_CACHE.set(glob, matcher);
  }
  return matcher;
}

/**
 * Absent or empty `components` → `{ '*': ['**'] }`; non-array glob lists
 * coerce to `[]`.
 *
 * @param {object} [gateConfig]
 * @returns {Record<string, string[]>} Components map, never null.
 */
export function resolveComponents(gateConfig) {
  if (!gateConfig || typeof gateConfig !== 'object') {
    return cloneDefault();
  }
  const raw = gateConfig.components;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return cloneDefault();
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    return cloneDefault();
  }
  const out = {};
  for (const [name, globs] of entries) {
    out[name] = Array.isArray(globs) ? globs.slice() : [];
  }
  return out;
}

function cloneDefault() {
  return { '*': ['**'] };
}

/**
 * A row without a string `keyField` lands only in `*`.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, string[]>}       components
 * @param {string}                         [keyField='path']
 *   `route` for lighthouse, `bundle` for bundle-size.
 * @returns {Record<string, Array<Record<string, unknown>>>}
 *   Map of component name → matching rows, in input order.
 */
export function groupRows(rows, components, keyField = 'path') {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeComponents =
    components && typeof components === 'object' ? components : cloneDefault();
  const field =
    typeof keyField === 'string' && keyField.length > 0 ? keyField : 'path';

  const buckets = {};
  for (const name of Object.keys(safeComponents)) {
    buckets[name] = [];
  }

  for (const row of safeRows) {
    for (const [name, globs] of Object.entries(safeComponents)) {
      if (name === '*') {
        buckets[name].push(row);
        continue;
      }
      const key = row && typeof row === 'object' ? row[field] : undefined;
      if (typeof key !== 'string' || key.length === 0) continue;
      const normalized = key.replace(/\\/g, '/');
      const list = Array.isArray(globs) ? globs : [];
      for (const glob of list) {
        if (typeof glob !== 'string' || glob.length === 0) continue;
        if (matcherFor(glob).match(normalized)) {
          buckets[name].push(row);
          break;
        }
      }
    }
  }

  return buckets;
}

export const _internals = Object.freeze({ DEFAULT_COMPONENTS });
