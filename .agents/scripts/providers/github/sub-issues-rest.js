/** GitHub Provider — REST sub-issues once a session's proxy refuses GraphQL. */

import { Logger } from '../../lib/Logger.js';
import { isGraphqlBlocked } from './errors.js';
import { issueToTicket } from './mappers.js';
import { paginateRest } from './request-helpers.js';

const PAGE_CAP = 50;
const PAGE_SIZE = 100;

const PROCESS_LATCH = { blocked: false };

/**
 * @typedef {{
 *   latched: (parentId: number) => Promise<number[]> | null,
 *   onError: (err: unknown, parentId: number) => Promise<number[]> | null,
 * }} SubIssueRestFallback
 */

/**
 * @param {{ gh: object, owner: string, repo: string, cache?: object }} deps
 * @param {{ blocked: boolean }} [latch]
 * @returns {SubIssueRestFallback}
 */
export function createSubIssueRestFallback(deps, latch = PROCESS_LATCH) {
  const list = (parentId) => listSubIssuesViaRest({ ...deps, parentId });
  return {
    latched: (parentId) => (latch.blocked ? list(parentId) : null),
    onError(err, parentId) {
      if (!isGraphqlBlocked(err)) return null;
      if (!latch.blocked) {
        Logger.warn(
          '[GitHubProvider] GitHub GraphQL is refused in this session (Claude Code cloud proxy); ' +
            'reading sub-issues over REST for the rest of the run',
        );
      }
      latch.blocked = true;
      return list(parentId);
    },
  };
}

async function listSubIssuesViaRest({ gh, owner, repo, parentId, cache }) {
  const rows = await paginateRest(
    gh,
    `/repos/${owner}/${repo}/issues/${parentId}/sub_issues`,
    {
      pageCap: PAGE_CAP,
      perPage: PAGE_SIZE,
      label: `getNativeSubIssues(rest) parent=#${parentId}`,
    },
  );
  for (const row of rows) cache?.primeIfAbsent?.(issueToTicket(row));
  return rows.map((row) => row.number);
}
