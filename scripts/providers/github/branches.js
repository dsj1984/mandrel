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
