/**
 * Local index of `audit::*` Issues by provenance footer, listed once per run.
 * Search is far more rate-limited than list, so exact-fingerprint lookups are
 * answered here and search is spent only on findings with no exact hit. Pure.
 */

import {
  parseFingerprintFooter,
  parseSemanticKeyFooter,
} from '../findings/route-finding.js';

/**
 * @param {Map<string, object[]>} map
 * @param {string} key
 * @param {object} record
 */
function push(map, key, record) {
  const bucket = map.get(key);
  if (bucket) bucket.push(record);
  else map.set(key, [record]);
}

/**
 * An issue with neither footer is indexed under nothing.
 *
 * @param {Array<{ number: number, state: string, body?: string }>} issues
 * @returns {{ byFingerprint: Map<string, object[]>, bySemanticKey: Map<string, object[]>, size: number }}
 */
export function buildIssueIndex(issues) {
  const byFingerprint = new Map();
  const bySemanticKey = new Map();
  const records = (issues ?? []).filter(
    (issue) => typeof issue?.number === 'number',
  );
  for (const issue of records) {
    for (const sha of parseFingerprintFooter(issue.body)) {
      push(byFingerprint, sha, issue);
    }
    for (const key of parseSemanticKeyFooter(issue.body)) {
      push(bySemanticKey, key, issue);
    }
  }
  return { byFingerprint, bySemanticKey, size: records.length };
}

/**
 * Fingerprint hits first: `routeFinding` keeps the first record per issue
 * number, and the exact-identity one should survive into confirmation.
 *
 * @param {{ byFingerprint: Map, bySemanticKey: Map }} index
 * @param {string} sha
 * @param {string} semanticKey
 * @returns {{ exact: object[], pool: object[] }}
 */
export function lookupLocally(index, sha, semanticKey) {
  const exact = index.byFingerprint.get(sha) ?? [];
  const byKey = semanticKey ? (index.bySemanticKey.get(semanticKey) ?? []) : [];
  return { exact, pool: [...exact, ...byKey] };
}
