// .agents/scripts/lib/orchestration/pr-watch.js
/**
 * pr-watch.js — the required-check poll loop for an open PR.
 * Story #2256 (Epic #2172).
 *
 * **Not a listener, and no longer shelved among them.** This shipped as the
 * `Watcher` lifecycle listener subscribing to `pr.created`. Story #5006
 * deleted the class but left the plain primitive at
 * `lifecycle/listeners/watcher.js` so its CLI consumer's import stayed
 * stable. Story #5024 then retired the bus itself, which took the listener
 * concept — and the `listeners/` directory — with it, so the primitive moved
 * here beside [`merge-poll.js`](./merge-poll.js), the home Story #4545 chose
 * for `MergeWatcher`'s surviving parts. The only production consumer,
 * `pr-watch-with-update.js`, has always driven {@link watchPrToTerminal}
 * directly, with no bus.
 *
 * Critical contract:
 *   - Required-check **names** are resolved from `gh pr checks` at
 *     runtime, NOT from `.agentrc.json.branchProtection.requiredChecks`.
 *     The static config remains for local-validation hints only; the
 *     branch-protection ruleset on GitHub is the source of truth at
 *     watch time. This guards against config drift (a config file that
 *     hasn't been updated after a protection rule changed on GitHub
 *     would otherwise cause the watch to either skip a required check
 *     or wait for a removed one indefinitely).
 *
 * Side-effect firewall: the loop shells out to `gh` through injectable
 * ports and returns a verdict. It does NOT mutate ticket labels, post
 * comments, call `notify`, or write any ledger.
 */

import { spawnSync } from 'node:child_process';

import { applyBehindUpdate } from './behind-recovery.js';
import { checkVerdict, classifyRequiredCheck } from './check-state.js';

/**
 * The `gh --repo` flag pair for an optional `owner/repo` target, or an empty
 * argv fragment when the repository is inferred from the cwd's remote.
 *
 * `gh` resolves a *cross-repository* PR reference only through this flag — it
 * has no `<owner/repo>#<number>` argument form, and a caller that builds one
 * gets it parsed as a **branch name** instead (every `--repo` invocation of the
 * watch CLI failed on that, reported as a misleading `gh-checks-failed`). Pure
 * — one place builds the fragment so no port can forget it.
 *
 * Module-private on purpose: the three ports below are the only callers, and
 * the flag is asserted through them (a real-spawn argv probe), never by
 * importing this helper — an export existing solely for a test is dead in the
 * `--production` reachability ratchet.
 *
 * @param {string|null|undefined} repo `owner/repo`, or nullish to infer.
 * @returns {string[]}
 */
function ghRepoFlag(repo) {
  const trimmed = String(repo ?? '').trim();
  return trimmed.length > 0 ? ['--repo', trimmed] : [];
}

/**
 * Default `gh pr checks` spawn. Always invokes with `--required` so the
 * returned set is authoritative for branch-protection gating. The
 * `--json name,state,bucket` projection is stable across `gh` >= 2.30.
 *
 * Exported so tests can stub.
 */
