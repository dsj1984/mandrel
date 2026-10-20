/**
 * GitHub Provider — the REST read of native Sub-Issues, used once a Claude
 * Code cloud session's proxy has refused GraphQL. The refusal is
 * process-wide, so a latch remembers it: the first refusal warns once, and
 * every later parent reads REST with no GraphQL attempt and no log line.
 */

import { Logger } from '../../lib/Logger.js';
import { isGraphqlBlocked } from './errors.js';
import { issueToTicket } from './mappers.js';
import { paginateRest } from './request-helpers.js';

// Matches the GraphQL walk's cap: 50 × 100 = 5000 sub-issues.
const PAGE_CAP = 50;
const PAGE_SIZE = 100;

// Shared by every fallback the process creates.
const PROCESS_LATCH = { blocked: false };

/**
 * @typedef {{
 *   latched: (parentId: number) => Promise<number[]> | null,
 *   onError: (err: unknown, parentId: number) => Promise<number[]> | null,
 * }} SubIssueRestFallback
 */

/**
 * The `SubIssueGateway` REST seam: `latched` reads REST once the process has
 * seen GraphQL refused; `onError` trips the latch on that refusal (warning
 * once) and reads REST. Each yields null when GraphQL should be used.
 *
 * @param {{
 *   gh: { api: Function },
 *   owner: string,
 *   repo: string,
 *   cache?: { primeIfAbsent?: (ticket: object) => void },
 * }} deps
 * @param {{ blocked: boolean }} [latch] - the process-wide latch by default.
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

/**
 * Child issue numbers of `parentId`, each row primed into the cache.
 *
 * @field-manifest /repos/{owner}/{repo}/issues/{n}/sub_issues: number, id,
 *                 node_id, title, body, labels, state, assignees
 */
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
