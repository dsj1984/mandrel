// Component resolver and row grouper: slice a baseline into named glob
// buckets for per-component floors. The `*` component is the whole-repo
// rollup and matches every row; overlap between components is allowed.

import picomatch from 'picomatch';

/**
 * Compiled matchers keyed by glob: `groupRows` runs over tens of thousands of
 * rows, and re-parsing each glob per row dominated its cost.
 *
 * @type {Map<string, (path: string) => boolean>}
 */
const GLOB_MATCHER_CACHE = new Map();

/**
 * @param {string} glob
 * @returns {(path: string) => boolean}
 */
function matcherFor(glob) {
  let matcher = GLOB_MATCHER_CACHE.get(glob);
  if (!matcher) {
    matcher = picomatch(glob, { dot: true });
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
 * @param {unknown} row
 * @param {string}  field
 * @returns {string|null} The row's `/`-normalized key, or null when absent.
 */
function rowKey(row, field) {
  const key = row && typeof row === 'object' ? row[field] : undefined;
  if (typeof key !== 'string' || key.length === 0) return null;
  return key.replace(/\\/g, '/');
}

/**
 * @param {string}  normalized
 * @param {unknown} globs
 * @returns {boolean} `true` iff any non-empty string glob matches.
 */
function matchesAnyGlob(normalized, globs) {
  if (!Array.isArray(globs)) return false;
  return globs.some(
    (glob) =>
      typeof glob === 'string' &&
      glob.length > 0 &&
      matcherFor(glob)(normalized),
  );
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
  const entries = Object.entries(safeComponents);

  const buckets = {};
  for (const [name] of entries) {
    buckets[name] = [];
  }

  for (const row of safeRows) {
    const normalized = rowKey(row, field);
    for (const [name, globs] of entries) {
      if (name === '*' || (normalized && matchesAnyGlob(normalized, globs))) {
        buckets[name].push(row);
      }
    }
  }

  return buckets;
}
