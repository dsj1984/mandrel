/**
 * merge-envelopes.js — pure 3-way merge of baseline envelopes by row
 * identity (Story #5215).
 *
 * ## Why this exists
 *
 * Every baseline write stamps `generatedAt`, and the stamp sits on line 4 of
 * every envelope. Two branches that each refresh a baseline therefore always
 * differ on that line, even when they moved completely disjoint rows — so
 * git's LINE-based merge has to reconcile it. Whether it can separate that
 * hunk from the moved rows is an accident of proximity, and both outcomes
 * are bad:
 *
 *   - it cannot → a conflict on work that never actually overlapped;
 *   - it can → it splices both sides' row lines together into a row set
 *     NEITHER side ever scored. That silent one is the worse failure: the
 *     ratchet then guards a number no scorer produced.
 *
 * A baseline is not a text file. It is a set of rows keyed by identity plus
 * a rollup DERIVED from those rows, so merging it as text is a category
 * error. This module merges it as what it is.
 *
 * ## Contract
 *
 * Pure: no filesystem, no process, no clock. `assertEnvelope` is deliberately
 * NOT called here (it compiles schemas off disk on first use) — the driver
 * validates what this returns.
 *
 * Per row identity, the standard 3-way rule: the side that differs from base
 * wins; when both sides differ from base AND from each other, that identity
 * is a conflict. Absence is a value, so a row deleted on one side and
 * untouched on the other merges to deleted.
 *
 * Two invariants are load-bearing:
 *
 *   1. **The rollup is recomputed, never merged.** Merging two rollups is
 *      the same splice hazard compressed into a single number, and unlike a
 *      spliced row set it leaves no evidence. It is always derived from the
 *      merged rows via the kind's own `rollup()`.
 *   2. **Identity comes from the kind module** (`rowIdentity`), never from
 *      `keyField`. CRAP groups by file and identifies by method; keying on
 *      `keyField` would drop every method in a file but one.
 *
 * @module lib/baselines/merge-envelopes
 */

import { deepEqual } from '../json-utils.js';
import { KNOWN_KINDS } from './envelope.js';
import { getKindModule } from './kernel.js';

/**
 * Envelope keys that are NOT merged side-by-side: `rows` merge by identity,
 * `rollup` is recomputed from them, and `generatedAt` resolves to the later
 * of the two stamps rather than conflicting (it is metadata about when a
 * scorer ran, not a scored value — treating it as content is the whole bug).
 */
const DERIVED_KEYS = Object.freeze(['rows', 'rollup', 'generatedAt']);

/**
 * Identify an envelope's kind from its `$schema` reference.
 *
 * Derived from `KNOWN_KINDS` rather than pattern-matched, so a file that is
 * not a known per-kind envelope answers `null` — which is how the driver
 * knows to hand it back to git's text merge instead of guessing at a shape
 * it does not understand. `baselines/*.json` also matches several
 * non-envelope baselines (arch-cycles, cyclomatic, dead-exports, …).
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
 * The 3-way choice for one value. `undefined` means "absent on this side",
 * which makes deletion just another value rather than a special case.
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
 * Index rows by the kind's `rowIdentity`. A duplicate identity within one
 * side is fatal rather than last-write-wins: it means the incoming file
 * already violates the identity contract, and merging it would silently
 * drop a row.
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
 * Resolve `generatedAt` to the later of the two sides. A stamp is metadata,
 * so it never conflicts: the merged file describes a tree scored as recently
 * as the newer of its inputs.
 *
 * @param {string|undefined} ours
 * @param {string|undefined} theirs
 * @returns {string|undefined}
 */
function laterStamp(ours, theirs) {
  if (typeof ours !== 'string') return theirs;
  if (typeof theirs !== 'string') return ours;
  const a = Date.parse(ours);
  const b = Date.parse(theirs);
  if (Number.isNaN(a) || Number.isNaN(b)) return ours > theirs ? ours : theirs;
  return a >= b ? ours : theirs;
}

/**
 * Merge the envelope-level stamps (`$schema`, `kernelVersion`, and per-kind
 * extras like `scoringSemantics`) by the same 3-way rule as rows. A double
 * bump to different values is a genuine conflict — two branches disagreeing
 * about which scorer produced the file.
 *
 * @param {object} base
 * @param {object} ours
 * @param {object} theirs
 * @returns {{ merged: object, conflicts: Array<object> }}
 */
