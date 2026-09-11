/**
 * lib/audit-to-stories/dedupe-against-github.js
 *
 * Idempotency gate: classify each proposed group as either eligible-to-create,
 * already-open (skip), or re-occurring (skip, but flag).
 *
 * This module owns **no** fingerprint or dedup logic. It routes every
 * finding through the shared `lib/findings/route-finding.js` helper — the
 * single dedup/route implementation, shared verbatim with `qa-explore` — and
 * folds the per-finding `routeFinding` decisions up to a group action:
 *
 *   - any finding routes to `update-existing` / `duplicate` → `skip-open`
 *   - else any finding routes to `regression-of-closed`     → `skip-reoccurring`
 *   - else (every finding is `new`)                          → `create`
 *
 * The GitHub lookup is delegated to a `provider` port the caller injects,
 * exposing `findIssuesByFingerprint(sha)` → `{ number, state, body }[]`. The
 * port is adapted into the `searchIssues` shape the shared helper expects.
 * When the caller ALSO injects a `searchCandidates(finding)` port (production
 * wires it to `semantic-issue-search.js`), routing runs the meaning-first
 * Stage-1 pass and opts into location-based semantic-key confirmation so a
 * reworded finding at an unchanged location still dedupes against its Issue
 * (Story #4626).
 *
 * When the caller injects a `listAuditIssues(labels)` port, the whole dedup
 * corpus is pre-fetched **once per run** off the list endpoint and indexed by
 * both provenance footers, so `findIssuesByFingerprint` is answered locally and
 * the rate-limited search API is spent only on findings with no exact hit.
 *
 * A caller that already holds the corpus injects it directly as `issues`
 * instead (Story #5301) — the host fetched it by whatever access path it has,
 * which is what lets dedup run on a host with no `gh` CLI at all. That source
 * needs no provider: with an index in play the exact lookup is answered from
 * memory and `findIssuesByFingerprint` is never called, so the port is required
 * only on the un-indexed path where it is genuinely used.
 *
 * Pure orchestration: this module performs no network I/O itself, and reads no
 * file — the caller hands over an array, never a path.
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
 * Render a short, operator-legible reason from a dedup-lookup failure. Pure —
 * no imports, no I/O — so the module stays pure orchestration (Story #4678).
 *
 * Both degrade paths run through here, so the wording an operator reads for a
 * failed index pre-fetch matches the wording for a failed per-group lookup:
 * one vocabulary for "the GitHub read did not complete", whichever read it was.
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
 * Stable operator-facing label for a group in a degrade report.
 * @param {object} group
 * @returns {string}
 */
function groupLabel(group) {
  return group?.groupKey ?? group?.title ?? '(unlabelled group)';
}

/**
 * Route every finding in one group and fold the per-finding decisions up to a
 * group action. Extracted so the top-level loop can wrap it in one try/catch:
 * a search failure that survives the endpoint budget (an HTTP 422, or a rate
 * limit still exhausted after the cooldown) throws out of here and is caught
 * once per group rather than aborting the whole scan (Story #4678).
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
 * The read ports one finding is routed through.
 *
 * With no local index this is the historical wiring: the provider answers the
 * exact lookup and the semantic port always runs. With an index, the exact
 * lookup is answered from memory, and the semantic port — the only remaining
 * network call — runs **only** when the index holds no exact fingerprint hit.
 * That is the whole saving: a finding the sweep has already filed costs zero
 * requests, and only a genuinely-unrecognised one is worth a search.
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
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [params.searchCandidates]
 *   Optional meaning-first candidate search (production: `semantic-issue-search.js`).
 *   When supplied, routing runs the Stage-1 semantic pass and opts into
 *   location-based semantic-key confirmation.
 * @param {(labels: string[]) => Promise<Array<object>>} [params.listAuditIssues]
 *   Optional list port over the run's `audit::*` labels. When wired, its result
 *   is fetched once and indexed, and `provider.findIssuesByFingerprint` is not
 *   called at all — the exact lookup is answered from that index.
 * @param {Array<object>} [params.issues]
 *   Optional pre-fetched corpus the caller already holds, used in preference to
 *   `listAuditIssues`. Supplying it makes `provider` optional: with an index in
 *   play no provider read port is ever invoked, which is what lets a host with
 *   no `gh` CLI dedup at all (Story #5301). An empty array is a valid corpus —
 *   a first sweep — and is NOT read as "no index".
 * @param {(entry: { group: object, reason: string }) => void} [params.onDegraded]
 *   Optional sink notified once per group whose dedup lookup could not complete
 *   (Story #4678). The group is then classified `create` — a soft-fail, never
 *   fatal. Pure orchestration: this module performs no network I/O and swallows
 *   no failure silently.
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
    // Same vocabulary as a per-group failure, but deliberately NOT counted as
    // a degraded group: the count names groups classified without a check, and
    // every group still gets one here, off the per-finding search path. Until
    // Story #5301 this failure was swallowed whole, so the operator saw only
    // the downstream per-group degradation and could not tell what caused it.
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
      // A dedup lookup that cannot complete degrades this group to `create`
      // with a recorded reason — never aborts the whole scan.
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
