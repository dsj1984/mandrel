/**
 * GitHub Provider — post-create "add issue to the Projects V2 board" step.
 * Needed because GitHub's auto-add workflow is off on fresh boards and can't
 * be enabled via API. Never throws (issue creation survives a board failure)
 * and is idempotent (the mutation returns an existing item). A token without
 * the `project` scope reports `reason: 'insufficient-scope'` and trips the
 * warn-once latch rather than warning per issue.
 */

import { Logger } from '../../lib/Logger.js';
import { boardScopeFailure } from '../../lib/orchestration/board-access-latch.js';

/**
 * No project number → no-op without network.
 *
 * @param {{
 *   nodeId: string|null|undefined,
 *   issueNumber?: number|null,
 *   getProjectNumber?: () => number|null,
 *   addItemToProject?: (nodeId: string) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ added: boolean, reason?: string, scope?: string }>}
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
    const scopeFailure = boardScopeFailure(err);
    if (scopeFailure) return { added: false, ...scopeFailure };
    warnAddFailure(err, issueNumber, nodeId);
    return { added: false, reason: 'error' };
  }
}

function warnAddFailure(err, issueNumber, nodeId) {
  const label =
    issueNumber !== null && issueNumber !== undefined
      ? `Issue #${issueNumber}`
      : `issue ${nodeId}`;
  Logger.warn(
    `[GitHubProvider] Failed to add ${label} to project: ${err.message}`,
  );
}
