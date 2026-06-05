// .agents/scripts/lib/baselines/components.js
//
// Story #1892 / Task #1902 — shared component resolver and row grouper.
//
// The "components" model lets a gate slice a baseline into named buckets
// (e.g. `app`, `worker`, `infra`) so per-component floors and tolerances
// can be evaluated independently. The shape is:
//
//   components: { [name: string]: string[] }   // map of name → glob list
//
// The canonical default — used when a gate omits `components` from its
// agentrc config — is `{ '*': ['**'] }`, meaning "one bucket called `*`
// matching every row". This keeps backwards compatibility with the
// pre-components rollup contract: a baseline that ships only `rollup['*']`
// continues to work without operator intervention.
//
// Globs are matched with minimatch. Overlap is allowed by design — a row
// matched by two components is reported under both. Components keyed by
// the literal `*` are treated as the whole-repo rollup and always match
// every row regardless of declared globs.

import { minimatch } from 'minimatch';

/** The default components map, used when a gate omits `components`. */
const DEFAULT_COMPONENTS = Object.freeze({ '*': Object.freeze(['**']) });

/**
 * Resolve the components map for a single gate config.
 *
 * Behaviour:
 *   - If the gate config has no `components` key (or it's not a plain
 *     object), return the default `{ '*': ['**'] }`.
 *   - If `components` is present but contains no entries, also return the
 *     default — a writer that emitted an empty `components: {}` is
 *     functionally equivalent to "no components declared".
 *   - Otherwise pass the operator-declared map through unchanged. Each
 *     value MUST be an array of glob strings; non-array values are
 *     coerced to an empty array so the grouper's caller can't crash on
 *     malformed input.
 *
 * @param {object} [gateConfig]  A single gate config slice, e.g.
 *   `delivery.quality.gates.coverage`.
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
 * Group rows by component using the resolved components map.
 *
 * Matching rules:
 *   - The component literally named `*` is the whole-repo bucket and
 *     captures every row regardless of declared globs.
 *   - For every other component, the row's `keyField` value is matched
 *     against each declared glob with minimatch (using `dot: true` so
 *     leading-dot paths participate). A row joins the bucket on first
 *     match — but a row CAN appear in multiple buckets because we evaluate
 *     every component (overlap is allowed).
 *   - Rows whose `keyField` is not a non-empty string never match
 *     any non-`*` bucket; they still land in `*`.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, string[]>}       components
 * @param {string}                         [keyField='path']
 *   The row field to feed into the matcher. Defaults to `path` (used by
 *   lint / coverage / crap / maintainability / mutation). Use `'route'`
 *   for lighthouse and `'bundle'` for bundle-size.
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
        if (minimatch(normalized, glob, { dot: true })) {
          buckets[name].push(row);
          break;
        }
      }
    }
  }

  return buckets;
}

export const _internals = Object.freeze({ DEFAULT_COMPONENTS });
