/**
 * Per-Story attribution of an audit seed's findings. An N>1 plan whose seed
 * carries `audit-finding` records stamps each Story with the findings its
 * `changes[]` cover — and the `audit::*` labels those findings explain —
 * instead of smearing the seed union across every Story. Anything else keeps
 * the union path (`audit-provenance.js`).
 */

import picomatch from 'picomatch';

import { parseAuditFindingRecords } from '../../findings/audit-finding-record.js';
import { ownedProvenanceSource } from '../../findings/provenance-field.js';
import {
  parseAuditLabelFooter,
  parseFingerprintFooter,
  parseSemanticKeyFooter,
} from '../../findings/route-finding.js';

/**
 * @param {unknown} changes — `changes[]` entries, strings or `{ path }`.
 * @returns {Array<(file: string) => boolean>}
 */
function coverageMatchers(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((c) => (typeof c === 'string' ? c : c?.path))
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => {
      const glob = p.trim();
      const match = picomatch(glob, { dot: true });
      return (file) => file === glob || match(file);
    });
}

/**
 * @param {Array<{ index: number, covers: Array<(f: string) => boolean> }>} candidates
 * @param {string[]} files
 * @returns {number[]}
 */
function coveringIndexes(candidates, files) {
  const covering = (file) =>
    candidates.filter((c) => c.covers.some((m) => m(file))).map((c) => c.index);
  // The primary file decides; the others only when nobody covers it.
  const [primary, ...rest] = files;
  if (primary === undefined) return [];
  const byPrimary = covering(primary);
  if (byPrimary.length > 0) return byPrimary;
  return [...new Set(rest.flatMap(covering))];
}

/**
 * Seed shas with no record are unattributable: carried like an unattributed
 * finding so every seed sha still reaches a Story.
 *
 * @param {string} provenanceSource
 * @returns {Array<{ sha: string, key: string, label: string|null, files: string[] }>}
 */
function seedIdentities(provenanceSource) {
  const records = parseAuditFindingRecords(provenanceSource);
  const known = new Set(records.map((r) => r.sha));
  const bare = parseFingerprintFooter(provenanceSource)
    .filter((sha) => !known.has(sha))
    .map((sha) => ({ sha, key: '', label: null, files: [] }));
  return [...records, ...bare];
}

/**
 * Whether persist attributes per Story: an N>1 draft whose seed carries at
 * least one `audit-finding` record. Anything else keeps the union path.
 *
 * @param {number} storyCount
 * @param {string} [provenanceSource]
 * @returns {boolean}
 */
function attributionApplies(storyCount, provenanceSource) {
  return (
    storyCount > 1 &&
    parseAuditFindingRecords(provenanceSource ?? '').length > 0
  );
}

/**
 * Attribute each seed finding to the Stories that cover it. Order per Story:
 * an authored `provenance` wins outright; otherwise the Story owns every
 * finding one of whose files its `changes[]` covers (exact path, or a glob
 * under picomatch `dot: true`). A finding no Story owns is unattributed: it
 * rides on every non-authored Story and is named in the warnings.
 *
 * @param {Array<{ provenance: object|null, changes?: unknown }>} stories — draft order.
 * @param {string} [provenanceSource] — the resolved seed provenance.
 * @returns {{ sources: Array<string|null>, warnings: string[] }|null}
 *   null when attribution does not apply; else one footer source per Story
 *   (`null` for an authored Story, which keeps its own).
 */
export function attributeSeedProvenance(stories, provenanceSource) {
  const list = Array.isArray(stories) ? stories : [];
  if (!attributionApplies(list.length, provenanceSource)) return null;

  const candidates = list
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.provenance === null || s.provenance === undefined)
    .map(({ s, index }) => ({ index, covers: coverageMatchers(s.changes) }));
  const authored = new Set(
    list.flatMap((s) => s.provenance?.fingerprints ?? []),
  );
  const identities = seedIdentities(provenanceSource);
  const owned = list.map(() => []);
  const warnings = [];

  for (const identity of identities) {
    const owners = coveringIndexes(candidates, identity.files);
    if (owners.length > 0 || authored.has(identity.sha)) {
      for (const i of owners) owned[i].push(identity);
      continue;
    }
    for (const c of candidates) owned[c.index].push(identity);
    warnings.push(
      `unattributed audit finding ${identity.sha.slice(0, 12)} ` +
        `(${identity.files[0] ?? 'no file'}) — carried on all ` +
        `${candidates.length} Stories`,
    );
  }

  const recordKeys = new Set(identities.map((r) => r.key));
  const bareKeys = parseSemanticKeyFooter(provenanceSource).filter(
    (k) => !recordKeys.has(k),
  );
  const sources = list.map((s, i) => {
    if (s.provenance !== null && s.provenance !== undefined) return null;
    return ownedProvenanceSource({
      fingerprints: owned[i].map((r) => r.sha),
      semanticKeys: [
        ...new Set([...owned[i].map((r) => r.key), ...bareKeys]),
      ].filter((k) => k.length > 0),
    });
  });
  return { sources, warnings };
}

/**
 * The labels one Story's stamped shas explain. A sha with no record (an
 * authored identity outside the seed) gets the seed union: a label only
 * widens the next sweep's corpus (matching is by fingerprint), so erring
 * wide is safe.
 *
 * @param {string} body
 * @param {Map<string, string|null>} labelBySha
 * @param {string[]} union
 * @returns {string[]}
 */
function attributedLabels(body, labelBySha, union) {
  const out = [];
  for (const sha of parseFingerprintFooter(body)) {
    if (!labelBySha.has(sha)) return [...new Set([...out, ...union])];
    const label = labelBySha.get(sha);
    if (label) out.push(label);
  }
  return out;
}

/**
 * Per-Story `audit::*` labels, in draft order. Union path (N==1, or a seed
 * with no records): every Story gets the seed's union labels. Attribution
 * path: each Story gets the labels of the findings stamped on its body.
 *
 * @param {Array<{ body?: string }>} stories
 * @param {string} provenanceSource
 * @returns {string[][]}
 */
export function auditLabelsPerStory(stories, provenanceSource) {
  const union = parseAuditLabelFooter(provenanceSource);
  if (!attributionApplies(stories.length, provenanceSource)) {
    return stories.map(() => union);
  }
  const labelBySha = new Map(
    parseAuditFindingRecords(provenanceSource).map((r) => [r.sha, r.label]),
  );
  return stories.map((s) => attributedLabels(s.body ?? '', labelBySha, union));
}
