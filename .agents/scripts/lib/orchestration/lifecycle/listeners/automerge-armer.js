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

import { resolveAutoMergeArmCwd } from '../../auto-merge-cwd.js';

/**
 * Default `gh pr view --json autoMergeRequest` probe. Pure-spawn helper
 * — exported so tests can stub the shell-out without touching the
 * spawn wrapper.
 */
export function ghPrViewAutoMerge({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', 'autoMergeRequest'],
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
 * Pure: parse `gh pr view --json autoMergeRequest` output. The field
 * is `null` when auto-merge is NOT armed; a non-null object means a
 * prior arm is in place. Returns `true` iff already armed.
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
 * AutomergeArmer listener.
 */
export class AutomergeArmer {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {string} [opts.cwd]
   * @param {Function} [opts.ghPrViewAutoMergeFn] override for tests.
   * @param {Function} [opts.ghPrMergeAutoFn] override for tests.
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
    this.cwd = opts.cwd ?? process.cwd();
    this.ghPrViewAutoMergeFn = opts.ghPrViewAutoMergeFn ?? ghPrViewAutoMerge;
    this.ghPrMergeAutoFn = opts.ghPrMergeAutoFn ?? ghPrMergeAuto;
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
    // already armed on the PR, emit `epic.merge.armed` and bail
    // without re-issuing the merge command.
    const probe = this.ghPrViewAutoMergeFn({ prUrl, cwd: this.cwd });
    if (probe.status === 0 && parseAutoMergeArmed(probe.stdout)) {
      this.classifications.push({ event, seqId, outcome: 'existing', prUrl });
      this.logger.info?.(
        `[AutomergeArmer] auto-merge already armed on ${prUrl} — short-circuiting.`,
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
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `arm-failed:status=${arm.status}`,
        ghStderr: arm.stderr,
      });
      this.logger.warn?.(
        `[AutomergeArmer] gh pr merge --auto failed (status=${arm.status}): ${arm.stderr}`,
      );
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

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
