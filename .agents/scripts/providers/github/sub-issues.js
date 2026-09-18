/**
 * GitHub Provider — SubIssueGateway: the read side of native Sub-Issues (the
 * GraphQL `subIssues` field, paginated into child numbers). Holds no
 * transport state; every call goes through the parent's `ghGraphql` hook.
 */

import { describeGhFailure } from '../../lib/gh-exec.js';
import { Logger } from '../../lib/Logger.js';
import {
  classifyGithubError as defaultClassifyGithubError,
  SUB_ISSUES_QUERY,
  withTransientRetry,
} from './errors.js';
import { subIssueNodeToTicket } from './mappers.js';
import { defaultRetryWarn } from './request-helpers.js';

// Fail fast if `hasNextPage` never clears; 50 × 100 = 5000 sub-issues.
const NATIVE_SUB_ISSUE_PAGE_CAP = 50;

export class SubIssueGateway {
  /**
   * @param {{
   *   ghGraphql: (query: string, variables?: object, opts?: object) => Promise<object>,
   *   cache?: { primeIfAbsent: (ticket: object) => void },
   *   classifyGithubError?: (err: unknown) => string,
   * }} deps
   */
  constructor({
    ghGraphql,
    cache,
    classifyGithubError = defaultClassifyGithubError,
  } = {}) {
    this._ghGraphql = ghGraphql;
    this._cache = cache;
    this._classify = classifyGithubError;
  }

  /** Primes the ticket cache; `[]` when the feature is disabled. */
  async getNativeSubIssues(parentNodeId, parentId) {
    const childIds = [];
    let cursor = null;
    try {
      for (let walked = 0; walked < NATIVE_SUB_ISSUE_PAGE_CAP; walked++) {
        const data = await withTransientRetry(
          () =>
            this._ghGraphql(
              SUB_ISSUES_QUERY,
              { id: parentNodeId, cursor },
              { headers: { 'GraphQL-Features': 'sub_issues' } },
            ),
          {
            label: `getNativeSubIssues parent=#${parentId}`,
            classify: this._classify,
            onRetry: defaultRetryWarn,
          },
        );
        const page = data.node?.subIssues;
        const nodes = page?.nodes ?? [];
        for (const node of nodes) {
          childIds.push(node.number);
          if (this._cache?.primeIfAbsent) {
            this._cache.primeIfAbsent(subIssueNodeToTicket(node));
          }
        }
        if (!page?.pageInfo?.hasNextPage) return childIds;
        cursor = page.pageInfo.endCursor;
        if (walked === NATIVE_SUB_ISSUE_PAGE_CAP - 1) {
          throw new Error(
            `[getNativeSubIssues] cursor cap exceeded for parent #${parentId} ` +
              `(cap=${NATIVE_SUB_ISSUE_PAGE_CAP}, collected=${childIds.length})`,
          );
        }
      }
    } catch (err) {
      const category = this._classify(err);
      if (category === 'feature-disabled') {
        Logger.warn(
          `[GitHubProvider] sub-issues GraphQL unavailable (parent #${parentId}); using checklist fallback`,
        );
        return [];
      }
      // Not `err.message`: on the gh transport that is only `gh exited with
      // code 1`; the HTTP status and rate-limit notice are on stderr.
      Logger.error(
        `[GitHubProvider] sub-issues GraphQL failed (parent #${parentId}, ` +
          `category=${category}): ${describeGhFailure(err)}`,
      );
      throw err;
    }
    return childIds;
  }
}
