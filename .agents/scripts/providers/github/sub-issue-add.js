/**
 * GitHub Provider — shared "link child issue to a parent" helper.
 *
 * Story #5139 — a container Epic holds its children as native GitHub
 * sub-issue edges. The read side has existed since v1
 * (`sub-issues.js` → `getNativeSubIssues`, and the three-strategy
 * aggregator in `issues.js` → `getSubTickets`); this is the missing write.
 *
 * API surface used:
 *   Read:  GET  /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
 *   Write: POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
 *          body: { "sub_issue_id": <integer db id of the CHILD issue> }
 *
 * **`sub_issue_id` is the child's database id, not its issue number.** They
 * are different integers and both are plausible, so a mix-up does not throw
 * — it silently links the wrong issue, or a nonexistent one. This mirrors
 * `blocked-by-add.js`, whose `issue_id` carries the same trap.
 *
 * Contract (deliberately identical to `blocked-by-add.js`):
 *   - **Idempotent** — reads existing edges first; only POSTs missing ones.
 *   - **Non-fatal** — catches all errors per edge, warns, and continues.
 *     The function never throws; failures are returned in the summary.
 *     The Epic body's checklist is the durable mirror, so a lost edge
 *     degrades discoverability rather than losing the child.
 *   - **No-op on empty input.**
 */

import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import { paginateRest } from './request-helpers.js';

/**
 * Bounded concurrency for the sub-issue round-trips. Matches the
 * dependency-edge writer's cap: modest enough for GitHub's secondary rate
 * limits while collapsing wall-clock from `sum(round-trips)` toward
 * `sum(round-trips) / concurrency`.
 */
const EDGE_CONCURRENCY = 5;

/**
 * Fetch the database ids of a parent's existing sub-issues, **paginated to
 * exhaustion**.
 *
 * This read is the idempotency check: an edge it fails to see is re-POSTed.
 * Reading only the first page would therefore make the writer non-idempotent
 * past the page boundary — the same defect Story #5046 fixed in
 * `blocked-by-add.js`.
 *
 * Returns `[]` on any error so the caller falls back to posting the full
 * set. Worst case is a duplicate POST, which GitHub rejects harmlessly and
 * the per-edge catch absorbs.
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
 * Link a set of child issues to one parent as native sub-issues.
 *
 * For each entry in `childInternalIds`, checks whether the edge already
 * exists and POSTs only the missing ones. Every individual POST failure is
 * caught, logged and counted — the function never throws.
 *
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

  // Partition up front so the skip count is deterministic regardless of the
  // concurrent POST dispatch order.
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
 * Link child Stories to a container Epic, resolving each child's **database
 * id** from its issue number.
 *
 * Callers hold issue numbers (that is what `plan-persist` creates and what
 * an operator types); the API wants database ids. Doing the translation here
 * keeps that trap in one place instead of at every call site.
 *
 * `knownInternalIds` short-circuits the translation for children whose
 * database id the caller already has. `createIssue` returns `internalId` in
 * its response, so a cohort this run just created needs no lookup at all —
 * the `getTicket` fan-out that used to run over every child was re-reading
 * issues the same process had created seconds earlier, one round-trip per
 * Story, to recover a field it had already been handed and thrown away.
 * `getTicket` stays for the children a *resumed* run adopted, whose ids came
 * from a listing rather than a create.
 *
 * Never throws: a child whose id cannot be resolved is counted as failed and
 * the remaining edges still go out.
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