function ghPrChecks({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    [
      'pr',
      'checks',
      prUrl,
      '--required',
      '--json',
      'name,state,bucket,workflow',
      ...ghRepoFlag(repo),
    ],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Default `gh pr view` spawn — probes `mergeStateStatus` so the watch loop
 * can detect the BEHIND condition (PR head is behind its base branch)
 * AFTER every required check is green. Injectable so tests can stub.
 */
function ghPrView({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', 'mergeStateStatus', ...ghRepoFlag(repo)],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Parse the `mergeStateStatus` field out of a `gh pr view --json
 * mergeStateStatus` payload. Returns the empty string for malformed
 * input so callers can treat unknown / unparseable states as "not
 * BEHIND" (the conservative recovery branch). Pure — exported for
 * tests.
 */
function parseMergeStateStatus(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.mergeStateStatus === 'string'
      ? parsed.mergeStateStatus
      : '';
  } catch {
    return '';
  }
}

/**
 * Default `gh pr update-branch` spawn — invoked by the BEHIND recovery
 * loop to fast-forward the PR head with its base branch. Exported so
 * tests can stub and assert call counts.
 */
function ghPrUpdateBranch({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'update-branch', prUrl, ...ghRepoFlag(repo)],
    {
      cwd,
      encoding: 'utf-8',
      shell: false,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * All outcomes are non-failing. Used as the gate before issuing a
 * `gh pr update-branch` recovery call — a red check is a hard block
 * regardless of mergeStateStatus, so we never auto-recover into a
 * failing PR.
 */
function allGreen(outcomes) {
  const values = Object.values(outcomes);
  if (values.length === 0) return false;
  return values.every((v) => checkVerdict(v) === 'pass');
}

/**
 * Parse the JSON array produced by `gh pr checks --json name,state,…`.
 * Returns `[]` for any malformed input. Pure — exported for tests.
 *
 * Each entry shape: `{ name, state, bucket, workflow }`. The
 * `bucket` field is `gh`'s terminal classification (`pass`, `fail`,
 * `pending`, `skipping`); we prefer `state` when populated and fall
 * back to `bucket` when not.
 */
export function parseGhPrChecks(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e === 'object' && typeof e.name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Reduce a list of check entries to the canonical `{ checkName: outcome }`
 * map. Pure — exported for tests.
 *
 * When `gh` returns the same `name` more than once (parallel matrix
 * builds, retries), the LAST entry wins. The poll loop calls this on
 * every tick so the final emit reflects the most recent state.
 */
export function reduceOutcomes(entries) {
  const out = {};
  for (const e of entries) {
    out[e.name] = classifyRequiredCheck(e);
  }
  return out;
}

/**
 * Terminal-state predicate. Pure — exported for tests so the
 * pending-state list is reviewable as code, not as prose.
 *
 * Only `'pending'` is non-terminal — the shared `classifyCheckState`
 * (`check-state.js`) already collapses every "still running" GitHub state
 * into that sentinel.
 */
export function allTerminal(outcomes) {
  for (const v of Object.values(outcomes)) {
    if (v === 'pending') return false;
  }
  return true;
}

/**
 * Sentinel outcome for a required check that never went terminal within
 * the poll cap AND the resume budget — the CI job is genuinely slow, not
 * red. Story #4358 made this a first-class outcome distinct from
 * `'timed_out'` (a GitHub-reported terminal timeout) and `'failure'` (a
 * red check): a `'still-running'` map means "re-arm the watch / hand off
 * to `/loop`," never "the change is broken."
 */
const STILL_RUNNING = 'still-running';

/**
 * Promote any leftover `'pending'` outcomes to the schema-valid
 * `'still-running'` sentinel before emit. Pure — exported for tests so
 * the cap-fire behaviour is reviewable. Called only when the poll loop
 * (and its resume budget) exits with checks still pending and none
 * failed — the slow-but-not-red terminal state.
 */
export function promotePendingToStillRunning(outcomes) {
  const out = {};
  for (const [k, v] of Object.entries(outcomes)) {
    out[k] = v === 'pending' ? STILL_RUNNING : v;
  }
  return out;
}

/**
 * True when at least one required check has genuinely failed — the hard
 * stop that consumes NO resume budget and exits 1 immediately. A
 * `'pending'` check is not a failure (it is still running); anything
 * outside the non-failing set AND outside `'pending'` is a red block.
 * Pure — exported for tests.
 */
export function hasFailingCheck(outcomes) {
  return Object.values(outcomes).some((v) => checkVerdict(v) === 'fail');
}

/**
 * Default sleeper. Hoisted so tests can stub without faking timers.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inner poll-to-terminal loop. Polls `ghPrChecksFn` on each tick until
 * every required check reaches a terminal state or the iteration cap
 * (`maxPolls`) fires. Transient `gh` failures (exit status != 0/8 with
 * an empty stdout) are logged and skipped — the outer cap eventually
 * short-circuits if `gh` is unrecoverably broken.
 *
 * Exported so {@link watchPrToTerminal}'s BEHIND-recovery outer loop can
 * call it once per CI cycle without duplicating the inner logic.
 *
 * @param {object} opts
 * @param {string} opts.prUrl
 * @param {string} opts.cwd
 * @param {string|null} [opts.repo] `owner/repo` passed to `gh` as `--repo`.
 * @param {object} opts.outcomes  Initial `{ checkName: outcome }` map.
 * @param {number} opts.polls     Current poll counter (mutated in-place by caller).
 * @param {number} opts.maxPolls  Hard cap on total poll iterations.
 * @param {Function} opts.ghPrChecksFn
 * @param {number} opts.pollIntervalMs
 * @param {Function} opts.sleepFn
 * @param {{ warn?: Function }} opts.logger
 * @returns {Promise<{ outcomes: object, polls: number }>}
 */
export async function pollUntilTerminal({
  prUrl,
  cwd,
  repo = null,
  outcomes,
  polls,
  maxPolls,
  ghPrChecksFn,
  pollIntervalMs,
  sleepFn,
  logger,
}) {
  let currentOutcomes = outcomes;
  let currentPolls = polls;
  while (!allTerminal(currentOutcomes) && currentPolls < maxPolls) {
    await sleepFn(pollIntervalMs);
    currentPolls += 1;
    const probe = ghPrChecksFn({ prUrl, cwd, repo });
    const entries = parseGhPrChecks(probe.stdout);
    if (entries.length === 0 && probe.status !== 0 && probe.status !== 8) {
      // Transient `gh` failure — log and continue. The outer
      // iteration cap eventually short-circuits if `gh` is
      // unrecoverably broken.
      logger.warn?.(
        `[Watcher] gh pr checks transient failure (status=${probe.status}): ${probe.stderr}`,
      );
      continue;
    }
    currentOutcomes = reduceOutcomes(entries);
  }
  return { outcomes: currentOutcomes, polls: currentPolls };
}

/**
 * Run the full required-check watch loop for an open PR: poll every
 * required check to a terminal state, then — when every check is green
 * AND the PR is `mergeStateStatus: BEHIND` — issue a bounded number of
 * `gh pr update-branch` fast-forwards, re-polling the freshly-rebased
 * commit after each. Plain async function with NO bus coupling: it
 * shells out to `gh` (via injectable spawns) and returns the verdict.
 *
 * The load-bearing primitive the `pr-watch-with-update.js` CLI drives.
 * Story #3902 introduced it so the (since-retired) `Watcher` listener and
 * the CLI could not drift apart on polling or BEHIND-recovery; the CLI is
 * now its only caller.
 *
 * @param {object} opts
 * @param {string} opts.prUrl              PR URL or number (passed to `gh` verbatim).
 * @param {string} opts.cwd
 * @param {string|null} [opts.repo]        `owner/repo` target, threaded to every
 *   `gh` port as a real `--repo` flag (Story #4890). Nullish infers the
 *   repository from the cwd's remote — the behaviour every in-repo caller wants.
 * @param {number} opts.maxPolls           Hard cap on total poll iterations per arm.
 * @param {number} opts.maxUpdates         Cap on `gh pr update-branch` recovery calls.
 * @param {number} [opts.maxResumes]       Story #4358: after the poll cap fires with
 *   one or more required checks still pending (and NONE failed), re-arm the poll
 *   loop up to this many times before giving up with a `still-running` verdict.
 *   A genuinely red check short-circuits immediately and consumes no resume
 *   budget. Defaults to 0 (no resume) so existing callers are unchanged.
 * @param {number} opts.pollIntervalMs     Delay between poll ticks.
 * @param {Function} [opts.ghPrChecksFn]   `gh pr checks` invoker. Defaults
 *   to the real `gh pr checks` spawn so the CLI path (which injects no
 *   port) works; tests override it with a stub. Story #4144.
 * @param {Function} [opts.ghPrViewFn]     `gh pr view` invoker. Defaults
 *   to the real spawn; tests override.
 * @param {Function} [opts.ghPrUpdateBranchFn] `gh pr update-branch`
 *   invoker. Defaults to the real spawn; tests override.
 * @param {Function} [opts.sleepFn]        Poll-tick delay. Defaults to a
 *   real `setTimeout`-backed sleep; tests override with a no-op.
 * @param {{ info?: Function, warn?: Function, debug?: Function }} opts.logger
 * @param {{status:number,stdout:string,stderr:string}} [opts.firstProbe]
 *   Optional already-issued `gh pr checks` result. A caller that has
 *   already probed once to resolve the required-check names threads it
 *   here so the loop does not double-spend the first `gh pr checks` call.
 *   Omit it (the CLI path) and the loop issues the first probe itself.
 * @returns {Promise<{
 *   outcomes: object,
 *   requiredChecks: string[],
 *   polls: number,
 *   updatesApplied: number,
 *   resumesApplied: number,
 *   terminal: boolean,
 *   green: boolean,
 *   stillRunning: boolean,
 *   requiredChecksEmpty?: boolean,
 *   error?: string,
 * }>}
 *   `outcomes` is schema-valid (no `'pending'` — leftover pending is
 *   promoted to `'still-running'` when the cap and resume budget are both
 *   exhausted with no failed check). `stillRunning` is true in exactly
 *   that case (slow CI, not red). `requiredChecksEmpty` / `error` are set
 *   only when the first probe resolved NO required-check names.
 */
export async function watchPrToTerminal({
  prUrl,
  cwd,
  repo = null,
  maxPolls,
  maxUpdates,
  maxResumes = 0,
  pollIntervalMs,
  ghPrChecksFn = ghPrChecks,
  ghPrViewFn = ghPrView,
  ghPrUpdateBranchFn = ghPrUpdateBranch,
  sleepFn = defaultSleep,
  logger,
  firstProbe,
}) {
  // First probe: resolve the required-check name set at runtime. Reuse a
  // caller-supplied probe (issued to resolve the required-check names) so
  // we never double-spend the first `gh` call.
  const first = firstProbe ?? ghPrChecksFn({ prUrl, cwd, repo });
  // `gh` exits 8 when checks are still pending; this is expected and
  // does not indicate failure. Any other non-zero status with no
  // parseable JSON body is a genuine failure.
  const firstEntries = parseGhPrChecks(first.stdout);
  if (firstEntries.length === 0) {
    // NO required-check name resolved. Never enter the poll loop on that:
    // `allTerminal({})` is vacuously true, so the loop would exit on its
    // first evaluation and report a terminal-but-not-green arm — a red
    // verdict with no failing check in it (Story #4890). The name set is
    // resolved exactly once per call, so converging on a context that
    // attaches later means calling this function again; return the
    // empty-set signal and let the caller's attach window re-resolve it.
    const ghFaulted = first.status !== 0 && first.status !== 8;
    if (ghFaulted) {
      logger.warn?.(
        `[Watcher] gh pr checks failed (status=${first.status}): ${first.stderr}`,
      );
    }
    return {
      outcomes: {},
      requiredChecks: [],
      polls: 0,
      updatesApplied: 0,
      resumesApplied: 0,
      terminal: false,
      green: false,
      stillRunning: false,
      requiredChecksEmpty: true,
      // `gh` overloads a non-zero exit for "no required check is attached
      // right now" AND for a genuine fault, and its stderr prose is not a
      // contract — so the status is reported and the *classification* is the
      // caller's, made against a structural probe of the PR itself.
      error: `gh-checks-${ghFaulted ? 'failed' : 'empty'}:status=${first.status}`,
    };
  }

  const requiredChecks = firstEntries.map((e) => e.name);

  // Poll loop. The first probe already produced entries; reduce them
  // for the initial outcome map, then iterate until every required
  // check is terminal or the iteration cap fires. After the checks
  // converge, the BEHIND-recovery loop may re-enter the poll loop AFTER
  // issuing `gh pr update-branch`.
  let outcomes = reduceOutcomes(firstEntries);
  let polls = 0;
  let updatesApplied = 0;
  let resumesApplied = 0;
  // Outer resume loop (Story #4358). Each iteration runs one full
  // poll-to-cap + BEHIND-recovery arm. When the arm ends with checks
  // still pending but NONE failed, we re-arm (reset the poll counter)
  // up to `maxResumes` times before declaring `still-running`. A red
  // check breaks out immediately without consuming resume budget.
  for (;;) {
    while (polls < maxPolls) {
      ({ outcomes, polls } = await pollUntilTerminal({
        prUrl,
        cwd,
        repo,
        outcomes,
        polls,
        maxPolls,
        ghPrChecksFn,
        pollIntervalMs,
        sleepFn,
        logger,
      }));
      // Checks have either all gone terminal or we hit the iteration cap.
      // BEHIND-recovery (Story #2327): when every required check is green
      // AND the PR is BEHIND its base, issue ONE `gh pr update-branch`
      // call and re-poll the checks against the freshly-rebased commit. A
      // red check is a hard block — stop here regardless of merge state.
      // Bounded by `maxUpdates` so a racing base branch can't ping-pong
      // indefinitely.
      if (!allTerminal(outcomes) || !allGreen(outcomes)) break;
      // Budget is checked before the `gh pr view` spawn so an exhausted arm
      // costs no extra round-trip; the shared helper re-checks it as a
      // fail-safe, and its callback therefore never fires on this path.
      if (updatesApplied >= maxUpdates) break;
      const view = ghPrViewFn({ prUrl, cwd, repo });
      if (view.status !== 0) {
        logger.warn?.(
          `[Watcher] gh pr view failed (status=${view.status}): ${view.stderr}`,
        );
        break;
      }
      const recovery = await applyBehindUpdate({
        mergeStateStatus: parseMergeStateStatus(view.stdout),
        updatesUsed: updatesApplied,
        maxUpdates,
        updateBranch: async () => {
          const update = ghPrUpdateBranchFn({ prUrl, cwd, repo });
          return update.status === 0
            ? { ok: true }
            : {
                ok: false,
                detail: `status=${update.status}: ${update.stderr}`,
              };
        },
        onUpdateFailed: (detail) =>
          logger.warn?.(`[Watcher] gh pr update-branch failed (${detail})`),
      });
      // Anything but a landed fast-forward ends the arm: not BEHIND means
      // there is nothing to recover, and a failed update must not silently
      // re-poll as though the head moved.
      if (!recovery.updated) break;
      updatesApplied += 1;
      logger.info?.(
        `[Watcher] PR BEHIND base — issued gh pr update-branch (#${updatesApplied}/${maxUpdates}); re-polling required checks.`,
      );
      await sleepFn(pollIntervalMs);
      // After update-branch, the freshly-rebased commit invalidates the
      // previous terminal outcomes. Reset to force the inner poll loop to
      // re-evaluate the new CI cycle.
      outcomes = {};
      for (const name of requiredChecks) outcomes[name] = 'pending';
    }

    // Arm complete. Decide whether to re-arm. A genuinely red check is a
    // hard stop that consumes NO resume budget — the change is broken,
    // resuming would only burn wall-clock. Only re-arm when the arm timed
    // out with pending-but-not-failed checks and resume budget remains.
    if (allTerminal(outcomes) || hasFailingCheck(outcomes)) break;
    if (resumesApplied >= maxResumes) break;
    resumesApplied += 1;
    polls = 0;
    logger.info?.(
      `[Watcher] poll cap reached with checks still pending; re-arming watch (resume #${resumesApplied}/${maxResumes}).`,
    );
  }

  const terminal = allTerminal(outcomes);
  const failing = hasFailingCheck(outcomes);
  // Slow-but-not-red: the poll cap AND resume budget are exhausted with
  // one or more checks still pending and NONE failed. The schema enum
  // forbids `'pending'`; promote leftover pending entries to the
  // `'still-running'` sentinel (never `'timed_out'` — that would read as
  // a genuine terminal failure to the auto-merge predicate).
  const stillRunning = !terminal && !failing;
  const finalOutcomes = terminal
    ? outcomes
    : promotePendingToStillRunning(outcomes);
  return {
    outcomes: finalOutcomes,
    requiredChecks,
    polls,
    updatesApplied,
    resumesApplied,
    terminal,
    green: terminal && allGreen(finalOutcomes),
    stillRunning,
  };
}
