// .agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js
/**
 * AutomergeArmer — lifecycle listener that arms GitHub's native
 * auto-merge after the AutomergePredicate signals a clean run.
 * Story #2256 / Task #2262 (Epic #2172).
 *
 * Subscribes to:
 *   - `epic.merge.ready` → and ONLY this event.
 *
 * Side effects executed inside `handle()`:
 *   1. Probe `gh pr view <pr> --json autoMergeRequest` — if auto-merge
 *      is already armed on the PR, short-circuit to a single
 *      `epic.merge.armed` emit without re-issuing the merge command.
 *      This is AC-10 (idempotency) for the second non-trivial
 *      idempotency case (cross-process re-arm after a crash between
 *      `gh pr merge --auto` and the `epic.merge.armed` emit).
 *   2. Otherwise call `gh pr merge --auto --squash --delete-branch`.
 *      `--auto` queues the merge with GitHub; the actual merge happens
 *      asynchronously after every required check goes green and every
 *      required approval lands.
 *   3. Emit `epic.merge.armed` once the merge call succeeds (or the
 *      probe established that a prior arm is already in place).
 *
 * Critical contract — sole `gh pr merge` caller:
 *   - This file is the ONLY production code path authorized to invoke
 *     `gh pr merge`. The merge-lockout ESLint rule in
 *     `.agents/scripts/check-lifecycle-lint.js` enforces this by
 *     allow-listing only this file's suffix. Maintainers: any future
 *     `gh pr merge` call site is a safety regression unless the lockout
 *     rule is updated AT THE SAME TIME with an architectural review.
 *
 *   - The listener subscribes to `epic.merge.ready` and NOTHING ELSE.
 *     The merge-gate-ordering invariant test asserts that
 *     `epic.merge.armed` is preceded by `epic.merge.ready` from the
 *     same run; if a future refactor wires a second event into this
 *     listener, the invariant test catches it.
 *
 * Idempotency contract (AC-10): two-layer defence.
 *   1. Per-instance `Set<string>` of `${event}:${seqId}` keys — repeat
 *      `(event, seqId)` invocation short-circuits and emits nothing.
 *      This is the bus-level replay defence.
 *   2. The `gh pr view` probe — short-circuits across process
 *      boundaries when a prior run already armed auto-merge. This is
 *      the recovery defence: `/deliver` restarted on the same PR
 *      will see the existing arm and emit `epic.merge.armed` exactly
 *      once.
 *
 * Side-effect firewall: the listener emits on the bus and shells out
 * to `gh`. It does NOT mutate ticket labels, post comments, or call
 * `notify`. Downstream listeners (LabelTransitioner /
 * StructuredCommentPoster on `epic.merge.armed`) own those side
 * effects.
 */

import { spawnSync } from 'node:child_process';

import { parsePrNumberFromUrl } from '../../../github-url.js';
import { resolveAutoMergeArmCwd } from '../../auto-merge-cwd.js';
import { classifyMergeBlock } from '../../merge-block-class.js';
import { emitMergeUnlanded } from '../emit-merge-unlanded.js';

/**
 * Default `gh pr view --json autoMergeRequest` probe. Pure-spawn helper
 * — exported so tests can stub the shell-out without touching the
 * spawn wrapper.
 */
