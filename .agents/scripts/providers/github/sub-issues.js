/**
 * GitHub Provider — SubIssueGateway.
 *
 * Owns the native GitHub Sub-Issues link surface (the GraphQL `subIssues`
 * field on an Issue, plus the add/remove mutations) along with the
 * `reconcileSubIssueLinks` walker that backfills missing parent/child
 * links across an Epic's child set.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2480. Public
 * surface on `GitHubProvider` is unchanged — `addSubIssue`,
 * `removeSubIssue`, and `reconcileSubIssueLinks` all delegate here.
 *
 * Constructed with `{ ghGraphql, hooks, classifyGithubError, cache, queries }`:
 *   - `ghGraphql(query, variables, opts)`    — bound `_ghGraphql` from the parent.
 *   - `hooks.getTicket(id, opts)`            — bound to the TicketGateway.
 *   - `hooks.getTickets(parentId)`           — bound to the TicketGateway (for the reconciler).
 *   - `hooks.primeTicketCache(tickets)`      — bound to the TicketGateway (reconciler priming).
 *   - `hooks.invalidateTicket(id)`           — bound to the TicketGateway (post-mutation invalidate).
 *   - `cache.primeIfAbsent(ticket)`          — bound to the shared cache (native-walk priming).
 *
 * The gateway holds **no** transport state of its own — every call goes
 * through the supplied `ghGraphql` hook, which is the parent provider's
 * `gh api graphql` shim.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { Logger } from '../../lib/Logger.js';
import { concurrentMap } from '../../lib/util/concurrent-map.js';
import {
  ADD_SUB_ISSUE_MUTATION,
  classifyGithubError as defaultClassifyGithubError,
  PARENT_ISSUE_QUERY,
  REMOVE_SUB_ISSUE_MUTATION,
  SUB_ISSUES_QUERY,
  withTransientRetry,
} from './errors.js';
import { subIssueNodeToTicket } from './mappers.js';
import { defaultRetryWarn } from './request-helpers.js';

// Concurrency + retry budgets — preserved from `../github.js` so dispatch
// fan-out and sub-issue reconciliation keep their established shapes.
const SUB_ISSUE_RECONCILE_CONCURRENCY = 4;
const SUB_ISSUE_RETRY_MAX_ATTEMPTS = 6;
const SUB_ISSUE_RETRY_BASE_DELAY_MS = 1000;
const SUB_ISSUE_RETRY_MAX_DELAY_MS = 30000;
const SUB_ISSUE_RETRY_JITTER_MS = 500;

// Story #2852: cap the native sub-issue cursor walk so a runaway pagination
// (e.g. an upstream API regression that never sets `hasNextPage = false`)
// fails fast instead of looping forever. 50 cursor pages × 100 nodes per
// page = 5000 sub-issues, well above any realistic Epic.
const NATIVE_SUB_ISSUE_PAGE_CAP = 50;

export class SubIssueGateway {
  /**
   * @param {{
   *   ghGraphql: (query: string, variables?: object, opts?: object) => Promise<object>,
   *   hooks?: {
   *     getTicket?: (id: number, opts?: object) => Promise<object>,
   *     getTickets?: (parentId: number) => Promise<object[]>,
   *     primeTicketCache?: (tickets: object[]) => void,
   *     invalidateTicket?: (id: number) => void,
   *   },
   *   cache?: { primeIfAbsent: (ticket: object) => void },
   *   classifyGithubError?: (err: unknown) => string,
   * }} deps
   */
  constructor({
    ghGraphql,
    hooks = {},
    cache,
    classifyGithubError = defaultClassifyGithubError,
  } = {}) {
    this._ghGraphql = ghGraphql;
    this._hooks = hooks;
    this._cache = cache;
    this._classify = classifyGithubError;
  }

  /**
   * Strategy 1 — native GitHub Sub-Issues via GraphQL. Paginates and seeds
   * the ticket cache via the supplied `cache.primeIfAbsent` hook. Returns
   * `[]` (not throw) when the feature is disabled on this repo.
   */
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
      Logger.error(
        `[GitHubProvider] sub-issues GraphQL failed (parent #${parentId}, category=${category}): ${err.message}`,
      );
      throw err;
    }
    return childIds;
  }

  /**
   * Strategy 2 — native GitHub Sub-Issues, inverse direction. Given a
   * child Issue node, return the parent's issue number (or `null` when
   * the child has no native parent link, or the feature is disabled on
   * this repo). Story #2982: used by `cascadeCompletion` as a third
   * fallback so a Story whose body lost the `parent: #N` orchestrator
   * footer still cascades upward to its true Sub-Issue parent.
   *
   * @param {string} childNodeId  GraphQL node ID of the child Issue.
   * @param {number} childNumber  Issue number, for log context only.
   * @returns {Promise<number|null>}
   */
  async getNativeParent(childNodeId, childNumber) {
    if (!childNodeId) return null;
    try {
      const data = await withTransientRetry(
        () =>
          this._ghGraphql(
            PARENT_ISSUE_QUERY,
            { id: childNodeId },
            { headers: { 'GraphQL-Features': 'sub_issues' } },
          ),
        {
          label: `getNativeParent child=#${childNumber}`,
          classify: this._classify,
          onRetry: defaultRetryWarn,
        },
      );
      const parent = data?.node?.parent;
      if (!parent || typeof parent.number !== 'number') return null;
      return parent.number;
    } catch (err) {
      const category = this._classify(err);
      if (category === 'feature-disabled') {
        Logger.warn(
          `[GitHubProvider] sub-issues parent lookup unavailable (child #${childNumber})`,
        );
        return null;
      }
      Logger.error(
        `[GitHubProvider] native parent lookup failed (child #${childNumber}, category=${category}): ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Establish the native sub-issue link between `parentNumber` and the
   * child identified by `childNodeId`. Retries on transient errors with
   * jittered exponential backoff before re-throwing.
   */
  async addSubIssue(
    parentNumber,
    childNodeId,
    opts = { replaceParent: false },
  ) {
    const getTicket = this._hooks.getTicket;
    if (typeof getTicket !== 'function') {
      throw new Error(
        '[SubIssueGateway] addSubIssue requires a getTicket hook',
      );
    }
    const parentTicket = await getTicket(parentNumber);
    let lastErr;
    for (let attempt = 0; attempt < SUB_ISSUE_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this._ghGraphql(
          ADD_SUB_ISSUE_MUTATION,
          {
            parentId: parentTicket.nodeId,
            subIssueId: childNodeId,
            replaceParent: opts.replaceParent,
          },
          { headers: { 'GraphQL-Features': 'sub_issues' } },
        );
        // Sub-issue link mutates the parent's sub-issue list. Invalidate so
        // the next `getTicket(parentNumber)` re-fetches a coherent view.
        if (typeof this._hooks.invalidateTicket === 'function') {
          this._hooks.invalidateTicket(parentNumber);
        }
        return result;
      } catch (err) {
        lastErr = err;
        const category = this._classify(err);
        const isFinalAttempt = attempt === SUB_ISSUE_RETRY_MAX_ATTEMPTS - 1;
        if (category !== 'transient' || isFinalAttempt) throw err;
        const base = Math.min(
          SUB_ISSUE_RETRY_MAX_DELAY_MS,
          SUB_ISSUE_RETRY_BASE_DELAY_MS * 2 ** attempt,
        );
        const delay =
          base + Math.floor(Math.random() * SUB_ISSUE_RETRY_JITTER_MS);
        Logger.warn(
          `[GitHubProvider] sub-issue link transient error for parent #${parentNumber} (attempt ${attempt + 1}/${SUB_ISSUE_RETRY_MAX_ATTEMPTS}); retrying in ${delay}ms: ${err.message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  async removeSubIssue(parentNumber, subIssueNumber) {
    const getTicket = this._hooks.getTicket;
    if (typeof getTicket !== 'function') {
      throw new Error(
        '[SubIssueGateway] removeSubIssue requires a getTicket hook',
      );
    }
    const parentTicket = await getTicket(parentNumber);
    const childTicket = await getTicket(subIssueNumber);
    const result = await this._ghGraphql(
      REMOVE_SUB_ISSUE_MUTATION,
      { parentId: parentTicket.nodeId, subIssueId: childTicket.nodeId },
      { headers: { 'GraphQL-Features': 'sub_issues' } },
    );
    if (typeof this._hooks.invalidateTicket === 'function') {
      this._hooks.invalidateTicket(parentNumber);
      this._hooks.invalidateTicket(subIssueNumber);
    }
    return result;
  }

  /**
   * Walk every child of `epicId` whose body footer carries `parent: #N` and
   * verify the native sub-issue link is present. Re-establish missing links
   * via `addSubIssue` (which retries internally). Idempotent.
   */
  async reconcileSubIssueLinks(epicId) {
    const PARENT_RE = /(?:^|\n)parent:\s*#(\d+)/;
    const getTicket = this._hooks.getTicket;
    const getTickets = this._hooks.getTickets;
    if (typeof getTicket !== 'function' || typeof getTickets !== 'function') {
      throw new Error(
        '[SubIssueGateway] reconcileSubIssueLinks requires getTicket + getTickets hooks',
      );
    }
    const allChildren = await getTickets(epicId);
    const parentByChild = new Map();
    for (const child of allChildren) {
      const match = (child.body ?? '').match(PARENT_RE);
      if (!match) continue;
      parentByChild.set(child.id, Number.parseInt(match[1], 10));
    }

    const childrenByParent = new Map();
    for (const [childId, parentId] of parentByChild) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(childId);
    }

    let alreadyLinked = 0;
    let reconciled = 0;
    let failed = 0;
    const failures = [];

    const parentEntries = Array.from(childrenByParent.entries());

    await concurrentMap(
      parentEntries,
      async ([parentId, childIds]) => {
        let parent;
        try {
          parent = await getTicket(parentId);
        } catch (err) {
          for (const childId of childIds) {
            failures.push({ parentId, childId, reason: err.message });
          }
          failed += childIds.length;
          return;
        }
        if (!parent?.nodeId) {
          for (const childId of childIds) {
            failures.push({
              parentId,
              childId,
              reason: 'parent missing nodeId',
            });
          }
          failed += childIds.length;
          return;
        }

        const linked = new Set(
          await this.getNativeSubIssues(parent.nodeId, parentId),
        );

        await concurrentMap(
          childIds,
          async (childId) => {
            if (linked.has(childId)) {
              alreadyLinked++;
              return;
            }
            let childTicket;
            try {
              childTicket = await getTicket(childId);
            } catch (err) {
              failures.push({ parentId, childId, reason: err.message });
              failed++;
              return;
            }
            if (!childTicket?.nodeId) {
              failures.push({
                parentId,
                childId,
                reason: 'child missing nodeId',
              });
              failed++;
              return;
            }
            try {
              await this.addSubIssue(parentId, childTicket.nodeId);
              reconciled++;
            } catch (err) {
              failures.push({ parentId, childId, reason: err.message });
              failed++;
            }
          },
          { concurrency: SUB_ISSUE_RECONCILE_CONCURRENCY },
        );
      },
      { concurrency: SUB_ISSUE_RECONCILE_CONCURRENCY },
    );

    return {
      totalExpected: parentByChild.size,
      alreadyLinked,
      reconciled,
      failed,
      failures,
    };
  }
}
