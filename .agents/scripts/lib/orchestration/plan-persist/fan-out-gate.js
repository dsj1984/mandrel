/**
 * Fan-out / soft-conflict gates used by plan-persist (extracted from the
 * retired epic-plan-decompose persist phase in Stage 5).
 *
 * @module lib/orchestration/plan-persist/fan-out-gate
 */

import { Logger } from '../../Logger.js';
import {
  renderFanOutEvidence,
  renderFanOutRemedy,
  renderHardConflictError,
} from '../ticket-validator-conflicts.js';

/**
 * @param {object[]} findings
 * @param {boolean} allowLargeFanOut
 * @param {string} [tag]
 */
export function enforceFanOutGate(
  findings,
  allowLargeFanOut,
  tag = 'plan-persist',
) {
  const fanOut = (findings ?? []).filter((f) => f.kind === 'fan-out-warning');
  if (fanOut.length === 0) return;
  if (allowLargeFanOut) {
    for (const f of fanOut) {
      Logger.warn(
        `[${tag}] Persisting a large-fan-out deletion: ` +
          `Story "${f.storySlug}" deletes "${f.path}" with ${f.callSiteCount} ` +
          `importer(s) (threshold ${f.threshold}). Operator override --allow-large-fan-out.` +
          renderFanOutEvidence(f),
      );
    }
    return;
  }
  const lines = fanOut
    .map(
      (f) =>
        `  - Story "${f.storySlug}" deletes "${f.path}" — ` +
        `${f.callSiteCount} importer(s) (threshold ${f.threshold})` +
        renderFanOutEvidence(f),
    )
    .join('\n');
  // Each finding carries its own remedy — a rename-shaped deletion has no
  // subsystems to split across, so a blanket "split it up" footer would be
  // wrong advice for it (Story #4547).
  const remedies = [...new Set(fanOut.map((f) => renderFanOutRemedy(f)))];
  throw new Error(
    `[${tag}] ${fanOut.length} Task(s) declare large-fan-out deletions:\n${lines}\n\n` +
      remedies.join('\n\n'),
  );
}

/**
 * @param {object[]} findings
 * @param {string} [tag]
 */
export function surfaceSoftConflictFindings(findings, tag = 'plan-persist') {
  const soft = (findings ?? []).filter(
    (f) => f?.severity === 'soft' && f?.kind !== 'fan-out-warning',
  );
  if (soft.length === 0) return;
  Logger.warn(
    `[${tag}] ${soft.length} soft cross-Story conflict finding(s) — review before approving the plan:`,
  );
  for (const finding of soft) {
    Logger.warn(`[${tag}] soft conflict: ${renderHardConflictError(finding)}`);
  }
}
