/**
 * lib/spec/state.js — state-file shape helpers.
 *
 * Owns the canonical content-hashing and the
 * `<epic-id>.state.json` mapping projection used by the reconciler
 * (Wave 1) to decide what changed between two reconciliations.
 *
 * Tech Spec #1483 §"`.agents/epics/<epic-id>.state.json`" pins the
 * file shape:
 *
 *   ```json
 *   {
 *     "epicId": 1182,
 *     "lastReconciledAt": "2026-05-12T12:34:56Z",
 *     "mapping": {
 *       "<slug>": {
 *         "issueNumber": 1190,
 *         "contentHash": "sha256:...",
 *         "lastObservedAgentState": "agent::ready"
 *       }
 *     }
 *   }
 *   ```
 *
 * The hashing contract:
 *
 *   • `canonicalStringify(value)` produces a deterministic string for
 *     `value` by recursively sorting object keys. This guarantees that
 *     two objects with the same logical content but different in-memory
 *     key order hash to the same digest, which is the foundation of the
 *     reconciler's "did this entry change?" check.
 *   • `hashSpecEntry(entry)` returns `sha256:<hex>` over the
 *     canonical-stringified entry. The `sha256:` prefix makes the hash
 *     algorithm self-describing in the on-disk state file (so future
 *     migrations can multiplex algorithms without a schema bump).
 *
 * The mapping-projection contract (`projectMapping`):
 *
 *   • Given a `spec` and a `prior` state, project a fresh `mapping`
 *     entry per slug found in the spec, preserving the prior
 *     `issueNumber` + `lastObservedAgentState` where present and
 *     re-hashing the entry's structural content. Slugs absent from the
 *     spec are dropped (a spec→state projection — execution-drift
 *     handling lives in the reconciler, not here).
 *
 *   • The projection is pure: it does not read or write disk, and it
 *     does not call `Date.now()`. Callers compose it with
 *     `writeState(epicId, { ...projected, lastReconciledAt: now() })`.
 *
 * The whole module is import-light and side-effect-free so the
 * reconciler diff path can unit-test it in isolation.
 */

import { createHash } from 'node:crypto';

/**
 * Recursively sort object keys so two equivalent objects produce the
 * same canonical serialisation. Arrays preserve their order (array
 * order is semantically meaningful in the spec — feature order, task
 * order, dependsOn order).
 *
 * Exported because the loader's `sortKeysDeep` lives in `loader.js` and
 * we want a single canonicalisation entry point for the hash path. Both
 * implementations agree on object-key sort; only this one is the
 * documented hashing-input contract.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalise(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stringify `value` deterministically. Two objects with the same
 * logical content always produce the same string regardless of how
 * their keys are inserted in memory.
 *
 * Used as the hashing input for `hashSpecEntry`; also exported so the
 * reconciler can log diffs in canonical form.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return JSON.stringify(canonicalise(value));
}

/**
 * SHA-256 over `input`, hex-encoded, prefixed with `sha256:` so the
 * algorithm is self-describing in the state file.
 *
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * Hash a spec entry (a Story object) deterministically.
 * The entry is canonicalised (recursive key-sort), serialised, and
 * sha256'd. Equivalent entries (any key order, equivalent nested order
 * for the object-valued fields) hash to the same digest.
 *
 * The reconciler stores the resulting hash in `mapping[slug].contentHash`
 * so the next reconciliation can decide whether a `Update` operation is
 * needed without comparing the entries property-by-property.
 *
 * @param {object} entry
 * @returns {string} `sha256:<hex>`
 */
export function hashSpecEntry(entry) {
  return sha256Hex(canonicalStringify(entry));
}

/**
 * Iterate every slug-bearing entity in the spec. Yields tuples of
 * `[slug, entry]` where `entry` is the raw Story object as authored in
 * the spec. Order follows `spec.stories[]` — the natural read order,
 * useful for deterministic mapping iteration.
 *
 * Exported for tests; the reconciler diff path uses `projectMapping`
 * (below) rather than this generator directly.
 *
 * @param {object} spec
 * @returns {Generator<[string, object]>}
 */
export function* iterSpecEntries(spec) {
  if (!spec || !Array.isArray(spec.stories)) return;
  for (const story of spec.stories) {
    if (story?.slug) yield [story.slug, story];
  }
}

/**
 * Project a fresh `mapping` over `spec`, carrying forward whatever the
 * `prior` state already knows for each slug (`issueNumber` and
 * `lastObservedAgentState`) and re-hashing the entry's structural
 * content via `hashSpecEntry`.
 *
 * Pure function — does not read or write disk, does not touch
 * `Date.now()`. Callers fold the result into `writeState` along with a
 * caller-supplied `lastReconciledAt`.
 *
 * Entries newly added in the spec start with `issueNumber: null` and
 * `lastObservedAgentState: null`. Entries dropped from the spec are
 * absent from the returned mapping (the reconciler decides separately
 * whether to retain a tombstone — that lives in Wave 1's diff layer).
 *
 * @param {object} spec
 * @param {{mapping?: Record<string,object>}} [prior]
 * @returns {Record<string,{issueNumber:number|null,contentHash:string,lastObservedAgentState:string|null}>}
 */
export function projectMapping(spec, prior = {}) {
  const priorMapping =
    prior && typeof prior.mapping === 'object' && prior.mapping !== null
      ? prior.mapping
      : {};
  const next = {};
  for (const [slug, entry] of iterSpecEntries(spec)) {
    const previous = priorMapping[slug] ?? {};
    next[slug] = {
      issueNumber:
        typeof previous.issueNumber === 'number' ? previous.issueNumber : null,
      contentHash: hashSpecEntry(entry),
      lastObservedAgentState:
        typeof previous.lastObservedAgentState === 'string'
          ? previous.lastObservedAgentState
          : null,
    };
  }
  return next;
}

/**
 * Build a complete state object from a spec, a prior state, and an
 * optional `now` timestamp (defaults to the current UTC ISO string).
 *
 * This is the canonical convenience wrapper the reconciler calls right
 * before `writeState`. Tests can pass `now: '2026-05-12T00:00:00Z'` to
 * make the resulting state byte-stable.
 *
 * @param {object} spec
 * @param {{mapping?: object}} [prior]
 * @param {{now?: string}} [opts]
 * @returns {{epicId: number, lastReconciledAt: string, mapping: object}}
 */
export function buildState(spec, prior = {}, opts = {}) {
  const epicId =
    typeof spec?.epic?.id === 'number' ? spec.epic.id : Number(prior?.epicId);
  const lastReconciledAt = opts.now ?? new Date().toISOString();
  return {
    epicId,
    lastReconciledAt,
    mapping: projectMapping(spec, prior),
  };
}
