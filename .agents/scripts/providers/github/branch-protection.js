/**
 * GitHub Provider — BranchProtectionGateway.
 *
 * Owns `getBranchProtection` / `setBranchProtection` against
 * `/repos/{owner}/{repo}/branches/{branch}/protection`. Also exports the
 * shared `isNotFoundError` predicate that `branchExists` reuses on the
 * parent provider — keeping the 404-classification logic single-sourced.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2478. Public
 * surface on `GitHubProvider` is unchanged — both branch-protection
 * methods delegate here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { withTransientRetry } from './errors.js';
import { parseApiJson } from './request-helpers.js';

/**
 * Detect a 404 across both error surfaces:
 *
 *   - `gh-exec`-classified errors land as `GhNotFoundError`
 *     (`err.name === 'GhNotFoundError'`); the underlying stderr may carry
 *     "HTTP 404" / "not found" / "Resource not accessible".
 *   - The legacy `GithubHttpClient` produced `Error('... failed (404): ...')`
 *     strings; some tests still throw those (and submodules that still
 *     delegate to the old transport do too).
 *
 * Used by `getBranchProtection` (distinguishes "no rule exists" from
 * transport failures) and `branchExists` on the parent provider.
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
    // gh-exec carries the failing code on err.code for the test mock path.
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
   * Inspect branch-protection state. A 404 means "no protection rule
   * exists"; any other error propagates so the caller can distinguish
   * "intentionally unprotected" from "transport failure."
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
   * Set (create or merge) branch protection on `branch`. Additive on the
   * required-status-check `contexts` list (preserves operator-added
   * contexts), and honours optional behaviour-shifting overrides
   * (`enforceAdmins`, `requiredApprovingReviewCount`) so the consumer-
   * facing bootstrap can promote the framework's hands-off-pipeline
   * stance without silently flipping operator-tuned values.
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

    // Additive merge: keep every context the operator already configured
    // and append only those the prGate suite contributes that are not yet
    // present.
    const merged = [...existingContexts];
    const added = [];
    for (const ctx of contexts) {
      if (!merged.includes(ctx)) {
        merged.push(ctx);
        added.push(ctx);
      }
    }

    // Decide whether to override behaviour-shifting fields. Explicit
    // `undefined` from legacy callers falls through to the operator's
    // existing values (or the create-from-scratch defaults).
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
      // Preserve operator-set review flags (dismiss-stale, code-owners,
      // etc.) — only the count is promoted.
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

    // PUT requires every top-level field in the body — null disables a
    // section.
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
