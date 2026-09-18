/**
 * Pure 3-way merge of baseline envelopes by row identity. A line-based git
 * merge conflicts on disjoint rows that sit adjacent in sort order, and can
 * splice both sides into a row set no scorer produced.
 *
 * Per identity the side that differs from base wins; both differing is a
 * conflict; absence is a value. Identity comes from the kind's `rowIdentity`,
 * never `keyField`. No I/O: the driver validates the result.
 *
 * @module lib/baselines/merge-envelopes
 */

import { deepEqual } from '../json-utils.js';
import { KNOWN_KINDS } from './envelope.js';
import { getKindModule } from './kernel.js';

/** Merged by identity, not as a stamp. */
const ROW_KEY = 'rows';

/**
 * Kind from `$schema`, or `null` for anything not a known per-kind envelope.
 *
 * @param {unknown} envelope
 * @returns {string|null}
 */
export function kindFromEnvelope(envelope) {
  const ref = envelope?.$schema;
  if (typeof ref !== 'string') return null;
  const base = ref.split('/').pop();
  for (const kind of KNOWN_KINDS) {
    if (base === `${kind}.schema.json`) return kind;
  }
  return null;
}

/**
 * `undefined` = absent on that side, so deletion is just another value.
 *
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {{ conflict: boolean, value?: unknown }}
 */
function choose(base, ours, theirs) {
  if (deepEqual(ours, theirs)) return { conflict: false, value: ours };
  if (deepEqual(ours, base)) return { conflict: false, value: theirs };
  if (deepEqual(theirs, base)) return { conflict: false, value: ours };
  return { conflict: true };
}

/**
 * A duplicate identity on one side throws; last-write-wins would drop a row.
 *
 * @param {Array<object>} rows
 * @param {(row: object) => string} rowIdentity
 * @param {string} side
 * @returns {Map<string, object>}
 */
function indexRows(rows, rowIdentity, side) {
  const out = new Map();
  for (const [idx, row] of (rows ?? []).entries()) {
    if (!row || typeof row !== 'object') {
      throw new TypeError(
        `mergeEnvelopes: ${side} row at index ${idx} is not an object`,
      );
    }
    const id = rowIdentity(row);
    if (out.has(id)) {
      throw new Error(
        `mergeEnvelopes: ${side} carries two rows with identity "${id}" — the baseline violates the identity contract and cannot be merged safely`,
      );
    }
    out.set(id, row);
  }
  return out;
}

/**
 * 3-way merge of envelope stamps; a double bump to different values is a
 * real conflict (two scorers).
 *
 * @param {object} base
 * @param {object} ours
 * @param {object} theirs
 * @returns {{ merged: object, conflicts: Array<object> }}
 */
function mergeStamps(base, ours, theirs) {
  const keys = new Set(
    [...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)].filter(
      (k) => k !== ROW_KEY,
    ),
  );
  const merged = {};
  const conflicts = [];
  for (const key of keys) {
    const pick = choose(base[key], ours[key], theirs[key]);
    if (pick.conflict) {
      conflicts.push({
        scope: 'envelope',
        identity: key,
        base: base[key],
        ours: ours[key],
        theirs: theirs[key],
      });
      merged[key] = ours[key];
      continue;
    }
    if (pick.value !== undefined) merged[key] = pick.value;
  }
  return { merged, conflicts };
}

/**
 * @param {{
 *   baseEnv: object,
 *   ours: object|null|undefined,
 *   theirs: object|null|undefined,
 *   rowIdentity: (row: object) => string,
 * }} params
 * @returns {{ rows: Array<object>, conflicts: Array<object> }}
 */
function mergeRowSets({ baseEnv, ours, theirs, rowIdentity }) {
  const baseRows = indexRows(baseEnv?.rows, rowIdentity, 'base');
  const ourRows = indexRows(ours?.rows, rowIdentity, 'ours');
  const theirRows = indexRows(theirs?.rows, rowIdentity, 'theirs');

  const conflicts = [];
  const rows = [];
  const identities = new Set([
    ...ourRows.keys(),
    ...theirRows.keys(),
    ...baseRows.keys(),
  ]);
  for (const id of identities) {
    const b = baseRows.get(id);
    const o = ourRows.get(id);
    const t = theirRows.get(id);
    const pick = choose(b, o, t);
    if (pick.conflict) {
      conflicts.push({
        scope: 'row',
        identity: id,
        base: b,
        ours: o,
        theirs: t,
      });
      // Keep ours so the row set stays well-formed; the driver adds markers.
      if (o !== undefined) rows.push(o);
      else if (t !== undefined) rows.push(t);
      continue;
    }
    if (pick.value !== undefined) rows.push(pick.value);
  }
  return { rows, conflicts };
}

/**
 * `base` is `null` when the file was added on both sides.
 *
 * @param {{
 *   base: object|null,
 *   ours: object,
 *   theirs: object,
 *   kind?: string,
 * }} params
 * @returns {{
 *   kind: string,
 *   envelope: object,
 *   conflicts: Array<{scope: string, identity: string, base?: unknown, ours?: unknown, theirs?: unknown}>,
 * }}
 */
export function mergeEnvelopes({ base, ours, theirs, kind } = {}) {
  const resolvedKind =
    kind ?? kindFromEnvelope(ours) ?? kindFromEnvelope(theirs);
  if (!resolvedKind) {
    throw new Error(
      'mergeEnvelopes: could not resolve a known baseline kind from the envelopes',
    );
  }
  const mod = getKindModule(resolvedKind);
  const baseEnv = base && typeof base === 'object' ? base : { rows: [] };

  const { rows, conflicts } = mergeRowSets({
    baseEnv,
    ours,
    theirs,
    rowIdentity: mod.rowIdentity,
  });

  const sortedRows = mod.sortRows(rows);
  const { merged: stamps, conflicts: stampConflicts } = mergeStamps(
    baseEnv,
    ours ?? {},
    theirs ?? {},
  );

  const envelope = { ...stamps, rows: sortedRows };

  return {
    kind: resolvedKind,
    envelope,
    conflicts: [...stampConflicts, ...conflicts],
  };
}

