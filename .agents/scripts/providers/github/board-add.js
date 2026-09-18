/**
 * GitHub Provider — post-create "add issue to the Projects V2 board" step.
 * Needed because GitHub's auto-add workflow is off on fresh boards and can't
 * be enabled via API. Never throws (issue creation survives a board failure)
 * and is idempotent (the mutation returns an existing item).
 */

import { Logger } from '../../lib/Logger.js';

/**
 * No project number → no-op without network.
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
