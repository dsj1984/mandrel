/**
 * diagnostics.js — partial-failure diagnostics for epic-plan-decompose
 * (Story #2466).
 *
 * `reportPartialFailure({ epicId, provider, err })` is invoked from the
 * CLI shell after `runDecomposePhase` throws — typically GitHub
 * secondary-RL after dozens of issue creations. The function is
 * intentionally defensive: never throws, never eclipses the original
 * failure, and always emits the "to resume" hint as the final lines.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/diagnostics
 */

import { Logger } from '../../../Logger.js';
import { TYPE_LABELS } from '../../../label-constants.js';

/**
 * Count open child tickets under the Epic without distinguishing by
 * type. Under the 2-tier hierarchy (Epic → Story), child
 * tickets are always Stories.
 */
async function emitOpenChildrenDiagnostic(provider, epicId) {
  if (typeof provider.getSubTickets !== 'function') return;
  // Story #3455 — scope to the Epic's sub-issue graph instead of
  // `getTickets`'s repo-wide `state=all` scan. The diagnostic explicitly
  // counts `state !== 'closed'`, so the scoped fetch (which still surfaces
  // closed children) yields the same open-child count without paging
  // every issue in the repo.
  const existing = await provider.getSubTickets(epicId);
  const childTypes = [TYPE_LABELS.STORY];
  const created = (existing || []).filter(
    (t) =>
      (t.labels || []).some((l) => childTypes.includes(l)) &&
      t.state !== 'closed',
  ).length;
  Logger.error(
    `[epic-plan-decompose] Children currently open under Epic: ${created}`,
  );
}

async function emitLifecycleLabelDiagnostic(provider, epicId) {
  if (typeof provider.getEpic !== 'function') return;
  const epic = await provider.getEpic(epicId);
  const lifecycleLabel =
    (epic?.labels || []).find((l) => l.startsWith('agent::')) ?? 'unknown';
  Logger.error(
    `[epic-plan-decompose] Epic #${epicId} current label: ${lifecycleLabel}`,
  );
}

/**
 * Best-effort recovery diagnostics. Never throws.
 */
export async function reportPartialFailure({ epicId, provider, err }) {
  Logger.error('');
  Logger.error('[epic-plan-decompose] ❌ Decompose phase aborted.');
  Logger.error(`[epic-plan-decompose] Reason: ${err?.message ?? err}`);
  try {
    await emitLifecycleLabelDiagnostic(provider, epicId);
    await emitOpenChildrenDiagnostic(provider, epicId);
  } catch (probeErr) {
    Logger.error(
      `[epic-plan-decompose] (diagnostics probe failed: ${probeErr.message})`,
    );
  }
  Logger.error('');
  Logger.error('[epic-plan-decompose] To resume from the partial backlog:');
  Logger.error(
    `[epic-plan-decompose]   node .agents/scripts/epic-plan-decompose.js --epic ${epicId} --tickets <tickets-file> --resume`,
  );
  Logger.error('');
}