/**
 * Declared key order, then leftovers (never dropped), so a clean merge stays
 * byte-identical to the generator's insertion-ordered output.
 *
 * @param {object} obj
 * @param {string[]} order
 * @returns {object}
 */
function orderKeys(obj, order) {
  const out = {};
  for (const key of order) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  for (const key of Object.keys(obj)) {
    if (out[key] === undefined && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/**
 * Row-set baselines that are not per-kind envelopes. `keyOrder` mirrors each
 * generator.
 */
const PLAIN_BASELINE_KINDS = Object.freeze({
  cyclomatic: Object.freeze({
    rowIdentity: (row) => String(row?.file ?? ''),
    sortRows: (rows) =>
      [...rows].sort((a, b) => String(a.file).localeCompare(String(b.file))),
    keyOrder: ['$schema', 'ceiling', 'rows'],
  }),
  'dead-exports': Object.freeze({
    rowIdentity: (row) => `${row?.file ?? ''}::${row?.symbol ?? ''}`,
    sortRows: (rows) =>
      [...rows].sort(
        (a, b) =>
          String(a.file).localeCompare(String(b.file)) ||
          String(a.symbol).localeCompare(String(b.symbol)),
      ),
    keyOrder: ['$schema', 'kernelVersion', 'mode', 'rows'],
  }),
});

/** `dead-exports.json` and `dead-exports-production.json` share a `$schema`. */
const PLAIN_SCHEMA_KINDS = Object.freeze({
  'cyclomatic.schema.json': 'cyclomatic',
  'dead-exports.schema.json': 'dead-exports',
});

/**
 * The production dead-export pass reports as its own kind so the remedy
 * names the right command.
 *
 * @param {unknown} envelope
 * @returns {string|null}
 */
export function plainKindFromEnvelope(envelope) {
  const ref = envelope?.$schema;
  if (typeof ref !== 'string') return null;
  const kind = PLAIN_SCHEMA_KINDS[ref.split('/').pop()] ?? null;
  if (kind === 'dead-exports' && envelope?.mode === 'production') {
    return 'dead-exports-production';
  }
  return kind;
}

function plainSpec(kind) {
  return PLAIN_BASELINE_KINDS[
    kind === 'dead-exports-production' ? 'dead-exports' : kind
  ];
}

/**
 * Same contract as {@link mergeEnvelopes}, without the kernel protocol.
 *
 * @param {{ base: object|null, ours: object, theirs: object, kind?: string }} params
 * @returns {{ kind: string, envelope: object, conflicts: Array<object> }}
 */
export function mergePlainBaseline({ base, ours, theirs, kind } = {}) {
  const resolvedKind =
    kind ?? plainKindFromEnvelope(ours) ?? plainKindFromEnvelope(theirs);
  const spec = resolvedKind ? plainSpec(resolvedKind) : undefined;
  if (!spec) {
    throw new Error(
      'mergePlainBaseline: could not resolve a known plain baseline kind from the envelopes',
    );
  }
  const baseEnv = base && typeof base === 'object' ? base : { rows: [] };
  const { rows, conflicts } = mergeRowSets({
    baseEnv,
    ours,
    theirs,
    rowIdentity: spec.rowIdentity,
  });
  const sortedRows = spec.sortRows(rows);
  const { merged: stamps, conflicts: stampConflicts } = mergeStamps(
    baseEnv,
    ours ?? {},
    theirs ?? {},
  );
  const envelope = orderKeys({ ...stamps, rows: sortedRows }, spec.keyOrder);
  return {
    kind: resolvedKind,
    envelope,
    conflicts: [...stampConflicts, ...conflicts],
  };
}

const REGENERATE_COMMANDS = Object.freeze({
  'dead-exports': 'npm run dead-exports:update',
  'dead-exports-production': 'npm run dead-exports:update',
  cyclomatic: 'npm run cyclomatic:update',
});

/**
 * After a conflicted merge, hand-resolved rows describe a tree nobody scored,
 * so the driver must name the regeneration command.
 *
 * @param {string} kind
 * @returns {string}
 */
export function baselineRegenerateRemedy(kind) {
  return REGENERATE_COMMANDS[kind] ?? `npm run ${kind}:update`;
}

/**
 * Wrap each conflicted stamp in git conflict markers so the unmerged file
 * shows which stamp disagreed. Unconflicted lines stay byte-identical.
 *
 * @param {string} text Canonical serialization of the merged envelope.
 * @param {Array<{ identity: string, ours?: unknown, theirs?: unknown }>} conflicts
 * @returns {string}
 */
export function renderStampConflict(text, conflicts) {
  let out = text;
  for (const conflict of conflicts) {
    const key = conflict?.identity;
    if (typeof key !== 'string' || key.length === 0) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^([ \\t]*)"${escaped}"(: .*)$`, 'm');
    const match = pattern.exec(out);
    if (!match) continue;
    const [line, indent, tail] = match;
    const comma = tail.endsWith(',') ? ',' : '';
    const render = (value) =>
      value === undefined
        ? ''
        : `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}\n`;
    out = out.replace(
      line,
      `<<<<<<< ours\n${render(conflict.ours)}=======\n${render(conflict.theirs)}>>>>>>> theirs`,
    );
  }
  return out;
}
