/**
 * GitHub Provider — CommentGateway.
 *
 * Owns issue-comment CRUD against `/repos/{owner}/{repo}/issues/.../comments`.
 * `postComment` is the structured-comment writer (it prepends the visible
 * type-badge); the `<!-- ap:structured-comment ... -->` marker is added by
 * the upstream `upsertStructuredComment` ticketing helper before the body
 * lands here.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2480. Public
 * surface on `GitHubProvider` is unchanged — `postComment`,
 * `getRecentComments`, `getTicketComments`, and `deleteComment` all
 * delegate here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { withTransientRetry } from './errors.js';
import {
  defaultRetryWarn,
  paginateRest,
  parseApiJson,
} from './request-helpers.js';

// Structured-comment badge — preserved verbatim from the legacy
// `./github/comments.js`. The upstream `upsertStructuredComment` ticketing
// helper prepends the `<!-- ap:structured-comment ... -->` marker before
// the body reaches `postComment`; this badge is the visible header
// consumers (Slack notifier, dashboard) grep for. Keeping the emoji + bold
// marker stable is what makes the round-trip with structured-comment
// detection work across the rewrite.
const TYPE_BADGES = {
  progress: '🔄 **Progress**',
  friction: '⚠️ **Friction**',
  notification: '📢 **Notification**',
};

export class CommentGateway {
  /**
   * @param {{
   *   gh: object,
   *   owner: string,
   *   repo: string,
   *   hooks?: { invalidateTicket?: (id: number) => void },
   * }} deps
   */
  constructor({ gh, owner, repo, hooks = {} } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
    this._hooks = hooks;
  }

  /**
   * Recent comments across all issues in the repo (sorted newest first).
   *
   * @field-manifest /repos/{owner}/{repo}/issues/comments?sort=created:
   *                 id, body, created_at, user, issue_url
   */
  async getRecentComments(limit = 100) {
    const result = await withTransientRetry(
      () =>
        this._gh.api({
          method: 'GET',
          endpoint: `/repos/${this.owner}/${this.repo}/issues/comments?sort=created&direction=desc&per_page=${limit}`,
        }),
      { label: 'getRecentComments', onRetry: defaultRetryWarn },
    );
    return parseApiJson(result) ?? [];
  }

  /**
   * All comments on a single ticket. Used by the upstream
   * `findStructuredComment` ticketing helper, which greps each comment
   * body for the `<!-- ap:structured-comment type="..." -->` marker — so
   * the per-comment `body` field must round-trip verbatim.
   *
   * @field-manifest /repos/{owner}/{repo}/issues/{n}/comments:
   *                 id, body, created_at, user
   */
  async getTicketComments(ticketId) {
    return paginateRest(
      this._gh,
      `/repos/${this.owner}/${this.repo}/issues/${ticketId}/comments`,
    );
  }

  /**
   * Delete a comment by id. Called by `upsertStructuredComment` before
   * posting the replacement, so the in-place semantics hold even though
   * the underlying GitHub API has no native upsert.
   */
  async deleteComment(commentId) {
    await this._gh.api({
      method: 'DELETE',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`,
    });
  }

  /**
   * Post a comment on an issue. When `payload.type` matches a known
   * structured-comment kind, prepend the visible type-badge so operators
   * see the same header the old client produced.
   *
   * Accepts either `{ body, type }` (canonical) or a bare string (legacy
   * shape exercised by `tests/lib/github-provider.test.js` and a handful
   * of direct callers under `notify.js`).
   *
   * @field-manifest POST /repos/{owner}/{repo}/issues/{n}/comments:
   *                 id (returned for the caller's `commentId`)
   */
  async postComment(ticketId, payload) {
    const normalized =
      typeof payload === 'string' ? { body: payload } : (payload ?? {});
    const badge = TYPE_BADGES[normalized.type] ?? '';
    const body = badge ? `${badge}\n\n${normalized.body}` : normalized.body;

    const result = await this._gh.api({
      method: 'POST',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/${ticketId}/comments`,
      body: { body },
    });
    const comment = parseApiJson(result);
    // Posting a comment mutates the ticket's comment thread. Invalidate so
    // the next `getTicketComments` / `getTicket` reflects the new comment.
    if (typeof this._hooks.invalidateTicket === 'function') {
      this._hooks.invalidateTicket(ticketId);
    }
    return { commentId: comment.id };
  }
}
