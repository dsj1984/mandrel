/**
 * phases/dashboard-refresh.js — retired dispatch-manifest refresh seam.
 *
 * The Stage 5 hard cutover deletes the dispatcher/manifest surface; keep this
 * phase as a no-op so any still-wired post-merge pipeline can drain safely.
 */

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function dashboardRefreshPhase(ctx) {
  const { skipDashboard, progress } = ctx;
  const log = reapPhaseLogger(progress);
  if (skipDashboard) {
    log('DASHBOARD', 'Skipping dashboard refresh (--skip-dashboard flag set)');
    return false;
  }
  log('DASHBOARD', 'Dispatch manifest refresh retired; no dashboard updated.');
  return false;
}
