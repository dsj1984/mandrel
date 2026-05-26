/**
 * phases/dashboard-refresh.js — regenerate the dispatch manifest after
 * a Story merges into its Epic branch. Honors `--skip-dashboard` so
 * operators running an out-of-band close can suppress the I/O.
 */

import { generateAndSaveManifest } from '../../../../dispatcher.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function dashboardRefreshPhase(ctx) {
  const {
    epicId,
    provider,
    skipDashboard,
    progress,
    generateManifestFn = generateAndSaveManifest,
  } = ctx;
  const log = reapPhaseLogger(progress);
  if (skipDashboard) {
    log(
      'DASHBOARD',
      '⏭️ Skipping dashboard refresh (--skip-dashboard flag set)',
    );
    return false;
  }
  log('DASHBOARD', 'Regenerating dispatch manifest...');
  await generateManifestFn(epicId, true, { provider });
  log('DASHBOARD', '✅ Dashboard manifest updated (temp/)');
  return true;
}
