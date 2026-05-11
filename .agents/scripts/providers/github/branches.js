import { Logger } from '../../lib/Logger.js';
/**
 * GitHub Branches & Pull Requests.
 *
 * Pure functions over `ctx`. Cross-submodule needs (`getTicket`,
 * `addItemToProject`) flow in via `ctx.hooks` to preserve the no-sibling-
 * import discipline.
 */

/**
 * Inspect branch-protection state. A 404 means "no protection rule exists";
 * any other error propagates so the caller can distinguish "intentionally
 * unprotected" from "transport failure."
 */
export async function getBranchProtection(ctx, branch) {
  const endpoint = `/repos/${ctx.owner}/${ctx.repo}/branches/${encodeURIComponent(branch)}/protection`;
  try {
    const raw = await ctx.http.rest(endpoint);
    return { enabled: true, raw };
  } catch (err) {
    if (/failed \(404\)/.test(err?.message ?? '')) return { enabled: false };
    throw err;
  }
}

/**
 * Set (create or merge) branch protection on `branch`. Additive by default —
 * any existing protection rule's required status-check contexts are
 * preserved; only the missing entries from `contexts` are appended. When no
 * protection rule exists, a fresh one is created carrying just the
 * supplied contexts plus minimal sensible defaults (strict status checks,
 * no enforce-admins).
 *
 * Epic #1235 Story 5 — the writer now accepts opinionated overrides
 * (`enforceAdmins`, `requiredApprovingReviewCount`) so the consumer-facing
 * bootstrap can promote the framework's hands-off-pipeline stance. The
 * caller (`bootstrap/branch-protection.js`) gates behaviour-shifting
 * applications through `hitlConfirm` so this writer never silently flips
 * `enforce_admins` or the approval count under the operator. When the
 * overrides are absent (legacy callers / existing tests) the writer
 * preserves the operator's existing values exactly as before.
 *
 * Returns a summary the bootstrap orchestrator surfaces in its log:
 *   { created: boolean, added: string[], existing: string[] }
 *
 * @param {object} ctx
 * @param {string} branch
 * @param {{
 *   contexts: string[],
 *   strict?: boolean,
 *   enforceAdmins?: boolean,
 *   requiredApprovingReviewCount?: number,
 * }} opts
 */
export async function setBranchProtection(ctx, branch, opts) {
  const contexts = Array.isArray(opts?.contexts) ? opts.contexts : [];
  const strict = opts?.strict !== false;
  const endpoint = `/repos/${ctx.owner}/${ctx.repo}/branches/${encodeURIComponent(branch)}/protection`;

  const current = await getBranchProtection(ctx, branch);
  const existingContexts = current.enabled
    ? (current.raw?.required_status_checks?.contexts ?? [])
    : [];

  // Additive merge: keep every context the operator already configured and
  // append only those the prGate suite contributes that are not yet present.
  const merged = [...existingContexts];
  const added = [];
  for (const ctx_ of contexts) {
    if (!merged.includes(ctx_)) {
      merged.push(ctx_);
      added.push(ctx_);
    }
  }

  // Decide whether to override the behaviour-shifting fields. We honour
  // explicit `undefined` from legacy callers by falling through to the
  // operator's existing values (or the create-from-scratch defaults).
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
    // We do NOT clobber operator-set review flags (dismiss-stale, code-
    // owners, etc.) — only the count gets promoted.
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

  // The PUT endpoint requires every top-level field in the body — null
  // disables a section.
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

  await ctx.http.rest(endpoint, { method: 'PUT', body });

  return {
    created: !current.enabled,
    added,
    existing: existingContexts,
  };
}

/* node:coverage ignore next */
export async function createPullRequest(
  ctx,
  branchName,
  ticketId,
  baseBranch = 'main',
) {
  const ticket = await ctx.hooks.getTicket(ticketId);

  const pr = await ctx.http.rest(`/repos/${ctx.owner}/${ctx.repo}/pulls`, {
    method: 'POST',
    body: {
      title: ticket.title,
      body: `Closes #${ticketId}`,
      head: branchName,
      base: baseBranch,
    },
  });

  try {
    if (ctx.projectNumber) {
      await ctx.hooks.addItemToProject(pr.node_id);
    }
  } catch (err) {
    Logger.warn(
      `[GitHubProvider] Failed to add PR #${pr.number} to project: ${err.message}`,
    );
  }

  return { number: pr.number, url: pr.url, htmlUrl: pr.html_url };
}
