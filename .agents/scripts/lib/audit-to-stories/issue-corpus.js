/**
 * lib/audit-to-stories/issue-corpus.js — where the dedup corpus comes from,
 * and how a corpus that could not be fetched is described to the operator.
 *
 * Dedup needs exactly one thing from GitHub: the Issues carrying an `audit::*`
 * label. Until Story #5301 the only source was the provider's list port, which
 * spawns `gh`, so a host without a `gh` CLI — a Claude Code cloud sandbox,
 * where `gh` is absent and direct API access is disabled while the GitHub MCP
 * tools work fine — could not dedup at all: every group classified `create`
 * and a scheduled sweep re-filed what it had already filed.
 *
 * Sourcing lives here rather than in `dedupe-against-github.js` so that module
 * stays what its own header claims — pure routing of findings to verdicts —
 * and so the empty-corpus and failed-fetch cases cannot diverge between call
 * sites. Nothing here reaches the network or the filesystem: a caller that
 * already holds the corpus passes the array in.
 */

import { auditLabelsForFindings } from './audit-lenses.js';
import { buildIssueIndex } from './issue-index.js';

/**
 * Resolve the dedup corpus into an index, from whichever source is wired.
 *
 * A corpus the caller already holds (`issues`) wins: the host fetched it by
 * whatever GitHub access path it has, which is what lets dedup run where there
 * is no `gh` CLI. Otherwise the run's `audit::*` Issues are pre-fetched off the
 * list port, once.
 *
 * Two results deliberately do NOT collapse to "no index", because a null index
 * silently returns the run to the per-finding search — which on a
 * provider-less host is no dedup at all, the failure this path exists to kill.
 * An **empty** injected corpus is a legitimate first sweep and yields a real
 * zero-row index. A **failed** pre-fetch hands back its `error` so the caller
 * can say so in its own words: an operator who cannot see that the pre-fetch
 * failed cannot tell a checked plan from an unchecked one.
 *
 * Module-internal: every caller reaches it through `prepareDedupRouting`, so
 * the empty-corpus and failed-fetch cases cannot diverge between call sites.
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
 * Assemble everything routing needs from the caller's ports and corpus: the
 * read ports, the resolved index, and the two facts the caller must report —
 * what the corpus was and whether fetching it degraded.
 *
 * The provider port is validated here because this is where "is there a usable
 * dedup source at all" is actually known. It is required only on the
 * un-indexed path: once an index exists every exact lookup is answered from
 * memory and `findIssuesByFingerprint` is never called, so demanding it there
 * would be the one thing standing between a `gh`-less host and a real dedup
 * run.
 *
 * @param {{ groups?: Array<object>, provider?: object,
 *   searchCandidates?: Function, listAuditIssues?: Function,
 *   issues?: Array<object> }} params
 * The seeded `summary` comes back with it: the corpus is the only thing that
 * knows what the index was, and returning the counters beside it keeps the
 * caller from reconstructing a shape it does not own.
 *
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
      // routeFinding hands the port the sha it computed off the canonical
      // projection, which equals the sha the group already carries.
      searchIssues: hasProviderPort
        ? (sha) => provider.findIssuesByFingerprint(sha)
        : undefined,
      semanticPort,
      // An index carries the semantic-key map, so location-based confirmation
      // costs nothing once one exists. Without this, confirmation would discard
      // the `bySemanticKey` half of the pool the local lookup just built, and a
      // provider-less run would be fingerprint-exact only — strictly weaker
      // than the path it replaces.
      routeOptions: {
        semanticKeyConfirm: Boolean(semanticPort) || Boolean(index),
      },
      index,
    },
    summary: {
      create: 0,
      skipOpen: 0,
      skipReoccurring: 0,
      dedupDegraded: { count: 0, groups: [] },
      dedupIndex: { source, size: index?.size ?? 0 },
    },
    error,
  };
}
