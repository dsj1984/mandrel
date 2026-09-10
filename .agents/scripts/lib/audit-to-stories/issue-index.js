/**
 * lib/audit-to-stories/issue-index.js — a local index of the audit Issues a
 * sweep must dedupe against.
 *
 * Dedup used to answer every finding with a **search** round-trip: one
 * `findIssuesByFingerprint(sha)` per finding, plus a meaning-first semantic
 * search on top. GitHub's search endpoint is rate-limited an order of magnitude
 * harder than the list endpoint, so a full-scope sweep — hundreds of findings —
 * spent its whole budget re-discovering the same few dozen Issues, and then
 * degraded the rest of the run to `create`, which is how a sweep opens
 * duplicates of Issues it already filed.
 *
 * The Issues that can possibly match are exactly those carrying an `audit::*`
 * label, and there are tens of them, not hundreds. Listing them **once per run**
 * and indexing their provenance footers answers every exact-fingerprint lookup
 * locally, for free. The search API is then spent only where it is the only
 * thing that can help: a finding with no exact hit, whose fingerprint may have
 * drifted under a rewording.
 *
 * Pure: the caller injects the list port and this module performs no I/O.
 */

import {
  parseFingerprintFooter,
  parseSemanticKeyFooter,
} from '../findings/route-finding.js';

/**
 * Add `record` to the list `map` keys under `key`.
 *
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
 * Index issues by both provenance footers the audit filers stamp.
 *
 * An issue carrying neither footer is indexed under nothing — it can never
 * confirm a match, exactly as it could not when it came back from a search.
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
 * The union of the two local lookups for one finding, fingerprint hits first.
 *
 * Order matters downstream: `routeFinding` keeps the first record contributed
 * for an issue number, and the record retrieved by exact identity is the one
 * that should survive into confirmation.
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
