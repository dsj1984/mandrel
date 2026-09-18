/**
 * Classify each group `create`, `skip-open` (any open match) or
 * `skip-reoccurring` (any closed match) by folding `route-finding.js`
 * decisions. No I/O.
 */

import { routeFinding, semanticKeyFor } from '../findings/route-finding.js';
import { toCanonicalFinding } from './finding-adapter.js';
import { prepareDedupRouting } from './issue-corpus.js';
import { lookupLocally } from './issue-index.js';

/**
 * @typedef {object} GroupClassification
 * @property {object} group — the original Group object.
 * @property {'create'|'skip-open'|'skip-reoccurring'} action
 * @property {{ number: number, state: string }[]} matchedIssues
 * @property {string[]} matchedFingerprints — full sha1 list that triggered the match.
 */

/**
 * One vocabulary for both degrade paths (index pre-fetch and per-group lookup).
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeDegradeReason(err) {
  const status = err?.status;
  const message = err?.message ?? String(err);
  if (status === 422 || /\b422\b/.test(message)) {
    return 'search query rejected (HTTP 422)';
  }
  if (/rate limit/i.test(message)) {
    return 'rate limit still exhausted after cooldown';
  }
  return `dedup lookup failed: ${message}`;
}

/**
 * @param {object} group
 * @returns {string}
 */
function groupLabel(group) {
  return group?.groupKey ?? group?.title ?? '(unlabelled group)';
}

/**
 * Throws on lookup failure; caught per group by the caller.
 *
 * @param {object} group
 * @param {object} routing — `{ searchIssues, semanticPort, routeOptions }`.
 * @returns {Promise<{ action: string, matchedIssues: Array, matchedFingerprints: string[] }>}
 */
async function classifyOneGroup(
  group,
  { searchIssues, semanticPort, routeOptions, index },
) {
  const findings = group.findings ?? [];
  const matchedIssues = [];
  const matchedFingerprints = [];
  let sawOpen = false;
  let sawClosed = false;

  for (const finding of findings) {
    const sha = finding?.fingerprint?.full;
    if (typeof sha !== 'string' || sha.length !== 40) continue;

    const canonical = toCanonicalFinding(finding);
    const { decision, matchedIssue, fingerprint } = await routeFinding(
      canonical,
      portsFor(canonical, sha, { searchIssues, semanticPort, index }),
      routeOptions,
    );

    if (decision === 'new') continue;

    if (matchedIssue) {
      matchedIssues.push({
        number: matchedIssue.number,
        state: matchedIssue.state,
      });
    }
    if (!matchedFingerprints.includes(fingerprint)) {
      matchedFingerprints.push(fingerprint);
    }
    if (decision === 'update-existing' || decision === 'duplicate') {
      sawOpen = true;
    } else if (decision === 'regression-of-closed') {
      sawClosed = true;
    }
  }

  let action = 'create';
  if (sawOpen) action = 'skip-open';
  else if (sawClosed) action = 'skip-reoccurring';

  return { action, matchedIssues, matchedFingerprints };
}

/**
 * With an index, the exact lookup is answered from memory and the semantic
 * search (the only network call left) runs only when there is no exact hit.
 *
 * @param {object} canonical — the canonical finding projection.
 * @param {string} sha — its full fingerprint.
 * @param {{ searchIssues: Function, semanticPort?: Function, index?: object }} routing
 * @returns {{ searchIssues: Function, searchCandidates?: Function }}
 */
function portsFor(canonical, sha, { searchIssues, semanticPort, index }) {
  const withSemantic = (ports) =>
    semanticPort
      ? { ...ports, searchCandidates: () => semanticPort(canonical) }
      : ports;
  if (!index) return withSemantic({ searchIssues });

  const { exact, pool } = lookupLocally(index, sha, semanticKeyFor(canonical));
  const local = { searchIssues: () => pool };
  return exact.length > 0 ? local : withSemantic(local);
}

/**
 * @param {object} params
 * @param {Array<object>} params.groups — output of `groupFindings`.
 * @param {{ findIssuesByFingerprint: (sha: string) => Promise<Array<{ number: number, state: string, body?: string }>> }} params.provider
 *   Only read on the un-indexed path.
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [params.searchCandidates]
 *   Enables the semantic pass and semantic-key confirmation.
 * @param {(labels: string[]) => Promise<Array<object>>} [params.listAuditIssues]
 *   Fetched once and indexed.
 * @param {Array<object>} [params.issues] Pre-fetched corpus, preferred over
 *   `listAuditIssues`; lets a host with no `gh` dedup. `[]` is a valid corpus.
 * @param {(entry: { group: object, reason: string }) => void} [params.onDegraded]
 *   Notified per group whose lookup failed; that group soft-fails to `create`.
 * @returns {Promise<{ classifications: GroupClassification[], summary: { create: number, skipOpen: number, skipReoccurring: number, dedupDegraded: { count: number, groups: Array<{ group: string, reason: string }> } } }>}
 */
export async function classifyGroupsAgainstGitHub({
  groups,
  provider,
  searchCandidates,
  onDegraded,
  listAuditIssues,
  issues,
}) {
  if (!Array.isArray(groups)) {
    throw new Error('classifyGroupsAgainstGitHub: groups must be an array');
  }

  const { routing, summary, error } = await prepareDedupRouting({
    groups,
    provider,
    searchCandidates,
    listAuditIssues,
    issues,
  });
  if (error) {
    // Not counted as a degraded group: per-finding search still checks each.
    const reason = `issue-index pre-fetch failed: ${describeDegradeReason(error)}`;
    summary.dedupDegraded.indexPrefetch = reason;
    if (typeof onDegraded === 'function') onDegraded({ group: null, reason });
  }

  const classifications = [];

  for (const group of groups) {
    let result;
    try {
      result = await classifyOneGroup(group, routing);
    } catch (err) {
      const reason = describeDegradeReason(err);
      const entry = { group: groupLabel(group), reason };
      summary.dedupDegraded.count += 1;
      summary.dedupDegraded.groups.push(entry);
      if (typeof onDegraded === 'function') onDegraded({ group, reason });
      result = { action: 'create', matchedIssues: [], matchedFingerprints: [] };
    }

    if (result.action === 'skip-open') summary.skipOpen += 1;
    else if (result.action === 'skip-reoccurring') summary.skipReoccurring += 1;
    else summary.create += 1;

    classifications.push({ group, ...result });
  }

  return { classifications, summary };
}
