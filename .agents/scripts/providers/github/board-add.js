/**
 * GitHub Provider — shared "add issue to the Projects V2 board" helper.
 *
 * Story #3822 — single source of truth for the post-create board-add
 * step. Issues created through any create path (`createTicket`,
 * `createIssue` — which backs `/plan` persist and the `/plan`
 * Phase 4 Epic open) must land on the configured Projects V2 board
 * without relying on GitHub's "Auto-add to project" built-in workflow,
 * which is off by default on fresh boards and cannot be enabled via API.
 *
 * Contract:
 *   - **No-op when no project number resolves** — returns
 *     `{ added: false, reason: 'no-project-number' }` without touching
 *     the network.
 *   - **Non-fatal** — a failed add warns and returns
 *     `{ added: false, reason: 'error' }`; it never throws, so issue
 *     creation always survives a board hiccup.
 *   - **Idempotent** — the underlying `addProjectV2ItemById` mutation
 *     returns the existing item when the issue is already on the board,
 *     so re-running the helper is safe.
 */

import { Logger } from '../../lib/Logger.js';

/**
 * Add an issue (by GraphQL `node_id`) to the configured Projects V2
 * board.
 *
 * @param {{
 *   nodeId: string|null|undefined,
 *   issueNumber?: number|null,
 *   getProjectNumber?: () => number|null,
 *   addItemToProject?: (nodeId: string) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ added: boolean, reason?: string }>}
 */
export async function addIssueToBoard({
  nodeId,
  issueNumber = null,
  getProjectNumber,
  addItemToProject,
}) {
  const projectNumber =
    typeof getProjectNumber === 'function' ? getProjectNumber() : null;
  if (!projectNumber) return { added: false, reason: 'no-project-number' };
  if (typeof addItemToProject !== 'function') {
    return { added: false, reason: 'no-add-hook' };
  }
  if (!nodeId) return { added: false, reason: 'no-node-id' };
  try {
    await addItemToProject(nodeId);
    return { added: true };
  } catch (err) {
    const label =
      issueNumber !== null && issueNumber !== undefined
        ? `Issue #${issueNumber}`
        : `issue ${nodeId}`;
    Logger.warn(
      `[GitHubProvider] Failed to add ${label} to project: ${err.message}`,
    );
    return { added: false, reason: 'error' };
  }
}
