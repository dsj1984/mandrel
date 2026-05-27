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
 * type. 3-tier (Epic #3078) Epics have only Feature + Story children;
 * 4-tier Epics also have Tasks. Both shapes route through the same
 * total — diagnostics intentionally never warns about "missing Tasks"
 * because zero Tasks is a valid 3-tier outcome.
 */
async function emitOpenChildrenDiagnostic(provider, epicId) {
  if (typeof provider.getTickets !== 'function') return;
  const existing = await provider.getTickets(epicId);
  const childTypes = [TYPE_LABELS.FEATURE, TYPE_LABELS.STORY, 'type::task'];
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
