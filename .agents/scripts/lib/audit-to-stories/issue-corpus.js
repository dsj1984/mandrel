/** Source and describe the dedup corpus. No I/O. */

import { auditLabelsForFindings } from './audit-lenses.js';
import { buildIssueIndex } from './issue-index.js';

/**
 * An injected `issues` corpus wins; else pre-fetch once off the list port.
 * An empty corpus is a real zero-row index, and a failed pre-fetch returns its
 * `error`: neither may collapse to a null index, which silently means no dedup
 * on a provider-less host.
 *
 * @param {{ listAuditIssues?: Function, groups?: Array<object>,
 *   issues?: Array<object> }} params
 * @returns {Promise<{ index: object|null, source: 'injected'|'prefetch'|'none',
 *   error?: unknown }>}
 */
async function resolveIssueCorpus({ listAuditIssues, groups, issues }) {
  if (Array.isArray(issues)) {
    return { index: buildIssueIndex(issues), source: 'injected' };
  }
  const labels =
    typeof listAuditIssues === 'function'
      ? auditLabelsForFindings(
          (groups ?? []).flatMap((group) => group?.findings ?? []),
        )
      : [];
  if (labels.length === 0) return { index: null, source: 'none' };
  try {
    return {
      index: buildIssueIndex(await listAuditIssues(labels)),
      source: 'prefetch',
    };
  } catch (err) {
    return { index: null, source: 'none', error: err };
  }
}

/**
 * Omits `dedupIndex` when no index was expected; describes a failed prefetch.
 *
 * @param {object} summary — the seeded counters.
 * @param {{ source: string, index: object|null, error?: unknown }} resolution
 * @returns {object} the same summary, with `dedupIndex` when applicable.
 */
function withIndexDescription(summary, { source, index, error }) {
  if (source === 'none' && !error) return summary;
  return { ...summary, dedupIndex: { source, size: index?.size ?? 0 } };
}

/**
 * Routing ports, resolved index and seeded summary. The provider port is
 * required only without a corpus: with an index, exact lookups never call it.
 *
 * @param {{ groups?: Array<object>, provider?: object,
 *   searchCandidates?: Function, listAuditIssues?: Function,
 *   issues?: Array<object> }} params
 * @returns {Promise<{ routing: object, summary: object, error?: unknown }>}
 * @throws {Error} when neither a provider read port nor a corpus is supplied.
 */
export async function prepareDedupRouting({
  groups,
  provider,
  searchCandidates,
  listAuditIssues,
  issues,
}) {
  const hasProviderPort =
    Boolean(provider) && typeof provider.findIssuesByFingerprint === 'function';
  if (!hasProviderPort && !Array.isArray(issues)) {
    throw new Error(
      'classifyGroupsAgainstGitHub: provider.findIssuesByFingerprint is required ' +
        'when no `issues` corpus is supplied',
    );
  }
  const { index, source, error } = await resolveIssueCorpus({
    listAuditIssues,
    groups,
    issues,
  });
  const semanticPort =
    typeof searchCandidates === 'function' ? searchCandidates : undefined;
  return {
    routing: {
      searchIssues: hasProviderPort
        ? (sha) => provider.findIssuesByFingerprint(sha)
        : undefined,
      semanticPort,
      // An index carries the semantic-key map, so confirmation is free; without
      // it a provider-less run would be fingerprint-exact only.
      routeOptions: {
        semanticKeyConfirm: Boolean(semanticPort) || Boolean(index),
      },
      index,
    },
    summary: withIndexDescription(
      {
        create: 0,
        skipOpen: 0,
        skipReoccurring: 0,
        dedupDegraded: { count: 0, groups: [] },
      },
      { source, index, error },
    ),
    error,
  };
}
