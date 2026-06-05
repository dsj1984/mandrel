/**
 * render.js — pure rendering helpers for git-cleanup (Story #2466).
 *
 * Owns the text + JSON envelope renderers and the `computeExitCode`
 * helper. Extracted verbatim from `git-cleanup.js` so every named export
 * keeps its contract.
 *
 * @module lib/orchestration/git-cleanup/phases/render
 */

const TAG = '[git-cleanup]';

/** Pure: render the dry-run plan as the operator-facing text block. */
export function renderDryRun(plan, opts = {}) {
  const { baseBranch = null } = opts;
  const lines = [
    `${TAG} DRY RUN (nothing deleted) — ${plan.candidates.length} candidate(s)`,
  ];
  if (plan.candidates.length === 0) {
    lines.push('  (no merged branches to clean up)');
  } else {
    for (const c of plan.candidates) {
      const pr = c.prNumber ? `PR #${c.prNumber}` : c.detectedBy;
      const wt = c.hasWorktree ? ` (worktree: ${c.worktreePath})` : '';
      const remoteOnly = c.localExists === false ? ' (remote-only)' : '';
      lines.push(`  • ${c.branch} — ${pr}${wt}${remoteOnly}`);
    }
  }
  const skipped = plan.skipped ?? [];
  const currentHeadSkip = skipped.find((s) => s.reason === 'current-head');
  if (currentHeadSkip) {
    const hint = baseBranch
      ? `checkout ${baseBranch} first to include this branch`
      : 'checkout the base branch first to include this branch';
    lines.push(
      `${TAG} ⓘ ${currentHeadSkip.branch} skipped — current HEAD (${hint})`,
    );
  }
  for (const skip of skipped) {
    const line = renderLatestPrSkipLine(skip);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Pure: render a single latest-PR-state skip line. Returns null when the
 * skip reason is not one of the latest-PR family — `renderDryRun` filters
 * by truthy return value so unrelated skip reasons (`protected`,
 * `current-head`, `filtered`, `not-merged`) stay quiet.
 *
 * @param {{ branch: string, reason: string, prNumber?: number, tipSha?: string, mergedSha?: string }} skip
 * @returns {string | null}
 */
export function renderLatestPrSkipLine(skip) {
  if (!skip) return null;
  const prRef = skip.prNumber ? `PR #${skip.prNumber}` : 'latest PR';
  if (skip.reason === 'latest-pr-closed-not-merged') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} was closed without merging`;
  }
  if (skip.reason === 'latest-pr-open') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} is still open`;
  }
  if (skip.reason === 'tip-diverged-from-merge') {
    const tip = skip.tipSha ? skip.tipSha.slice(0, 7) : '<unknown>';
    const merged = skip.mergedSha ? skip.mergedSha.slice(0, 7) : '<unknown>';
    return `${TAG} ⏭️  ${skip.branch} skipped — tip ${tip} diverges from ${prRef}'s merged ${merged} (post-merge force-push)`;
  }
  if (skip.reason === 'latest-pr-unknown-state') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} has an unrecognized state`;
  }
  return null;
}

/** Pure: render a per-branch execution line. */
export function renderExecutionLine(entry, scope) {
  const icon = entry.ok ? '✅' : '❌';
  const label = scope.padEnd(8);
  const tag =
    scope === 'local' || scope === 'remote' ? entry.branch : entry.path;
  const note = entry.alreadyGone
    ? ' (already gone)'
    : entry.dirty
      ? ' (forced — was dirty)'
      : '';
  return `${TAG} ${icon} ${label} ${tag}${note}`;
}

/** Pure: render the optional prune line. */
export function renderPruneLine(prune) {
  if (!prune?.attempted) return null;
  if (!prune.ok) {
    return `${TAG} ❌ prune    ${prune.remote} (${prune.stderr ?? 'failed'})`;
  }
  if (prune.pruned.length === 0) {
    return `${TAG} ✅ prune    ${prune.remote} (no stale refs)`;
  }
  const list = prune.pruned.map((n) => `${prune.remote}/${n}`).join(', ');
  return `${TAG} ✅ prune    ${prune.remote} (dropped ${prune.pruned.length} stale ref(s): ${list})`;
}

/**
 * Pure: render a single deferred-worktree line. A lock-class
 * worktree-removal failure (Windows file lock on an already-merged
 * branch's directory) is non-fatal — the branch ref was still reaped and
 * the directory is handed off to the pending-cleanup sweep. Returns the
 * operator-facing warning so the deferred signal is visible even on a
 * clean (`ok: true`) run.
 *
 * @param {{ branch?: string, path: string, pendingCleanup?: object|null }} entry
 * @returns {string}
 */
export function renderDeferredLine(entry) {
  const ref = entry.branch ? `${entry.branch} ` : '';
  const handoff = entry.pendingCleanup
    ? ' (deferred to pending-cleanup sweep)'
    : ' (deferred)';
  return `${TAG} ⚠️ deferred ${ref}${entry.path} — worktree locked; ref reaped${handoff}`;
}

/** Pure: render the trailing summary line. */
export function renderExecutionSummary(result) {
  if (!result.ok) {
    return `${TAG} ❌ ${result.failures.length} failure(s) during cleanup.`;
  }
  const prunedCount = result.prune?.pruned?.length ?? 0;
  const pruneNote =
    prunedCount > 0 ? ` + ${prunedCount} stale tracking ref(s)` : '';
  const deferredCount = result.deferred?.length ?? 0;
  const deferredNote =
    deferredCount > 0
      ? ` (${deferredCount} worktree(s) deferred to sweep)`
      : '';
  return `${TAG} ✅ Reaped ${result.local.length} local + ${result.remote.length} remote + ${result.worktrees.length} worktree(s)${pruneNote}.${deferredNote}`;
}

const EMPTY_RESULT = Object.freeze({
  worktrees: [],
  local: [],
  remote: [],
  prune: null,
  failures: [],
  deferred: [],
  ok: true,
});

/** Pure: build the JSON envelope emitted in `--json` mode. */
export function buildJsonEnvelope({
  dryRun,
  baseBranch,
  plan,
  result,
  fastForward = null,
  prune = null,
  stashes = null,
}) {
  const r = result ?? EMPTY_RESULT;
  return {
    dryRun,
    baseBranch,
    candidates: plan.candidates,
    skipped: plan.skipped,
    worktrees: r.worktrees,
    local: r.local,
    remote: r.remote,
    prune: r.prune ?? prune ?? null,
    fastForward,
    stashes,
    failures: r.failures,
    deferred: r.deferred ?? [],
    ok: r.ok,
  };
}

function legacyExitCode(plan, result) {
  if ((plan?.candidates?.length ?? 0) === 0) return 2;
  if (result && !result.ok) return 1;
  return 0;
}

/**
 * Pure: derive the process exit code. Supports both the legacy
 * `(plan, result)` signature and the new multi-phase context object.
 *
 * @param {{ candidates?: Array, branchesPlan?: object, branchesResult?: object, fastForward?: object, prune?: object, stashes?: object } | { candidates: Array }} ctx
 * @param {{ ok: boolean } | null | undefined} [legacyResult]
 * @returns {0 | 1 | 2}
 */
export function computeExitCode(ctx, legacyResult) {
  if (legacyResult !== undefined || Array.isArray(ctx?.candidates)) {
    return legacyExitCode(ctx, legacyResult);
  }
  const {
    branchesPlan = null,
    branchesResult = null,
    fastForward = null,
    prune = null,
    stashes = null,
  } = ctx ?? {};
  const anyFailure =
    (branchesResult && !branchesResult.ok) ||
    (fastForward && !fastForward.ok) ||
    (prune && !prune.ok) ||
    (stashes && !stashes.ok);
  if (anyFailure) return 1;
  const anyWork =
    (branchesPlan && branchesPlan.candidates.length > 0) ||
    fastForward?.applied ||
    (prune && (prune.pruned?.length ?? 0) > 0) ||
    (stashes &&
      (stashes.actions ?? []).some((a) => a.action === 'drop' && a.dropped));
  if (!anyWork) return 2;
  return 0;
}
