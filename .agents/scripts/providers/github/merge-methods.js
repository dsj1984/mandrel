/**
 * GitHub Provider — MergeMethodsGateway. Reads and writes only
 * `MERGE_METHOD_FIELDS`, leaving other operator-tuned repo flags alone.
 */

import { parseApiJson } from './request-helpers.js';

export const MERGE_METHOD_FIELDS = [
  'allow_squash_merge',
  'allow_rebase_merge',
  'allow_merge_commit',
  'allow_auto_merge',
  'delete_branch_on_merge',
];

export class MergeMethodsGateway {
  /**
   * @param {{ gh: object, owner: string, repo: string }} deps
   */
  constructor({ gh, owner, repo } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * @field-manifest GET /repos/{owner}/{repo}: allow_squash_merge,
   *                 allow_rebase_merge, allow_merge_commit,
   *                 allow_auto_merge, delete_branch_on_merge
   */
  async getMergeMethods() {
    const result = await this._gh.api({
      method: 'GET',
      endpoint: `/repos/${this.owner}/${this.repo}`,
    });
    const raw = parseApiJson(result) ?? {};
    const out = {};
    for (const field of MERGE_METHOD_FIELDS) {
      if (Object.hasOwn(raw, field)) out[field] = raw[field];
    }
    return out;
  }

  /**
   * Sparse PATCH: only supplied fields are sent.
   *
   * @field-manifest PATCH /repos/{owner}/{repo}: allow_squash_merge,
   *                 allow_rebase_merge, allow_merge_commit,
   *                 allow_auto_merge, delete_branch_on_merge
   */
  async setMergeMethods(settings) {
    const body = {};
    for (const field of MERGE_METHOD_FIELDS) {
      if (Object.hasOwn(settings, field)) body[field] = settings[field];
    }
    await this._gh.api({
      method: 'PATCH',
      endpoint: `/repos/${this.owner}/${this.repo}`,
      body,
    });
    return { patched: Object.keys(body) };
  }
}