function mergeStamps(base, ours, theirs) {
  const keys = new Set(
    [...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)].filter(
      (k) => !DERIVED_KEYS.includes(k),
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
 * The row half of a 3-way merge, shared by the envelope path and the plain
 * row-baseline path below. Both merge a set of rows keyed by identity against
 * a common ancestor; they differ only in where the identity comes from and in
 * what they assemble around the result.
 *
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
      // Keep the ours-side value so the row set stays well-formed; the
      // driver renders the conflict markers around it from this record.
      if (o !== undefined) rows.push(o);
      else if (t !== undefined) rows.push(t);
      continue;
    }
    if (pick.value !== undefined) rows.push(pick.value);
  }
  return { rows, conflicts };
}

/**
 * 3-way merge two baseline envelopes against their common ancestor.
 *
 * @param {{
 *   base: object|null,
 *   ours: object,
 *   theirs: object,
 *   kind?: string,
 *   components?: Array<object>,
 * }} params
 *   - `base` — the merge ancestor; `null` (or a rowless object) when the
 *     file was added on both sides.
 *   - `components` — passed straight to the kind's `rollup()`. Defaults to
 *     `[]`, which is what `refreshBaseline` effectively uses, so a merged
 *     envelope carries the same `{'*': …}` rollup shape a refresh writes.
 * @returns {{
 *   kind: string,
 *   envelope: object,
 *   conflicts: Array<{scope: string, identity: string, base?: unknown, ours?: unknown, theirs?: unknown}>,
 * }}
 */
export function mergeEnvelopes({
  base,
  ours,
  theirs,
  kind,
  components = [],
} = {}) {
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

  const envelope = {
    ...stamps,
    generatedAt: laterStamp(ours?.generatedAt, theirs?.generatedAt),
    rollup: mod.rollup(sortedRows, components),
    rows: sortedRows,
  };

  return {
    kind: resolvedKind,
    envelope,
    conflicts: [...stampConflicts, ...conflicts],
  };
}

/**
 * Emit the object's keys in a declared order, then anything left over.
 *
 * The invariant this serves is "a clean driver merge stays byte-identical to
 * a regeneration": both generators below write
 * `JSON.stringify(envelope, null, 2)`, which preserves insertion order, so a
 * merged file whose keys are in a different order than the generator's is a
 * spurious diff on every subsequent refresh. Unknown keys are appended rather
 * than dropped — a merge is never the place to lose a field.
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
 * Derive `cyclomatic`'s rollup from its merged rows — the same arithmetic
 * `cyclomatic-ceiling.js#buildCyclomaticEnvelope` applies at generation time.
 *
 * Deriving rather than merging matters more here than anywhere: the rollup is
 * three counts over the whole row set, so two branches that each add one row
 * BOTH write `filesAboveCeiling: n + 1`. A 3-way merge sees two identical
 * values and resolves them clean — to a number that is wrong by one, with no
 * conflict and no evidence. That is the silent splice this module exists to
 * refuse, compressed into a single field.
 *
 * @param {Array<object>} rows
 * @returns {{ '*': { filesAboveCeiling: number, methodsAboveCeiling: number, maxCyclomatic: number } }}
 */
function cyclomaticRollup(rows) {
  let methods = 0;
  let max = 0;
  for (const row of rows) {
    methods += Number(row?.methodsAboveCeiling ?? 0);
    const rowMax = Number(row?.maxCyclomatic ?? 0);
    if (rowMax > max) max = rowMax;
  }
  return {
    '*': {
      filesAboveCeiling: rows.length,
      methodsAboveCeiling: methods,
      maxCyclomatic: max,
    },
  };
}

/**
 * Baselines that are row sets but NOT per-kind envelopes (Story #5277).
 *
 * `baselines/*.json` matches more than the eight kernel kinds. Three of the
 * extras are row sets with a real identity, and before this registry the
 * driver handed all three straight back to `git merge-file` — so `.gitattributes`
 * declared them driver-merged while they were still text-merged, with exactly
 * the two failure modes the driver replaces. `dead-exports*.json` in particular
 * is a long, uniform list of two-key objects: the shape git splices most
 * happily and least visibly.
 *
 * `rollup: null` is a genuine absence, not an omission — the dead-export
 * generator writes no rollup key at all, so deriving one would invent a field
 * the checker never reads and the generator would strip on the next refresh.
 * `cyclomatic` does carry one, and derives it (see {@link cyclomaticRollup}).
 *
 * `keyOrder` mirrors each generator's own insertion order; see
 * {@link orderKeys}.
 */
