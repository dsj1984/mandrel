/**
 * GitHub Provider — shared "set native blocked-by dependency" helper.
 *
 * Story #4067 — after issue creation during Phase 8 decomposition, each
 * Story's `depends_on` graph is known as a set of sibling slugs. This
 * helper translates those slug-to-issueNumber pairs into native GitHub
 * "blocked by" dependency edges so maintainers can see blocking
 * relationships directly in the GitHub UI.
 *
 * API surface used:
 *   Read:  GET  /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by
 *   Write: POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by
 *          body: { "issue_id": <integer db id of the blocking issue> }
 *
 * Contract:
 *   - **Idempotent** — reads existing edges first; only POSTs missing ones.
 *   - **Non-fatal** — catches all errors per edge, warns, and continues.
 *     The overall function never throws; errors are returned in a summary.
 *   - **No-op on empty input** — returns immediately when no depends_on
 *     edges are present or the slug→issueNumber map is empty.
 */

import { Logger } from '../../lib/Logger.js';
import { parseApiJson } from './request-helpers.js';

/**
 * Fetch the existing blocked-by issue numbers for a given issue.
 *
 * Returns `[]` on any error so the caller falls back to posting the full
 * set of missing edges (worst case: a duplicate POST, which GitHub
 * handles idempotently).
 *
 * @param {{ gh: object, owner: string, repo: string, issueNumber: number }} opts
 * @returns {Promise<number[]>} Database ids of the issues that currently block `issueNumber`.
 */
async function fetchExistingBlockedBy({ gh, owner, repo, issueNumber }) {
  try {
    const result = await gh.api({
      method: 'GET',
      endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
    });
    const data = parseApiJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => item?.id).filter((id) => typeof id === 'number');
  } catch (err) {
    Logger.warn(
      `[blocked-by-add] Could not fetch existing blocked-by for #${issueNumber}: ${err.message}`,
    );
    return [];
  }
}

/**
 * Set native GitHub "blocked by" dependency edges for a single issue.
 *
 * For each entry in `blockerInternalIds`, checks whether the edge already
 * exists and POSTs only the missing ones. Every individual POST failure is
 * caught, logged as a warning, and counted — the function never throws.
 *
 * @param {{
 *   gh: object,
 *   owner: string,
 *   repo: string,
 *   issueNumber: number,
 *   blockerInternalIds: number[],
 * }} opts
 * @returns {Promise<{ added: number, skipped: number, failed: number }>}
 */
async function addBlockedByEdges({
  gh,
  owner,
  repo,
  issueNumber,
  blockerInternalIds,
}) {
  if (blockerInternalIds.length === 0) {
    return { added: 0, skipped: 0, failed: 0 };
  }

  const existing = await fetchExistingBlockedBy({
    gh,
    owner,
    repo,
    issueNumber,
  });
  const existingSet = new Set(existing);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const blockerId of blockerInternalIds) {
    if (existingSet.has(blockerId)) {
      skipped++;
      continue;
    }
    try {
      await gh.api({
        method: 'POST',
        endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
        body: { issue_id: blockerId },
      });
      added++;
    } catch (err) {
      Logger.warn(
        `[blocked-by-add] Failed to add blocked-by edge #${issueNumber} ← blocker(id=${blockerId}): ${err.message}`,
      );
      failed++;
    }
  }

  return { added, skipped, failed };
}

/**
 * Translate a Story's `depends_on` slug list into native GitHub "blocked
 * by" dependency edges, given the slug→issueNumber map from the reconciler
 * state and a `getTicket` hook to resolve database ids.
 *
 * Iterates every Story that has a non-empty `dependsOn` array; for each
 * depended-on slug, resolves the blocker's issue number (via the slug map),
 * then resolves the blocker's database id via `getTicket`, and calls
 * `addBlockedByEdges`. Any failure at any step is caught, logged as a
 * warning, and reflected in the returned summary — the function never
 * throws.
 *
 * @param {{
 *   stories: Array<{ slug: string, dependsOn?: string[] }>,
 *   slugToIssueNumber: Record<string, number>,
 *   getTicket: (issueNumber: number) => Promise<{ internalId: number }>,
 *   owner: string,
 *   repo: string,
 *   gh: object,
 * }} opts
 * @returns {Promise<{
 *   edgesAdded: number,
 *   edgesSkipped: number,
 *   edgesFailed: number,
 *   storiesProcessed: number,
 * }>}
 */
export async function applyBlockedByDependencies({
  stories,
  slugToIssueNumber,
  getTicket,
  owner,
  repo,
  gh,
}) {
  let edgesAdded = 0;
  let edgesSkipped = 0;
  let edgesFailed = 0;
  let storiesProcessed = 0;

  for (const story of stories) {
    const deps = Array.isArray(story.dependsOn) ? story.dependsOn : [];
    if (deps.length === 0) continue;

    const storyIssueNumber = slugToIssueNumber[story.slug];
    if (typeof storyIssueNumber !== 'number') {
      Logger.warn(
        `[blocked-by-add] No issue number for story slug "${story.slug}"; skipping depends_on edges.`,
      );
      continue;
    }

    storiesProcessed++;
    const blockerInternalIds = [];

    for (const depSlug of deps) {
      const blockerIssueNumber = slugToIssueNumber[depSlug];
      if (typeof blockerIssueNumber !== 'number') {
        Logger.warn(
          `[blocked-by-add] depends_on slug "${depSlug}" (from "${story.slug}") has no mapped issue number; skipping edge.`,
        );
        edgesFailed++;
        continue;
      }
      try {
        const blocker = await getTicket(blockerIssueNumber);
        if (typeof blocker?.internalId !== 'number') {
          Logger.warn(
            `[blocked-by-add] Blocker #${blockerIssueNumber} ("${depSlug}") has no internalId; skipping edge.`,
          );
          edgesFailed++;
          continue;
        }
        blockerInternalIds.push(blocker.internalId);
      } catch (err) {
        Logger.warn(
          `[blocked-by-add] Could not resolve blocker "${depSlug}" (#${blockerIssueNumber}): ${err.message}`,
        );
        edgesFailed++;
      }
    }

    if (blockerInternalIds.length === 0) continue;

    const result = await addBlockedByEdges({
      gh,
      owner,
      repo,
      issueNumber: storyIssueNumber,
      blockerInternalIds,
    });
    edgesAdded += result.added;
    edgesSkipped += result.skipped;
    edgesFailed += result.failed;
  }

  return { edgesAdded, edgesSkipped, edgesFailed, storiesProcessed };
}
