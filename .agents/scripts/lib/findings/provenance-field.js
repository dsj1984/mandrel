/**
 * lib/findings/provenance-field.js — the optional per-Story `provenance`
 * field naming the audit identities that Story owns.
 *
 * @module lib/findings/provenance-field
 */

import {
  fingerprintFooter,
  SEMANTIC_KEY_RE,
  SHA1_RE,
  semanticKeyFooter,
} from './route-finding.js';

const PROVENANCE_SHAPE = 'fingerprints[] / semanticKeys[]';

const PROVENANCE_FIELDS = Object.freeze({
  fingerprints: { pattern: SHA1_RE, expected: 'a 40-char sha1 hex string' },
  semanticKeys: {
    pattern: SEMANTIC_KEY_RE,
    expected: 'a non-empty key carrying no comma or ">"',
  },
});

/**
 * @param {unknown} list
 * @param {{ where: string, field: string, pattern: RegExp, expected: string }} spec
 * @returns {string[]} Trimmed, de-duplicated, first-seen order.
 */
function normalizeList(list, { where, field, pattern, expected }) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${where}: ${field} must be an array of strings`);
  }
  const out = [];
  for (const entry of list) {
    const value = typeof entry === 'string' ? entry.trim() : '';
    if (!pattern.test(value)) {
      throw new Error(
        `${where}: ${field} entry ${JSON.stringify(entry)} is not ${expected}`,
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Absent → `null`: the caller falls back to carrying the whole seed's union
 * (hand-carrying was measured to fail). An empty object means "owns nothing"
 * and stamps nothing. Malformed throws — a dropped identity is invisible until
 * the next sweep re-files planned work.
 *
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {{ fingerprints: string[], semanticKeys: string[] }|null}
 * @throws {Error} On any shape the stamper cannot honour exactly.
 */
export function normalizeOwnedProvenance(raw, label = 'story') {
  if (raw === undefined || raw === null) return null;
  const where = `provenance on "${label}"`;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object of ${PROVENANCE_SHAPE}`);
  }
  const out = { fingerprints: [], semanticKeys: [] };
  for (const [field, list] of Object.entries(raw)) {
    const spec = PROVENANCE_FIELDS[field];
    if (!spec) {
      throw new Error(
        `${where} carries an unknown field: ${field} — only ${PROVENANCE_SHAPE} are stamped`,
      );
    }
    out[field] = normalizeList(list, { where, field, ...spec });
  }
  return out;
}

/**
 * Render owned identities in the same footer vocabulary
 * `carryProvenanceFooters` harvests, so attribution changes which identities
 * are stamped, never how. An empty set renders `''` (nothing inherited from
 * siblings). Expects {@link normalizeOwnedProvenance}'s shape.
 *
 * @param {{ fingerprints?: string[], semanticKeys?: string[] }|null} [provenance]
 * @returns {string}
 */
export function ownedProvenanceSource(provenance) {
  const shas = provenance?.fingerprints ?? [];
  const keys = provenance?.semanticKeys ?? [];
  const parts = [];
  if (shas.length > 0) parts.push(fingerprintFooter(shas));
  if (keys.length > 0) parts.push(semanticKeyFooter(keys));
  return parts.join('\n');
}
