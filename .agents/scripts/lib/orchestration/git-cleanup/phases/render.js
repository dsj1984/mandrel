/**
 * Pure text / JSON renderers and exit-code derivation for git-cleanup.
 *
 * @module lib/orchestration/git-cleanup/phases/render
 */

const TAG = '[git-cleanup]';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string|null|undefined} iso
 * @param {number} now
 * @returns {string}
 */
function formatCommitAge(iso, now) {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const days = Math.max(0, Math.floor((now - then) / DAY_MS));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/**
 * A remote-only skip is marked `(remote-only)` because its short name has
 * no local ref behind it.
 *
 * @param {{ branch: string, reason: string, lastCommitAt?: string|null, localExists?: boolean }} skip
 * @param {{ now?: number }} [opts]
 * @returns {string | null}
 */
export function renderNotMergedSkipLine(skip, opts = {}) {
  if (!skip || skip.reason !== 'not-merged') return null;
  const now = opts.now ?? Date.now();
  const age = formatCommitAge(skip.lastCommitAt, now);
  const scope = skip.localExists === false ? ' (remote-only)' : '';
  return `${TAG} ⏭️  ${skip.branch}${scope} skipped — not merged (last commit: ${age})`;
}

function contentMergedNote(candidate) {
  return candidate.detectedBy === 'content-merged'
    ? ' (weaker signal — verify before deleting)'
    : '';
}

function behindMergeNote(candidate) {
  return candidate.behindMerge
    ? ' (tip behind the merged head — content already landed)'
    : '';
}

function candidateNotes(candidate) {
  return `${contentMergedNote(candidate)}${behindMergeNote(candidate)}`;
}

function renderCandidateRow(c) {
  const pr = c.prNumber ? `PR #${c.prNumber}` : c.detectedBy;
  const wt = c.hasWorktree ? ` (worktree: ${c.worktreePath})` : '';
  const remoteOnly = c.localExists === false ? ' (remote-only)' : '';
  return `  • ${c.branch} — ${pr}${wt}${remoteOnly}${candidateNotes(c)}`;
}

/**
 * Prefer {@link renderCandidateList}, which derives `execute` from the CLI
 * options.
 *
 * @param {{ candidates: Array, skipped?: Array, ghDegraded?: boolean }} plan
 * @param {{ baseBranch?: string|null, now?: number, execute?: boolean }} [opts]
 * @returns {string[]}
 */
export function renderDryRun(plan, opts = {}) {
  const { baseBranch = null, now, execute = false } = opts;
  const count = plan.candidates.length;
  const lines = [
    execute
      ? `${TAG} EXECUTE — ${count} candidate(s) to reap`
      : `${TAG} DRY RUN (nothing deleted) — ${count} candidate(s)`,
  ];
  if (plan.candidates.length === 0) {
    lines.push('  (no merged branches to clean up)');
  } else {
    for (const c of plan.candidates) lines.push(renderCandidateRow(c));
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
  for (const skip of skipped) {
    const line = renderNotMergedSkipLine(skip, { now });
    if (line) lines.push(line);
  }
  if (plan.ghDegraded) {
    lines.push(
      `${TAG} ⚠️ gh probe degraded — candidates rely on git-only signals (ancestry + content-equivalence) for this run`,
    );
  }
  return lines;
}

/**
 * Takes the whole CLI option bag — the same `dryRun` the reap path reads —
 * so an `--execute` run can never announce itself as a dry run.
 *
 * @param {object} args
 * @param {{ candidates: Array, skipped?: Array }} args.plan
 * @param {{ dryRun?: boolean }} args.opts
 * @param {string|null} [args.baseBranch]
 * @returns {string[]}
 */
export function renderCandidateList({ plan, opts = {}, baseBranch = null }) {
  return renderDryRun(plan, { baseBranch, execute: !opts.dryRun });
}

function shortShaPair(skip) {
  return {
    tip: skip.tipSha ? skip.tipSha.slice(0, 7) : '<unknown>',
    merged: skip.mergedSha ? skip.mergedSha.slice(0, 7) : '<unknown>',
  };
}

/**
 * `null` for any reason outside the latest-PR / merged-tip family.
 *
 * @param {{ branch: string, reason: string, prNumber?: number, tipSha?: string, mergedSha?: string, detail?: string }} skip
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
    const { tip, merged } = shortShaPair(skip);
    return (
      `${TAG} ⏭️  ${skip.branch} skipped — tip ${tip} diverges from ${prRef}'s merged ${merged} (post-merge force-push); ` +
      `resolve by deleting manually (\`git branch -D ${skip.branch}\`) or pushing the follow-up commit`
    );
  }
  if (skip.reason === 'unverifiable') {
    const { tip, merged } = shortShaPair(skip);
    return (
      `${TAG} ⏭️  ${skip.branch} skipped — cannot verify tip ${tip} against ${prRef}'s merged ${merged}${skip.detail ? `: ${skip.detail}` : ''}; ` +
      `fetch the missing commit or inspect the branch by hand before deleting it`
    );
  }
  if (skip.reason === 'latest-pr-unknown-state') {
    return `${TAG} ⏭️  ${skip.branch} skipped — ${prRef} has an unrecognized state`;
  }
  return null;
}

/** Next step per withheld-delete reason, so a withhold never reads as an unexplained refusal. */
const WITHHELD_HINTS = {
  'weak-signal-needs-confirmation':
    'detected only by content-equivalence; re-run interactively or pass --include-content-merged',
};

/** A `skipped` entry was withheld, not attempted — never render it as ✅. */
export function renderExecutionLine(entry, scope) {
  const label = scope.padEnd(8);
  const tagName =
    scope === 'local' || scope === 'remote' ? entry.branch : entry.path;
  if (entry.skipped) {
    const hint = WITHHELD_HINTS[entry.reason];
    return `${TAG} ⏭️  ${label} ${tagName} — withheld${hint ? ` (${hint})` : ` (${entry.reason})`}`;
  }
  const icon = entry.ok ? '✅' : '❌';
  const note = entry.alreadyGone
    ? ' (already gone)'
    : entry.dirty
      ? ' (forced — was dirty)'
      : '';
  return `${TAG} ${icon} ${label} ${tagName}${note}`;
}

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
 * A lock-class worktree removal failure (Windows file lock) is non-fatal:
 * the ref was reaped and the directory deferred. Shown even on an `ok` run.
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
  // Withheld remote entries were never deleted; don't count them.
  const remoteDeleted = result.remote.filter((r) => !r.skipped).length;
  const withheldCount = result.remote.length - remoteDeleted;
  const withheldNote =
    withheldCount > 0
      ? ` (${withheldCount} remote delete(s) withheld — weaker signal)`
      : '';
  return `${TAG} ✅ Reaped ${result.local.length} local + ${remoteDeleted} remote + ${result.worktrees.length} worktree(s)${pruneNote}.${deferredNote}${withheldNote}`;
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
    ghDegraded: plan.ghDegraded ?? false,
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
 * Accepts `(plan, result)` or a multi-phase context object.
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
