/**
 * lib/audit-to-stories/dedupe-against-github.js
 *
 * Idempotency gate: classify each proposed group as either eligible-to-create,
 * already-open (skip), or re-occurring (skip, but flag). The classifier
 * leans on the fingerprint footer the workflow stamps into every Story
 * body it creates — `<!-- audit-fingerprints: sha1,sha1,... -->`.
 *
 * The lookup is delegated to a `provider` port the caller injects. The
 * port exposes a single async method, `findIssuesByFingerprint(sha)`,
 * that returns the matching issues `{ number, state }[]`. In production
 * the CLI wires this to the existing GitHub provider via
 * `provider-factory.js`; in tests it's a thin in-memory stub.
 *
 * Pure orchestration: this module performs no network I/O itself.
 */

import { parseFingerprintFooter } from './fingerprint.js';

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
 * @param {Array<{ findIssuesByFingerprint: (sha: string) => Promise<Array<{ number: number, state: string, body?: string }>> }>} params.provider
 * @returns {Promise<{ classifications: GroupClassification[], summary: { create: number, skipOpen: number, skipReoccurring: number } }>}
 */
export async function classifyGroupsAgainstGitHub({ groups, provider }) {
  if (!Array.isArray(groups)) {
    throw new Error('classifyGroupsAgainstGitHub: groups must be an array');
  }
  if (!provider || typeof provider.findIssuesByFingerprint !== 'function') {
    throw new Error(
      'classifyGroupsAgainstGitHub: provider.findIssuesByFingerprint is required',
    );
  }

  const classifications = [];
  const summary = { create: 0, skipOpen: 0, skipReoccurring: 0 };

  for (const group of groups) {
    const shas = (group.findings ?? [])
      .map((f) => f?.fingerprint?.full)
      .filter((s) => typeof s === 'string' && s.length === 40);

    const matchedIssues = [];
    const matchedFingerprints = [];
    for (const sha of shas) {
      const hits = await provider.findIssuesByFingerprint(sha);
      if (!Array.isArray(hits)) continue;
      for (const hit of hits) {
        if (
          hit &&
          typeof hit.number === 'number' &&
          typeof hit.state === 'string'
        ) {
          // Sanity-confirm the footer actually carries this sha so a
          // false-positive search hit (e.g. body referencing the sha in
          // prose) does not skip the create.
          if (typeof hit.body === 'string') {
            const footerShas = parseFingerprintFooter(hit.body);
            if (!footerShas.includes(sha)) continue;
          }
          matchedIssues.push({ number: hit.number, state: hit.state });
          if (!matchedFingerprints.includes(sha)) {
            matchedFingerprints.push(sha);
          }
        }
      }
    }

    let action = 'create';
    if (matchedIssues.some((m) => m.state.toLowerCase() === 'open')) {
      action = 'skip-open';
      summary.skipOpen += 1;
    } else if (matchedIssues.length > 0) {
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
