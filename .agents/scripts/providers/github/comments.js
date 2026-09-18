/**
 * GitHub Provider — CommentGateway: issue-comment CRUD. The structured
 * marker is added upstream by `upsertStructuredComment`; this layer adds only
 * the visible type badge.
 */

import { paginateRest, parseApiJson } from './request-helpers.js';

// Visible headers downstream consumers grep for — keep them byte-stable.
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
   * `body` must round-trip verbatim: structured-comment lookup greps it.
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

  async deleteComment(commentId) {
    await this._gh.api({
      method: 'DELETE',
      endpoint: `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`,
    });
  }

  /**
   * Accepts `{ body, type }` or a bare string; a known `type` gets its badge
   * prepended.
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
    if (typeof this._hooks.invalidateTicket === 'function') {
      this._hooks.invalidateTicket(ticketId);
    }
    return { commentId: comment.id };
  }
}
