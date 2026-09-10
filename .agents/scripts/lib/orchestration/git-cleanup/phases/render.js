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
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: format a last-commit ISO timestamp as a short relative-age string
 * for the `not-merged` skip-visibility line (Story #4395). Returns
 * `'unknown'` when `iso` is missing or unparseable — a branch whose commit
 * date could not be resolved (e.g. `gh`-degraded run, deleted ref) still
 * gets a line, just without an age.
 *
 * @param {string|null|undefined} iso
 * @param {number} now  Epoch-ms reference clock (injectable for tests).
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
 * Pure: render a single `not-merged` skip-visibility line (Story #4395).
 * `renderDryRun` previously kept `not-merged` survivors silent; this
 * surfaces each one with its last-commit age so the operator can see why
 * a leftover branch isn't reaped instead of hunting for it by hand.
 *
 * Story #5188 routes the remote-only walk's genuinely-unmerged survivors
 * through here too. A `localExists: false` skip is marked `(remote-only)`
 * — the same marker {@link renderCandidateRow} puts on a remote-only
 * candidate — because the short name it prints has no local ref behind
 * it: without the marker the operator reads the line as a local branch and
 * hunts for a ref that `git branch` will never list.
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

/**
 * Pure: render a single content-merged candidate annotation line
 * (Story #4395). `content-merged` is a weaker signal than a merged PR or
 * git ancestry — this note lets the operator tell it apart in both the
 * dry-run list and the confirmation prompt.
 */
function contentMergedNote(candidate) {
  return candidate.detectedBy === 'content-merged'
    ? ' (weaker signal — verify before deleting)'
    : '';
}

/**
 * Pure: render a single behind-the-merged-head candidate annotation.
 *
 * A branch whose tip is a strict ancestor of its merged PR head is a
 * stale pre-merge snapshot — reapable, because every commit on it landed
 * with the PR, but reapable for a different reason than a branch whose
 * tip *matches* the merged head. It used to be skipped outright as a
 * post-merge force-push; the note keeps the two visibly distinct in the
 * dry-run list and the confirmation prompt so the operator can see why a
 * branch that is not at the merged head is nonetheless offered.
 */
function behindMergeNote(candidate) {
  return candidate.behindMerge
    ? ' (tip behind the merged head — content already landed)'
    : '';
}

/** Pure: every provenance annotation a candidate row carries, in order. */
function candidateNotes(candidate) {
  return `${contentMergedNote(candidate)}${behindMergeNote(candidate)}`;
}

/**
 * Pure: one candidate row — its detection provenance, worktree, locality
 * and annotations. Split out of {@link renderDryRun} so that renderer
 * stays a loop over rows rather than growing a fourth inline ternary
 * every time a candidate gains a new dimension.
 */
function renderCandidateRow(c) {
  const pr = c.prNumber ? `PR #${c.prNumber}` : c.detectedBy;
  const wt = c.hasWorktree ? ` (worktree: ${c.worktreePath})` : '';
  const remoteOnly = c.localExists === false ? ' (remote-only)' : '';
  return `  • ${c.branch} — ${pr}${wt}${remoteOnly}${candidateNotes(c)}`;
}

/**
 * Pure: render the branch-phase candidate list as the operator-facing text
 * block.
 *
 * The header states the run mode: `execute` opts into the reap wording and
 * defaults to `false`, so a caller that forgets it still gets the harmless
 * preview line. Prefer {@link renderCandidateList}, which derives the mode
 * from the phase's own CLI options rather than making the caller restate
 * it — the header used to be hardcoded to the preview wording, so an
 * `--execute` run announced "nothing deleted" and then reaped.
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
 * Pure: the branch phase's candidate-list block, with the header's run
 * mode derived from the phase's own CLI options — the same `opts.dryRun`
 * the reap path reads. Taking the whole bag (rather than a restated
 * boolean) is the point: the driver cannot get the wording wrong because
 * it never names the flag, so a destructive `--execute` run can no longer
 * announce itself as a `DRY RUN (nothing deleted)` preview and then
 * delete every candidate.
 *
 * @param {object} args
 * @param {{ candidates: Array, skipped?: Array }} args.plan
 * @param {{ dryRun?: boolean }} args.opts   Parsed CLI options.
 * @param {string|null} [args.baseBranch]
 * @returns {string[]}
 */
export function renderCandidateList({ plan, opts = {}, baseBranch = null }) {
  return renderDryRun(plan, { baseBranch, execute: !opts.dryRun });
}

/**
 * Pure: the tip / merged short-SHA pair both merged-tip skip lines quote,
 * with a placeholder for either side the planner could not resolve.
 */
function shortShaPair(skip) {
  return {
    tip: skip.tipSha ? skip.tipSha.slice(0, 7) : '<unknown>',
    merged: skip.mergedSha ? skip.mergedSha.slice(0, 7) : '<unknown>',
  };
}

/**
 * Pure: render a single latest-PR-state skip line. Returns null when the
 * skip reason is not one of the latest-PR family — `renderDryRun` filters
 * by truthy return value so unrelated skip reasons (`protected`,
 * `current-head`, `filtered`) stay quiet here. `not-merged` gets its own
 * renderer ({@link renderNotMergedSkipLine}).
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

/**
 * Remedy text per withheld-delete reason (Story #5283). A withheld entry
 * that named no way to proceed would read as an unexplained refusal, so
 * every reason the executor can record gets its own next step here.
 */
const WITHHELD_HINTS = {
  'weak-signal-needs-confirmation':
    'detected only by content-equivalence; re-run interactively or pass --include-content-merged',
};

/**
 * Pure: render a per-branch execution line.
 *
 * An entry marked `skipped` is a delete the executor deliberately
 * withheld rather than one it attempted — it must not render with the
 * `✅` of a completed reap, which is exactly the misreport that would let
 * an operator believe an unattended run had cleaned up a ref it left
 * standing.
 */
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
  // Story #5283: withheld remote entries are recorded on `remote[]` but
  // were never deleted — counting them would overstate the reap.
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
