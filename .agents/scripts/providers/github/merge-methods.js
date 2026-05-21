/**
 * GitHub Provider — MergeMethodsGateway.
 *
 * Owns `getMergeMethods` / `setMergeMethods` against `/repos/{owner}/{repo}`.
 * The narrow field list (`MERGE_METHOD_FIELDS`) keeps `getMergeMethods` and
 * `setMergeMethods` aligned on which keys they mirror — operators may have
 * tuned other repo flags and we deliberately do not surface them through
 * this interface.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2479. Public
 * surface on `GitHubProvider` is unchanged — both merge-method methods
 * delegate here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { parseApiJson } from './request-helpers.js';

/**
 * Fields the merge-method bootstrap reads/writes.
 */
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
   * Read the repo's current merge-method-related settings. Returns only
   * the fields the bootstrap cares about so the diff layer can compare
   * apples to apples regardless of what other knobs the repo exposes.
   *
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
   * PATCH the repo with the supplied merge-method settings. Sparse body —
   * only the supplied fields are sent / touched.
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
