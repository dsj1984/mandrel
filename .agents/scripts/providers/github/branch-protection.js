/**
 * GitHub Provider — BranchProtectionGateway, plus the shared
 * `isNotFoundError` predicate.
 */

import { withTransientRetry } from './errors.js';
import { parseApiJson } from './request-helpers.js';

/**
 * 404 across `GhNotFoundError`, `HTTP 404`/"not found" stderr, and the
 * legacy `failed (404)` message shape some callers still throw.
 */
export function isNotFoundError(err) {
  if (!err) return false;
  if (err.name === 'GhNotFoundError') return true;
  const message = err?.message ?? '';
  const stderr = err?.stderr ?? '';
  return (
    /failed \(404\)/.test(message) ||
    /HTTP 404/i.test(stderr) ||
    /HTTP 404/i.test(message) ||
    /\bnot found\b/i.test(stderr) ||
    err?.code === 404
  );
}

export class BranchProtectionGateway {
  /**
   * @param {{ gh: object, owner: string, repo: string }} deps
   */
  constructor({ gh, owner, repo } = {}) {
    this._gh = gh;
    this.owner = owner;
    this.repo = repo;
  }

  /**
   * 404 → `{ enabled: false }`; other errors propagate so "unprotected" and
   * "transport failure" stay distinct.
   *
   * @field-manifest GET /repos/{owner}/{repo}/branches/{branch}/protection:
   *                 required_status_checks, enforce_admins,
   *                 required_pull_request_reviews, restrictions
   */
  async getBranchProtection(branch) {
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}/protection`;
    try {
      const result = await withTransientRetry(() =>
        this._gh.api({ method: 'GET', endpoint }),
      );
      const raw = parseApiJson(result) ?? {};
      return { enabled: true, raw };
    } catch (err) {
      if (isNotFoundError(err)) return { enabled: false };
      throw err;
    }
  }

  /**
   * Create or merge protection. `contexts` are added, never removed; other
   * operator-tuned values are kept unless `enforceAdmins` /
   * `requiredApprovingReviewCount` explicitly override them.
   *
   * Returns `{ created, added, existing }`.
   *
   * @field-manifest PUT /repos/{owner}/{repo}/branches/{branch}/protection:
   *                 required_status_checks, enforce_admins,
   *                 required_pull_request_reviews, restrictions
   *
   * @param {string} branch
   * @param {{
   *   contexts: string[],
   *   strict?: boolean,
   *   enforceAdmins?: boolean,
   *   requiredApprovingReviewCount?: number,
   * }} opts
   */
  async setBranchProtection(branch, opts) {
    const contexts = Array.isArray(opts?.contexts) ? opts.contexts : [];
    const strict = opts?.strict !== false;
    const endpoint = `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}/protection`;

    const current = await this.getBranchProtection(branch);
    const existingContexts = current.enabled
      ? (current.raw?.required_status_checks?.contexts ?? [])
      : [];

    const merged = [...existingContexts];
    const added = [];
    for (const ctx of contexts) {
      if (!merged.includes(ctx)) {
        merged.push(ctx);
        added.push(ctx);
      }
    }

    const overrideEnforceAdmins = typeof opts?.enforceAdmins === 'boolean';
    const overrideApprovalCount =
      typeof opts?.requiredApprovingReviewCount === 'number';

    let enforceAdmins;
    if (overrideEnforceAdmins) {
      enforceAdmins = opts.enforceAdmins;
    } else if (current.enabled) {
      enforceAdmins = current.raw?.enforce_admins?.enabled ?? false;
    } else {
      enforceAdmins = false;
    }

    let prReviews;
    if (overrideApprovalCount) {
      // Keep operator review flags; only the count is promoted.
      const baseReviews = current.enabled
        ? (current.raw?.required_pull_request_reviews ?? {})
        : {};
      prReviews = {
        ...baseReviews,
        required_approving_review_count: opts.requiredApprovingReviewCount,
      };
    } else {
      prReviews = current.enabled
        ? (current.raw?.required_pull_request_reviews ?? null)
        : null;
    }

    // PUT requires every top-level field; null disables a section.
    const body = current.enabled
      ? {
          required_status_checks: {
            strict: current.raw?.required_status_checks?.strict ?? strict,
            contexts: merged,
          },
          enforce_admins: enforceAdmins,
          required_pull_request_reviews: prReviews,
          restrictions: current.raw?.restrictions ?? null,
        }
      : {
          required_status_checks: { strict, contexts: merged },
          enforce_admins: enforceAdmins,
          required_pull_request_reviews: prReviews,
          restrictions: null,
        };

    await withTransientRetry(() =>
      this._gh.api({ method: 'PUT', endpoint, body }),
    );

    return {
      created: !current.enabled,
      added,
      existing: existingContexts,
    };
  }
}
