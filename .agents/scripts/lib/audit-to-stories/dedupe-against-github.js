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
 * Pure orchestration: this module performs no network I/O itself.
 */

import { routeFinding } from '../findings/route-finding.js';
import { toCanonicalFinding } from './finding-adapter.js';

/**
 * @typedef {object} GroupClassification
 * @property {object} group — the original Group object.
 * @property {'create'|'skip-open'|'skip-reoccurring'} action
 * @property {{ number: number, state: string }[]} matchedIssues
 * @property {string[]} matchedFingerprints — full sha1 list that triggered the match.
 */

/**
 * @param {object} params
 * @param {Array<object>} params.groups — output of `groupFindings`.
 * @param {{ findIssuesByFingerprint: (sha: string) => Promise<Array<{ number: number, state: string, body?: string }>> }} params.provider
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [params.searchCandidates]
 *   Optional meaning-first candidate search (production: `semantic-issue-search.js`).
 *   When supplied, routing runs the Stage-1 semantic pass and opts into
 *   location-based semantic-key confirmation.
 * @returns {Promise<{ classifications: GroupClassification[], summary: { create: number, skipOpen: number, skipReoccurring: number } }>}
 */
export async function classifyGroupsAgainstGitHub({
  groups,
  provider,
  searchCandidates,
}) {
  if (!Array.isArray(groups)) {
    throw new Error('classifyGroupsAgainstGitHub: groups must be an array');
  }
  if (!provider || typeof provider.findIssuesByFingerprint !== 'function') {
    throw new Error(
      'classifyGroupsAgainstGitHub: provider.findIssuesByFingerprint is required',
    );
  }

  // Adapt the provider port into the `searchIssues` shape routeFinding wants.
  // routeFinding hands the port the sha it computed off the canonical
  // projection, which equals the sha the group already carries (both come
  // from the same `toCanonicalFinding` projection).
  const searchIssues = (sha) => provider.findIssuesByFingerprint(sha);
  const semanticPort =
    typeof searchCandidates === 'function' ? searchCandidates : undefined;
  const routeOptions = { semanticKeyConfirm: Boolean(semanticPort) };

  const classifications = [];
  const summary = { create: 0, skipOpen: 0, skipReoccurring: 0 };

  for (const group of groups) {
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
        semanticPort
          ? { searchIssues, searchCandidates: () => semanticPort(canonical) }
          : { searchIssues },
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
    if (sawOpen) {
      action = 'skip-open';
      summary.skipOpen += 1;
    } else if (sawClosed) {
      action = 'skip-reoccurring';
      summary.skipReoccurring += 1;
    } else {
      summary.create += 1;
    }

    classifications.push({
      group,
      action,
      matchedIssues,
      matchedFingerprints,
    });
  }

  return { classifications, summary };
}