export function ghPrViewAutoMerge({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', 'autoMergeRequest,mergeCommit'],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Default `gh pr merge --auto --squash --delete-branch` arm. Pure-spawn
 * helper. Exported so tests can stub. The arg list is captured in a
 * single helper so the merge-lockout lint allow-list narrows to one
 * literal site.
 *
 * Story #4282: `--delete-branch` makes `gh` shell out to local `git`
 * (including a `git checkout <base>`). When this arm runs from a per-Story
 * worktree cwd checked out on the head branch while the base branch is
 * occupied by the primary worktree, that checkout collides
 * (`fatal: '<base>' is already used by worktree`). We re-point the spawn
 * cwd at the primary worktree root (which holds the base branch) via
 * `resolveAutoMergeArmCwd`, so the local checkout is a no-op while
 * `--delete-branch` (head-branch-removed-on-merge) is preserved. The
 * resolver is non-fatal — it degrades to the original cwd.
 */
export function ghPrMergeAuto({
  prUrl,
  cwd,
  spawnFn = spawnSync,
  resolveArmCwd = resolveAutoMergeArmCwd,
}) {
  const armCwd = resolveArmCwd(cwd);
  const result = spawnFn(
    'gh',
    ['pr', 'merge', prUrl, '--auto', '--squash', '--delete-branch'],
    { cwd: armCwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Story #4472 — direct (non-`--auto`) squash-merge fallback.
 *
 * GitHub's native auto-merge (`gh pr merge --auto`) can only be QUEUED on a
 * repository that has the "Allow auto-merge" setting enabled — which in
 * practice requires branch protection. A repo with zero required checks and
 * no branch protection (every mandrel-bench sandbox, many real consumer
 * repos) rejects the `--auto` arm outright with `Auto merge is not allowed
 * for this repository`. The AutomergePredicate has already cleared the merge
 * (green/absent required checks + a clean structured-signal verdict) by the
 * time the armer runs, so the safe, must-land-satisfying fallback is a
 * direct immediate squash-merge — the epic path's observed de-facto manual
 * fallback, made legal and kept inside the sole authorized `gh pr merge`
 * call site.
 *
 * Same `--squash --delete-branch` shape and same `resolveArmCwd` re-point as
 * `ghPrMergeAuto` (so the trailing local `--delete-branch` housekeeping runs
 * from the primary worktree, not a head-branch worktree). Omitting `--auto`
 * makes `gh` merge synchronously.
 */
export function ghPrMergeDirect({
  prUrl,
  cwd,
  spawnFn = spawnSync,
  resolveArmCwd = resolveAutoMergeArmCwd,
}) {
  const armCwd = resolveArmCwd(cwd);
  const result = spawnFn(
    'gh',
    ['pr', 'merge', prUrl, '--squash', '--delete-branch'],
    { cwd: armCwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Pure: does this `gh pr merge --auto` stderr indicate that native
 * auto-merge is unavailable on the repository (as opposed to a genuine arm
 * failure — auth, a merge conflict, an already-merged race)? Only this
 * specific class of failure is safe to retry as a direct merge; everything
 * else must surface as a real failure. Matched case-insensitively.
 *
 * Exported so the marker set is reviewable and testable in isolation.
 */
export function isAutoMergeUnavailable(stderr) {
  const text = String(stderr ?? '').toLowerCase();
  return (
    text.includes('auto merge is not allowed') ||
    text.includes('auto-merge is not allowed') ||
    text.includes('enablepullrequestautomerge') ||
    (text.includes('auto') && text.includes('not enabled'))
  );
}

/**
 * Pure: parse `gh pr view --json autoMergeRequest,mergeCommit` output.
 * `autoMergeRequest` is `null` when auto-merge is NOT armed; a non-null
 * object means a prior arm is in place. Returns `true` iff already
 * armed.
 *
 * Exported for tests so the JSON shape pin is reviewable.
 */
export function parseAutoMergeArmed(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    // `autoMergeRequest: null` → not armed.
    // `autoMergeRequest: { mergeMethod, enabledBy, … }` → armed.
    return (
      parsed.autoMergeRequest !== null &&
      parsed.autoMergeRequest !== undefined &&
      typeof parsed.autoMergeRequest === 'object'
    );
  } catch {
    return false;
  }
}

/**
 * Pure: parse the same probe output for a non-null `mergeCommit` — the
 * PR has ALREADY merged. `gh pr merge --auto` on an already-green PR
 * merges immediately (there is nothing to queue behind), and its exit
 * code then reflects the post-merge local housekeeping: on 2026-07-11
 * (Epic #4454, PR #4459) the merge itself succeeded but the trailing
 * local `--delete-branch` failed because a harness worktree held
 * `epic/4454`, so `gh` exited 1 and the armer misreported a successful
 * merge as `arm-failed` — stranding the run at `agent::blocked` with
 * the whole must-land chain (MergeWatcher → Cleaner → LabelTransitioner)
 * never engaging. The arm-failure re-probe below uses this parser to
 * distinguish "merge landed, housekeeping grumbled" from a genuine arm
 * failure.
 */
export function parsePrMerged(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    return (
      parsed.mergeCommit !== null &&
      parsed.mergeCommit !== undefined &&
      typeof parsed.mergeCommit === 'object'
    );
  } catch {
    return false;
  }
}

/**
 * AutomergeArmer listener.
 */
export class AutomergeArmer {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} [opts.epicId] Epic id — required for the headless
   *   `merge.unlanded` attribution on a genuine arm failure (Story #4472).
   * @param {boolean} [opts.headless] When true (a `/deliver --yes` run), a
   *   genuine (non-fallback) arm failure escalates to an explicit
   *   `merge.unlanded` + `epic.blocked` terminal instead of returning
   *   silently (Story #4472). Defaults to `false` (attended).
   * @param {string} [opts.cwd]
   * @param {Function} [opts.ghPrViewAutoMergeFn] override for tests.
   * @param {Function} [opts.ghPrMergeAutoFn] override for tests.
   * @param {Function} [opts.ghPrMergeDirectFn] override for tests.
   * @param {Function} [opts.emitMergeUnlandedFn] override for tests.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('AutomergeArmer requires a bus with on() and emit()');
    }
    this.bus = opts.bus;
    this.epicId = Number.isInteger(opts.epicId) ? opts.epicId : null;
    this.headless = opts.headless === true;
    this.cwd = opts.cwd ?? process.cwd();
    this.ghPrViewAutoMergeFn = opts.ghPrViewAutoMergeFn ?? ghPrViewAutoMerge;
    this.ghPrMergeAutoFn = opts.ghPrMergeAutoFn ?? ghPrMergeAuto;
    this.ghPrMergeDirectFn = opts.ghPrMergeDirectFn ?? ghPrMergeDirect;
    this.emitMergeUnlandedFn = opts.emitMergeUnlandedFn ?? emitMergeUnlanded;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `epic.merge.ready` observed lands here
     * with the outcome (`armed`, `existing`, `skipped-duplicate`,
     * `failed`). Mirrors the Finalizer / Reconciler "no silent skip"
     * surface.
     */
    this.classifications = [];
    // Frozen tuple — the merge-gate-ordering invariant depends on this
    // listener listening for EXACTLY one event. A test asserts the
    // length of this array.
    this.events = Object.freeze(['epic.merge.ready']);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(
        `[AutomergeArmer] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const prUrl = payload?.prUrl;
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'no-pr-url',
      });
      return;
    }

    // Layer 2 idempotency — cross-process probe. If auto-merge is
    // already armed on the PR (or the PR already merged — a prior arm
    // completed the merge before this run re-entered), emit
    // `epic.merge.armed` and bail without re-issuing the merge command.
    const probe = this.ghPrViewAutoMergeFn({ prUrl, cwd: this.cwd });
    if (
      probe.status === 0 &&
      (parseAutoMergeArmed(probe.stdout) || parsePrMerged(probe.stdout))
    ) {
      this.classifications.push({ event, seqId, outcome: 'existing', prUrl });
      this.logger.info?.(
        `[AutomergeArmer] auto-merge already armed (or PR already merged) on ${prUrl} — short-circuiting.`,
      );
      await this._emitArmed(prUrl);
      return;
    }
    if (probe.status !== 0) {
      // The probe itself failed; degrade to "no probe" rather than
      // throwing — the arm call will surface its own error if it
      // genuinely cannot proceed. We log the probe failure for audit.
      this.logger.warn?.(
        `[AutomergeArmer] gh pr view probe failed (status=${probe.status}): ${probe.stderr} — proceeding with arm.`,
      );
    }

    // Arm. This is the sole authorized `gh pr merge` call site in the
    // entire codebase (see check-lifecycle-lint.js).
    const arm = this.ghPrMergeAutoFn({ prUrl, cwd: this.cwd });
    if (arm.status !== 0) {
      // A non-zero arm exit does NOT necessarily mean the arm failed:
      // `gh pr merge --auto --squash --delete-branch` on an
      // already-green PR merges immediately and then runs local
      // branch-delete housekeeping whose failure (e.g. the epic branch
      // held by another worktree) surfaces as exit 1 AFTER the merge
      // landed (2026-07-11 incident, Epic #4454 / PR #4459). Re-probe
      // before classifying: merged or armed → proceed as success so the
      // MergeWatcher → Cleaner → LabelTransitioner chain engages.
      const recheck = this.ghPrViewAutoMergeFn({ prUrl, cwd: this.cwd });
      if (
        recheck.status === 0 &&
        (parsePrMerged(recheck.stdout) || parseAutoMergeArmed(recheck.stdout))
      ) {
        this.classifications.push({
          event,
          seqId,
          outcome: 'armed',
          prUrl,
          note: `arm exit ${arm.status} but re-probe shows merged/armed (post-merge housekeeping failure): ${arm.stderr}`,
        });
        this.logger.warn?.(
          `[AutomergeArmer] gh pr merge exited ${arm.status} but the PR is merged/armed — treating as success (housekeeping stderr: ${arm.stderr})`,
        );
        await this._emitArmed(prUrl);
        return;
      }

      // Story #4472 — native auto-merge is unavailable on this repository
      // (no branch protection / "Allow auto-merge" disabled). The predicate
      // already cleared the merge, so fall back to a direct immediate
      // squash-merge instead of stranding a landable PR on the
      // operator-merges path.
      if (isAutoMergeUnavailable(arm.stderr)) {
        const armed = await this._tryDirectMerge({ event, seqId, prUrl, arm });
        if (armed) return;
      }

      // Genuine arm failure (auth, conflict, an unresolved direct-merge
      // fallback, …). Classify + escalate.
      await this._emitArmFailure({
        event,
        seqId,
        prUrl,
        reason: `arm-failed:status=${arm.status}`,
        ghStderr: arm.stderr,
      });
      return;
    }

    this.classifications.push({ event, seqId, outcome: 'armed', prUrl });
    await this._emitArmed(prUrl);
  }

  async _emitArmed(prUrl) {
    try {
      await this.bus.emit('epic.merge.armed', { prUrl });
    } catch (err) {
      this.logger.warn?.(
        `[AutomergeArmer] epic.merge.armed emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Story #4472 — direct-merge fallback when native auto-merge is
   * unavailable. Runs an immediate `gh pr merge --squash --delete-branch`
   * (no `--auto`) then re-probes; on a confirmed merge (or the same
   * post-merge `--delete-branch` housekeeping grumble the `--auto` path
   * already tolerates) it emits `epic.merge.armed` so the
   * MergeWatcher → Cleaner → LabelTransitioner chain engages and confirms
   * the merge on its first poll.
   *
   * @returns {Promise<boolean>} `true` when the fallback landed the PR (an
   *   `epic.merge.armed` was emitted); `false` when the direct merge did
   *   not land, so the caller escalates the original arm failure.
   */
  async _tryDirectMerge({ event, seqId, prUrl, arm }) {
    this.logger.info?.(
      `[AutomergeArmer] native auto-merge unavailable (${arm.stderr?.trim?.() ?? arm.stderr}); falling back to a direct squash-merge on ${prUrl}.`,
    );
    const direct = this.ghPrMergeDirectFn({ prUrl, cwd: this.cwd });
    const recheck = this.ghPrViewAutoMergeFn({ prUrl, cwd: this.cwd });
    const merged =
      recheck.status === 0 &&
      (parsePrMerged(recheck.stdout) || parseAutoMergeArmed(recheck.stdout));
    if (direct.status === 0 || merged) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'armed',
        prUrl,
        note: `direct-merge fallback (native auto-merge unavailable); direct exit ${direct.status}${direct.status !== 0 ? ` but re-probe shows merged/armed (housekeeping stderr: ${direct.stderr})` : ''}`,
      });
      await this._emitArmed(prUrl);
      return true;
    }
    this.logger.warn?.(
      `[AutomergeArmer] direct-merge fallback failed (status=${direct.status}): ${direct.stderr}`,
    );
    return false;
  }

  /**
   * Classify + (in headless) escalate a genuine arm failure. The `--auto`
   * path historically returned silently here; a `/deliver --yes` run has no
   * operator to notice, so we mirror the MergeWatcher's terminal:
   * `merge.unlanded` ledger attribution + an explicit `epic.blocked`
   * transition. Attended runs keep the classify-and-return behaviour.
   */
  async _emitArmFailure({ event, seqId, prUrl, reason, ghStderr }) {
    this.classifications.push({
      event,
      seqId,
      outcome: 'failed',
      reason,
      ghStderr,
    });
    this.logger.warn?.(
      `[AutomergeArmer] gh pr merge --auto failed (${reason}): ${ghStderr}`,
    );
    if (!this.headless) return;
    const classification = classifyMergeBlock({
      armResult: { armed: false, reason: ghStderr },
    });
    const prNumber = parsePrNumberFromUrl(prUrl);
    if (
      Number.isInteger(this.epicId) &&
      Number.isInteger(prNumber) &&
      prNumber > 0
    ) {
      try {
        this.emitMergeUnlandedFn({
          scope: 'epic',
          ticketId: this.epicId,
          prNumber,
          blockClass: classification.blockClass,
          reason: classification.reason,
          elapsedSeconds: 0,
        });
      } catch (err) {
        this.logger.warn?.(
          `[AutomergeArmer] emitMergeUnlanded failed (swallowed): ${err?.message ?? err}`,
        );
      }
    }
    try {
      await this.bus.emit('epic.blocked', { reason: `merge-arm:failed` });
    } catch (err) {
      this.logger.warn?.(
        `[AutomergeArmer] epic.blocked emit on arm failure failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
