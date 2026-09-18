/**
 * GitHub Provider — link child issues under a parent as native sub-issues
 * (`POST /repos/{owner}/{repo}/issues/{n}/sub_issues`).
 *
 * `sub_issue_id` is the child's database id, not its issue number; both are
 * plausible integers, so a mix-up silently links the wrong issue.
 *
 * Idempotent (reads existing edges first) and non-fatal (per-edge failures
 * are warned and counted, never thrown) — the Epic body's checklist is the
 * durable mirror. Same contract as `blocked-by-add.js`.
 */

import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { paginateRest } from './request-helpers.js';

/** Kept modest for GitHub's secondary rate limits. */
const EDGE_CONCURRENCY = 5;

/**
 * Paginated to exhaustion: this is the idempotency check, and an unseen edge
 * is re-POSTed. `[]` on error — a duplicate POST is rejected harmlessly.
 *
 * @param {{ gh: object, owner: string, repo: string, issueNumber: number, paginate?: Function }} opts
 * @returns {Promise<number[]>} Database ids of the parent's current children.
 */
async function fetchExistingSubIssueIds({
  gh,
  owner,
  repo,
  issueNumber,
  paginate = paginateRest,
}) {
  try {
    const data = await paginate(
      gh,
      `/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues`,
      { label: `[sub-issue-add] sub_issues #${issueNumber}` },
    );
    if (!Array.isArray(data)) return [];
    return data.map((item) => item?.id).filter((id) => typeof id === 'number');
  } catch (err) {
    Logger.warn(
      `[sub-issue-add] Could not fetch existing sub-issues for #${issueNumber}: ${err.message}`,
    );
    return [];
  }
}

/**
 * @param {{
 *   gh: object,
 *   owner: string,
 *   repo: string,
 *   issueNumber: number,
 *   childInternalIds: number[],
 *   paginate?: Function,
 * }} opts
 * @returns {Promise<{ added: number, skipped: number, failed: number }>}
 */
export async function addSubIssueEdges({
  gh,
  owner,
  repo,
  issueNumber,
  childInternalIds,
  paginate = paginateRest,
}) {
  const ids = Array.isArray(childInternalIds) ? childInternalIds : [];
  if (ids.length === 0) return { added: 0, skipped: 0, failed: 0 };

  const existing = await fetchExistingSubIssueIds({
    gh,
    owner,
    repo,
    issueNumber,
    paginate,
  });
  const existingSet = new Set(existing);

  // Partition up front so `skipped` is independent of dispatch order.
  const missing = ids.filter((id) => !existingSet.has(id));
  const skipped = ids.length - missing.length;

  const perEdge = await concurrentMap(
    missing,
    async (childId) => {
      try {
        await gh.api({
          method: 'POST',
          endpoint: `/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues`,
          body: { sub_issue_id: childId },
        });
        return { added: 1, failed: 0 };
      } catch (err) {
        Logger.warn(
          `[sub-issue-add] Failed to link child(id=${childId}) under #${issueNumber}: ${err.message}`,
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
 * Link Stories to a container Epic, translating issue numbers to database ids
 * here so the trap lives in one place. `knownInternalIds` (from
 * `createIssue`) skips the lookup; `getTicket` covers children a resumed run
 * adopted. An unresolvable child counts as failed; the rest still go out.
 *
 * @param {{
 *   epicNumber: number,
 *   childIssueNumbers: number[],
 *   knownInternalIds?: Map<number, number>|null,
 *   getTicket: (issueNumber: number) => Promise<{ internalId: number }>,
 *   owner: string,
 *   repo: string,
 *   gh: object,
 *   paginate?: Function,
 * }} opts
 * @returns {Promise<{ added: number, skipped: number, failed: number }>}
 */
export async function linkStoriesToEpic({
  epicNumber,
  childIssueNumbers,
  knownInternalIds = null,
  getTicket,
  owner,
  repo,
  gh,
  paginate = paginateRest,
}) {
  const numbers = Array.isArray(childIssueNumbers) ? childIssueNumbers : [];
  if (numbers.length === 0) return { added: 0, skipped: 0, failed: 0 };

  const known = knownInternalIds instanceof Map ? knownInternalIds : new Map();
  let failed = 0;
  const childInternalIds = [];

  for (const childNumber of numbers) {
    const alreadyKnown = known.get(Number(childNumber));
    if (typeof alreadyKnown === 'number') {
      childInternalIds.push(alreadyKnown);
      continue;
    }
    try {
      const ticket = await getTicket(childNumber);
      const internalId = ticket?.internalId;
      if (typeof internalId !== 'number') {
        Logger.warn(
          `[sub-issue-add] Child #${childNumber} has no resolvable database id; skipping edge.`,
        );
        failed++;
        continue;
      }
      childInternalIds.push(internalId);
    } catch (err) {
      Logger.warn(
        `[sub-issue-add] Could not resolve child #${childNumber}: ${err.message}`,
      );
      failed++;
    }
  }

  const summary = await addSubIssueEdges({
    gh,
    owner,
    repo,
    issueNumber: epicNumber,
    childInternalIds,
    paginate,
  });

  return { ...summary, failed: summary.failed + failed };
}