const PLAIN_BASELINE_KINDS = Object.freeze({
  cyclomatic: Object.freeze({
    rowIdentity: (row) => String(row?.file ?? ''),
    sortRows: (rows) =>
      [...rows].sort((a, b) => String(a.file).localeCompare(String(b.file))),
    rollup: cyclomaticRollup,
    keyOrder: ['$schema', 'generatedAt', 'ceiling', 'rollup', 'rows'],
  }),
  'dead-exports': Object.freeze({
    rowIdentity: (row) => `${row?.file ?? ''}::${row?.symbol ?? ''}`,
    sortRows: (rows) =>
      [...rows].sort(
        (a, b) =>
          String(a.file).localeCompare(String(b.file)) ||
          String(a.symbol).localeCompare(String(b.symbol)),
      ),
    rollup: null,
    keyOrder: ['$schema', 'kernelVersion', 'generatedAt', 'mode', 'rows'],
  }),
});

/** `dead-exports.json` and `dead-exports-production.json` share a `$schema`. */
const PLAIN_SCHEMA_KINDS = Object.freeze({
  'cyclomatic.schema.json': 'cyclomatic',
  'dead-exports.schema.json': 'dead-exports',
});

/**
 * Identify a plain row baseline from its `$schema`, or `null`.
 *
 * The production dead-export pass reports as its own kind so the regenerate
 * remedy can name the right command, even though the two share a schema and
 * merge identically.
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

/** The merge spec for a plain kind, collapsing the two dead-export passes. */
function plainSpec(kind) {
  return PLAIN_BASELINE_KINDS[
    kind === 'dead-exports-production' ? 'dead-exports' : kind
  ];
}

/**
 * 3-way merge a plain row baseline by row identity.
 *
 * Same contract as {@link mergeEnvelopes} — rows merge by identity, stamps
 * merge 3-way, `generatedAt` resolves to the later of the two — minus the
 * kernel protocol these kinds do not participate in.
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
  const envelope = orderKeys(
    {
      ...stamps,
      generatedAt: laterStamp(ours?.generatedAt, theirs?.generatedAt),
      ...(spec.rollup ? { rollup: spec.rollup(sortedRows) } : {}),
      rows: sortedRows,
    },
    spec.keyOrder,
  );
  return {
    kind: resolvedKind,
    envelope,
    conflicts: [...stampConflicts, ...conflicts],
  };
}

/** Per-kind regeneration commands; anything unlisted follows the convention. */
const REGENERATE_COMMANDS = Object.freeze({
  'dead-exports': 'npm run dead-exports:update',
  'dead-exports-production': 'npm run dead-exports:update',
  cyclomatic: 'npm run cyclomatic:update',
});

/**
 * The command that re-derives a baseline from the tree.
 *
 * A conflicted merge leaves the rollup describing a row set nobody scored:
 * the driver derives it from rows that still carry conflict markers around
 * them, and no hand-resolution of those markers updates it. Resolving the
 * rows is therefore only half the job, and the half operators skip — so the
 * driver says the other half out loud rather than leaving a plausible-looking
 * number behind.
 *
 * @param {string} kind
 * @returns {string}
 */
export function baselineRegenerateRemedy(kind) {
  return REGENERATE_COMMANDS[kind] ?? `npm run ${kind}:update`;
}

/**
 * Wrap each conflicted envelope-level stamp in git conflict markers.
 *
 * Envelope conflicts used to be reported on stderr alone, and the file was
 * left holding the ours-side value with no marker in it. Git reads the
 * driver's non-zero exit as "conflicted" and leaves the path unmerged, so the
 * operator opens a file that looks cleanly merged and has to reconstruct from
 * a scrollback line which stamp disagreed. A `kernelVersion` double-bump is
 * exactly the case where the two sides mean different scorers and picking one
 * silently is wrong.
 *
 * Operates on the canonical text the merged projection already produced, so
 * every unconflicted line stays byte-identical to a clean merge.
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
