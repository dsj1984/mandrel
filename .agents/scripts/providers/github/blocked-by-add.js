/**
 * GitHub Provider — writes Story `depends_on` slugs as native "blocked by"
 * edges (`POST .../dependencies/blocked_by` with the blocker's db id).
 * Idempotent (reads existing edges first) and non-fatal: errors are counted
 * in the summary, never thrown.
 */

import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { paginateRest } from './request-helpers.js';

/** Modest, to stay clear of GitHub's secondary rate limits. */
const EDGE_CONCURRENCY = 5;

/**
 * Existing blocker db ids, paginated to exhaustion — this read is the
 * idempotency check, so an unseen page means re-POSTed edges. Returns `[]` on
 * error (worst case a duplicate POST): a lost write-side edge is cosmetic,
 * unlike the read path in `resolve-stories.js`, where it drops a gate.
 *
 * @param {{ gh: object, owner: string, repo: string, issueNumber: number, paginate?: Function }} opts
 * @returns {Promise<number[]>} Database ids of the issues that currently block `issueNumber`.
 */
async function fetchExistingBlockedBy({
  gh,
  owner,
  repo,
  issueNumber,
  paginate = paginateRest,
}) {
  try {
    const data = await paginate(
      gh,
      `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
      { label: `[blocked-by-add] blocked_by #${issueNumber}` },
    );
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
 * POST only the missing edges for one issue; never throws.
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

  // Partition first so the skip count doesn't depend on POST ordering.
  const missing = blockerInternalIds.filter((id) => !existingSet.has(id));
  const skipped = blockerInternalIds.length - missing.length;

  const perEdge = await concurrentMap(
    missing,
    async (blockerId) => {
      try {
        await gh.api({
          method: 'POST',
          endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
          body: { issue_id: blockerId },
        });
        return { added: 1, failed: 0 };
      } catch (err) {
        Logger.warn(
          `[blocked-by-add] Failed to add blocked-by edge #${issueNumber} ← blocker(id=${blockerId}): ${err.message}`,
        );
        return { added: 0, failed: 1 };
      }
    },
    { concurrency: EDGE_CONCURRENCY },
  );

  let added = 0;
  let failed = 0;
  for (const r of perEdge) {
    added += r.added;
    failed += r.failed;
  }

  return { added, skipped, failed };
}

/**
 * For each Story's `dependsOn` slugs, resolve blocker issue number (slug map)
 * then db id (`getTicket`), and add the edges. Never throws.
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

  // Mappers swallow their own errors, so concurrentMap never rejects.
  const perStory = await concurrentMap(
    stories,
    async (story) => {
      const deps = Array.isArray(story.dependsOn) ? story.dependsOn : [];
      if (deps.length === 0) {
        return { added: 0, skipped: 0, failed: 0, processed: 0 };
      }

      const storyIssueNumber = slugToIssueNumber[story.slug];
      if (typeof storyIssueNumber !== 'number') {
        Logger.warn(
          `[blocked-by-add] No issue number for story slug "${story.slug}"; skipping depends_on edges.`,
        );
        return { added: 0, skipped: 0, failed: 0, processed: 0 };
      }

      let failed = 0;
      const blockerInternalIds = [];

      for (const depSlug of deps) {
        const blockerIssueNumber = slugToIssueNumber[depSlug];
        if (typeof blockerIssueNumber !== 'number') {
          Logger.warn(
            `[blocked-by-add] depends_on slug "${depSlug}" (from "${story.slug}") has no mapped issue number; skipping edge.`,
          );
          failed++;
          continue;
        }
        try {
          const blocker = await getTicket(blockerIssueNumber);
          if (typeof blocker?.internalId !== 'number') {
            Logger.warn(
              `[blocked-by-add] Blocker #${blockerIssueNumber} ("${depSlug}") has no internalId; skipping edge.`,
            );
            failed++;
            continue;
          }
          blockerInternalIds.push(blocker.internalId);
        } catch (err) {
          Logger.warn(
            `[blocked-by-add] Could not resolve blocker "${depSlug}" (#${blockerIssueNumber}): ${err.message}`,
          );
          failed++;
        }
      }

      if (blockerInternalIds.length === 0) {
        return { added: 0, skipped: 0, failed, processed: 1 };
      }

      const result = await addBlockedByEdges({
        gh,
        owner,
        repo,
        issueNumber: storyIssueNumber,
        blockerInternalIds,
      });
      return {
        added: result.added,
        skipped: result.skipped,
        failed: failed + result.failed,
        processed: 1,
      };
    },
    { concurrency: EDGE_CONCURRENCY },
  );

  for (const r of perStory) {
    edgesAdded += r.added;
    edgesSkipped += r.skipped;
    edgesFailed += r.failed;
    storiesProcessed += r.processed;
  }

  return { edgesAdded, edgesSkipped, edgesFailed, storiesProcessed };
}
