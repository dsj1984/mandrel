#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-close.js — Story Execution Closure (CLI shell).
 *
 * Replaces Steps 5/5b/6 of epic-execute Mode B: validate, merge into
 * `epic/<id>` --no-ff, push, delete branches, transition Tasks/Story →
 * agent::done, refresh dashboard / health monitor. Merge orchestration,
 * pre-merge validation, post-merge pipeline, cleanup-reconciler, cd-out
 * guard, and input resolution live under `lib/orchestration/story-close/*`
 * (Stories #955 + #956); this file wires those modules.
 *
 * Usage: `node story-close.js --story <ID> [--epic <ID>]`. Exit codes:
 * 0 ok; 1 error; 2 prior-state (pass --resume / --restart).
 *
 * @see .agents/workflows/story-execute.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { getQuality, PROJECT_ROOT } from './lib/config-resolver.js';
import { gitSpawn as defaultGitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { runAutoRefresh } from './lib/orchestration/story-close/auto-refresh-runner.js';
import { runPreMergeGatesWithAttribution } from './lib/orchestration/story-close/baseline-attribution-wiring.js';
import { checkCdOutGuard } from './lib/orchestration/story-close/cd-out-guard.js';
import { resolveCloseInputs } from './lib/orchestration/story-close/close-inputs.js';
import { runFormatAutofix } from './lib/orchestration/story-close/format-autofix.js';
import {
  runFinalizeMerge,
  runResumeMerge,
  withEpicMergeLock,
} from './lib/orchestration/story-close/merge-runner.js';
import { runPostMergeClose } from './lib/orchestration/story-close/post-merge-close.js';
import { emitMaintainabilityProjection } from './lib/orchestration/story-close/pre-merge-validation.js';
import { dispatchRecovery } from './lib/orchestration/story-close-recovery.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from './lib/preflight-runner.js';
import { fetchChildTasks } from './lib/story-lifecycle.js';
import { createPhaseTimer } from './lib/util/phase-timer.js';
import {
  clearPhaseTimerState,
  loadPhaseTimerState,
} from './lib/util/phase-timer-state.js';
import { notify } from './notify.js';

// `checkCdOutGuard` is re-exported so tests/story-close-cd-out-guard.test.js
// keeps its `import { checkCdOutGuard } from '.../story-close.js'` surface.
export { checkCdOutGuard };

const progress = Logger.createProgress('story-close', { stderr: true });
const progressLog = (tag, msg) => progress(tag, msg);

/**
 * Format the `{ status: 'blocked' }` result returned by
 * `runPreMergeGatesWithAttribution` into the canonical close-result envelope
 * + console marker that `runStoryCloseLocked` returns when baseline drift
 * is not attributable to the running Story (Story #1124).
 */
function emitBaselineBlockedResult({ storyId, gateOutcome, progress: log }) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'baseline-drift-not-attributable',
    nonAttributable: gateOutcome.nonAttributable ?? [],
    commentId: gateOutcome.commentId ?? null,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  log(
    'BLOCKED',
    `Story #${storyId} blocked: baseline drift on ${result.nonAttributable.length} path(s) not attributable to this Story.`,
  );
  return result;
}

/**
 * Render the friction-comment body posted on the Story ticket when
 * `coverage-capture` trips the bounded-timeout watchdog (exit 124).
 *
 * Names the timeout duration (resolved via `delivery.quality.gates.coverage.timeoutMs`)
 * and the gate that fired so an operator can decide between bumping the
 * budget, investigating a runaway test, or rerunning. Story #2136 / Task #2143.
 */
export function renderCoverageTimeoutFrictionBody({
  storyId,
  epicId,
  timeoutMs,
}) {
  const seconds = Math.round((timeoutMs ?? 0) / 1000);
  const minutes = Math.round((seconds / 60) * 10) / 10;
  const budget = timeoutMs
    ? `${timeoutMs}ms (~${minutes} min)`
    : 'configured budget';
  return [
    `### Coverage capture timed out`,
    '',
    `The \`coverage-capture\` pre-merge gate spawned \`npm run test:coverage\` for Story #${storyId} (Epic #${epicId ?? 'unknown'}) and the bounded watchdog killed the child after ${budget}.`,
    '',
    `**Exit code:** 124 (GNU \`timeout(1)\` convention — surfaced by \`runCapture\` when \`spawnSync\` returns with \`signal: 'SIGKILL'\`).`,
    '',
    `**Next actions:**`,
    `- Re-run \`npm run test:coverage\` locally inside the Story worktree to confirm the hang.`,
    `- If the suite is honestly slow, raise \`delivery.quality.gates.coverage.timeoutMs\` in \`.agentrc.json\` and re-close.`,
    `- If a specific test hangs, isolate it (\`--test-name-pattern\`) and either fix the deadlock or fence it behind a faster mock.`,
    '',
    `Story label has been flipped to \`agent::blocked\`. Resume by transitioning back to \`agent::executing\` after the underlying issue is fixed.`,
  ].join('\n');
}

/**
 * Apply the `agent::blocked` transition + friction comment when
 * `coverage-capture` exits 124. Best-effort: failures here are logged but
 * do not interrupt the close-result envelope — the operator must see the
 * timeout outcome regardless of whether the upsert/transition writes
 * succeeded.
 *
 * Story #2136 / Task #2143.
 */
async function emitCoverageTimeoutBlockedResult({
  storyId,
  epicId,
  gateOutcome,
  agentSettings,
  provider,
  progress: log,
}) {
  // Resolve the configured timeout so the friction body can name the
  // budget the operator just blew through. Defaults flow through
  // `getQuality` — a missing block resolves to the framework 600000ms.
  let timeoutMs = null;
  try {
    timeoutMs = getQuality({ agentSettings })?.coverage?.timeoutMs ?? null;
  } catch {
    // resolveConfig failures here are diagnostic-only; the close envelope
    // still surfaces the timeout outcome.
  }

  const body = renderCoverageTimeoutFrictionBody({
    storyId,
    epicId,
    timeoutMs,
  });

  let commentId = null;
  try {
    const res = await upsertStructuredComment(
      provider,
      storyId,
      'friction',
      body,
    );
    commentId = res?.commentId ?? null;
  } catch (err) {
    Logger.warn?.(
      `[story-close] failed to upsert coverage-timeout friction comment on #${storyId}: ${err?.message ?? err}`,
    );
  }

  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {
      cascade: false,
    });
  } catch (err) {
    Logger.warn?.(
      `[story-close] failed to transition Story #${storyId} → ${STATE_LABELS.BLOCKED}: ${err?.message ?? err}`,
    );
  }

  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'coverage-capture-timeout',
    gateName: gateOutcome?.gateName ?? 'coverage-capture',
    exitCode: gateOutcome?.exitCode ?? 124,
    timeoutMs,
    commentId,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  log(
    'BLOCKED',
    `Story #${storyId} blocked: \`npm run test:coverage\` exceeded ${timeoutMs ?? 'configured'}ms — flipped to ${STATE_LABELS.BLOCKED}.`,
  );
  return result;
}

/**
 * Run the story-close preflight gate. Exported so tests can drive it
 * with an inline registry / probe spies without re-entering the full
 * close orchestrator. Returns `{ ok: true }` on a clean preflight and
 * `{ ok: false, findings, fixed }` when at least one blocker survives —
 * the caller is responsible for translating `ok: false` into exit-code 2
 * (or, in test harnesses, returning a `{ status: 'blocked' }` envelope).
 *
 * Story #1289: this is the only writer for the `scope: 'story-close'`
 * preflight surface. Adding new checks happens by dropping a file into
 * `.agents/scripts/lib/checks/` — no edit here.
 *
 * @param {object} opts
 * @param {string|number} opts.storyId
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only probe injection.
 * @param {object} [opts.registry] Test-only inline registry.
 * @param {string} [opts.dir]      Test-only fixture dir.
 * @param {object} [opts.logger]   Spy logger.
 * @returns {Promise<{ ok: boolean, findings: Array, fixed: Array }>}
 */
export async function runStoryClosePreflight({
  storyId,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger,
} = {}) {
  Logger.info(
    `[story-close] Running preflight checks (scope=story-close) for Story #${storyId ?? '?'}...`,
  );
  const preflight = await runPreflight({
    scope: 'story-close',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  return {
    ok: !preflight.blocked,
    findings: preflight.findings,
    fixed: preflight.fixed,
  };
}

/**
 * Emit the canonical close-result envelope for the "preflight refused"
 * exit. Shape mirrors `emitBaselineBlockedResult` so the wave aggregator's
 * label-derivation fallback sees a consistent envelope.
 */
function emitPreflightBlockedResult({ storyId, preflight }) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'preflight',
    reason: 'preflight-refused',
    findings: preflight.findings,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'BLOCKED',
    `Story #${storyId} blocked: preflight refused — ${preflight.findings.length} blocker finding(s).`,
  );
  return result;
}

/**
 * Capture the main-repo's current branch name before `runStoryCloseLocked`
 * runs. Returns `{ ok: true, branch }` on success, `{ ok: false, reason }`
 * when HEAD is detached or `git rev-parse` fails. The result feeds
 * `restoreStartingBranch` in the surrounding `finally` block so any throw
 * inside the orchestrator does not leave the operator's shell on a
 * mid-merge branch (e.g. `epic/<id>` after a failed merge attempt).
 *
 * Story #2138 / Task #2141.
 *
 * @param {string} cwd - Main-repo working directory (already resolved via
 *   `resolveCloseInputs`; never the worktree path).
 * @param {{ gitSpawn?: typeof defaultGitSpawn }} [deps] - DI seam for tests.
 * @returns {{ ok: true, branch: string } | { ok: false, reason: string }}
 */
export function captureStartingBranch(cwd, deps = {}) {
  const gitSpawn = deps.gitSpawn ?? defaultGitSpawn;
  const res = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (res.status !== 0) {
    return {
      ok: false,
      reason: `rev-parse-failed: ${res.stderr || 'unknown'}`,
    };
  }
  const branch = (res.stdout || '').trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, reason: 'detached-head' };
  }
  return { ok: true, branch };
}

/**
 * Restore the main-repo to `startingBranch` via `git switch`. Refuses the
 * switch when the destination tree is dirty (`git status --porcelain` is
 * non-empty) — clobbering uncommitted edits via a forced checkout would
 * destroy work, so the operator is left on the current branch with a
 * clear stderr message instead. Never invokes `git reset --hard` or
 * `git checkout --force`.
 *
 * Returns a structured envelope so callers (and tests) can assert which
 * branch they end up on and why. Failure to switch is logged but does
 * not throw — the caller is already unwinding an outer error.
 *
 * Story #2138 / Task #2141.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {{ ok: boolean, branch?: string, reason?: string }} opts.captured
 *   The envelope returned by `captureStartingBranch`. A failed capture
 *   short-circuits with `{ skipped: true, reason: 'no-starting-branch' }`.
 * @param {{ gitSpawn?: typeof defaultGitSpawn }} [deps]
 * @returns {{ restored: boolean, branch?: string, reason?: string, skipped?: boolean }}
 */
export function restoreStartingBranch({ cwd, captured }, deps = {}) {
  const gitSpawn = deps.gitSpawn ?? defaultGitSpawn;
  const log = deps.logger ?? Logger;
  if (!captured || captured.ok !== true) {
    return {
      restored: false,
      skipped: true,
      reason: captured?.reason
        ? `no-starting-branch: ${captured.reason}`
        : 'no-starting-branch',
    };
  }
  const { branch } = captured;
  // Cheap no-op when we are already on the captured branch — avoids a
  // pointless `git switch` (and the dirty-tree guard it would trip when
  // the close itself produced legitimate edits the operator wants to keep).
  const currentRes = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (currentRes.status === 0 && currentRes.stdout.trim() === branch) {
    return { restored: true, branch, reason: 'already-on-branch' };
  }
  // Refuse the switch on a dirty destination tree. `git switch` would
  // itself refuse most dirty-tree cases, but checking explicitly lets us
  // surface a stable, machine-readable reason and avoid any chance of a
  // partially-applied switch.
  const statusRes = gitSpawn(cwd, 'status', '--porcelain');
  if (statusRes.status !== 0) {
    log.warn?.(
      `[story-close] branch-restore: \`git status --porcelain\` failed in ${cwd}: ${statusRes.stderr || 'unknown'}`,
    );
    return {
      restored: false,
      branch,
      reason: `status-failed: ${statusRes.stderr || 'unknown'}`,
    };
  }
  if (statusRes.stdout.length > 0) {
    log.error?.(
      `[story-close] branch-restore: refusing to switch to \`${branch}\` — working tree is dirty in ${cwd}. ` +
        `Resolve the local changes manually, then \`git switch ${branch}\`.`,
    );
    return { restored: false, branch, reason: 'dirty-tree' };
  }
  const switchRes = gitSpawn(cwd, 'switch', branch);
  if (switchRes.status !== 0) {
    log.warn?.(
      `[story-close] branch-restore: \`git switch ${branch}\` failed: ${switchRes.stderr || 'unknown'}`,
    );
    return {
      restored: false,
      branch,
      reason: `switch-failed: ${switchRes.stderr || 'unknown'}`,
    };
  }
  return { restored: true, branch };
}

/** Orchestrate the Story closure. Exported for testing. */
export async function runStoryClose({
  storyId: storyIdParam,
  epicId: epicIdParam,
  skipDashboard: skipDashboardParam,
  skipValidation: skipValidationParam,
  cwd: cwdParam,
  resume: resumeParam,
  restart: restartParam,
  injectedProvider,
} = {}) {
  const {
    storyId,
    epicId,
    cwd,
    worktreePath,
    skipDashboard,
    skipValidation: skipValidationResolved,
    resumeFlag,
    restartFlag,
    noEvidenceFlag,
    orchestration,
    agentSettings,
    provider,
    story,
    epicBranch,
    storyBranch,
  } = await resolveCloseInputs({
    storyIdParam,
    epicIdParam,
    skipDashboardParam,
    skipValidationParam,
    cwdParam,
    resumeParam,
    restartParam,
    injectedProvider,
  });

  const notifyFn = (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, { orchestration, provider, ...opts });

  progress('INIT', `Closing Story #${storyId}...`);

  // Preflight guard (Story #1289): assemble state, run the registry,
  // auto-correct what can be, and refuse the close on any surviving
  // blocker finding. Runs BEFORE `withEpicMergeLock` so we don't
  // acquire the per-Epic lock just to release it on a refused preflight.
  // Exit code 2 is reserved project-wide for "preflight refused".
  const preflightOutcome = await runStoryClosePreflight({ storyId, cwd });
  if (!preflightOutcome.ok) {
    const blockedResult = emitPreflightBlockedResult({
      storyId,
      preflight: preflightOutcome,
    });
    // The CLI entry's runAsCli wrapper translates this `success: false,
    // reason: 'preflight-refused'` envelope into exit-code 2 via
    // `onError` below. In-process callers receive the envelope directly.
    return {
      success: false,
      result: blockedResult,
      exitCode: PREFLIGHT_REFUSED_EXIT_CODE,
    };
  }

  // Story #2144 — flip the Story to `agent::closing` once preflight has
  // passed and before we acquire the per-Epic merge lock. `agent::closing`
  // is the intermediate state that distinguishes a hung close (preflight
  // passed but merge never landed) from finished work (`agent::done`,
  // applied only after the post-merge pipeline confirms the merge is
  // reachable from `epic/<id>`). Best-effort: a transition failure here
  // does not abort the close — the merge can still land, and the
  // post-merge ticket-closure phase will surface the inconsistency.
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.CLOSING, {
      cascade: false,
      notify: notifyFn,
    });
    progress('STATE', `Story #${storyId} → ${STATE_LABELS.CLOSING}`);
  } catch (err) {
    Logger.warn?.(
      `[story-close] failed to flip Story #${storyId} → ${STATE_LABELS.CLOSING}: ${err?.message ?? err}`,
    );
  }

  // Capture the main-repo's starting branch *before* we enter the merge
  // lock so any throw inside `runStoryCloseLocked` (rebase failure, push
  // rejection, transient git/network errors) leaves the operator's shell
  // on the branch they came in on instead of stranded on `epic/<id>` or
  // mid-rebase. The matching restore in the `finally` block refuses to
  // switch when the destination tree is dirty — see
  // `restoreStartingBranch` for the safety contract. Story #2138 / #2141.
  const startingBranch = captureStartingBranch(cwd);
  if (!startingBranch.ok) {
    Logger.warn?.(
      `[story-close] branch-restore: could not capture starting branch (${startingBranch.reason}); finally-block restore will be skipped.`,
    );
  }

  // Hold the per-Epic merge lock across the entire close flow — pre-merge
  // gates, dispatchRecovery, merge, and post-merge pipeline. The narrower
  // lock that previously wrapped only the merge+push step let two concurrent
  // closes interleave validation/post-merge work against a shifting
  // `origin/<epic>` tip, producing the `merged:true`-but-HEAD-stale failure
  // mode that mimics a push-hook cascade. Serializing per Epic at script
  // entry costs wave-close parallelism but eliminates the race outright.
  try {
    return await withEpicMergeLock(
      epicId,
      { repoRoot: cwd, timeoutMs: 60_000, log: progressLog },
      () =>
        runStoryCloseLocked({
          storyId,
          epicId,
          cwd,
          worktreePath,
          skipDashboard,
          skipValidationParam: skipValidationResolved,
          resumeFlag,
          restartFlag,
          noEvidenceFlag,
          orchestration,
          agentSettings,
          provider,
          story,
          epicBranch,
          storyBranch,
          notifyFn,
        }),
    );
  } finally {
    restoreStartingBranch({ cwd, captured: startingBranch });
  }
}

function shouldSkipValidation({
  skipValidationParam,
  resumeFromConflict,
  resumeFromMerge,
  resumeFromPostMerge,
}) {
  return (
    !!skipValidationParam ||
    resumeFromConflict ||
    resumeFromMerge ||
    resumeFromPostMerge
  );
}

async function runPreMergeValidation({
  cwd,
  worktreePath,
  epicBranch,
  storyBranch,
  agentSettings,
  storyId,
  epicId,
  noEvidenceFlag,
  phaseTimer,
  provider,
}) {
  // Self-heal format drift carried in from upstream waves before the
  // check-only gate fails the close. Lint-staged misses files outside
  // its glob (notably JSON), so a JSON edit in wave N can fail every
  // wave N+1 close until an operator runs `biome format --write` and
  // commits the result.
  runFormatAutofix({ cwd, storyId, agentSettings, logger: Logger });
  // Story #1120: gates spawn in the worktree, not main. Story #1124:
  // baseline-gate failures route through the attribution classifier.
  const gateOutcome = await runPreMergeGatesWithAttribution({
    cwd,
    worktreePath,
    epicBranch,
    storyBranch,
    agentSettings,
    storyId,
    epicId,
    useEvidence: !noEvidenceFlag,
    phaseTimer,
    provider,
  });
  if (gateOutcome?.status === 'blocked') return gateOutcome;
  // Story #2136 — coverage-capture timeout shares the short-circuit so the
  // MI projection (which spawns more reads) does not pile on a hang.
  if (gateOutcome?.status === 'blocked-timeout') return gateOutcome;
  emitMaintainabilityProjection({
    cwd,
    epicBranch,
    storyBranch,
    agentSettings,
    logger: Logger,
  });
  return gateOutcome;
}

/**
 * Pure: render the AUTO-REFRESH status into a `{channel, message}` log
 * envelope, or `null` for statuses we don't surface. Extracted so the
 * branching lives behind a tested boundary and `reportAutoRefreshOutcome`
 * stays at CC ≤ 2.
 */
export function describeAutoRefreshOutcome(refreshResult) {
  if (refreshResult?.status === 'amended') {
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Amended bounded baseline drift into HEAD (${refreshResult.sha}).`,
    };
  }
  if (refreshResult?.status === 'refused') {
    const sig = refreshResult.dedup
      ? 'already present'
      : refreshResult.signalAppended
        ? 'appended'
        : 'not written';
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Refused — ${refreshResult.refusalReasons.length} cap breach(es); friction signal ${sig}.`,
    };
  }
  if (refreshResult?.status === 'failed') {
    return {
      channel: 'warn',
      message: `[auto-refresh] ${refreshResult.reason}: ${refreshResult.detail ?? ''}`,
    };
  }
  return null;
}

function reportAutoRefreshOutcome(refreshResult) {
  const envelope = describeAutoRefreshOutcome(refreshResult);
  if (!envelope) return;
  if (envelope.channel === 'warn') Logger.warn(envelope.message);
  else progress(envelope.label, envelope.message);
}

/**
 * Story #1398 (Epic #1386) — bounded baseline auto-refresh. Pre-merge
 * gates have passed; regenerate baseline rows scoped to the Story diff
 * and amend them into HEAD if every row's delta is at or below the
 * configured caps. Failure modes are advisory: a regen / amend / signal-
 * write failure is logged but does not block the close.
 */
async function runAutoRefreshSafely(args) {
  try {
    const refreshResult = await runAutoRefresh(args);
    reportAutoRefreshOutcome(refreshResult);
  } catch (err) {
    Logger.warn(
      `[auto-refresh] runner threw: ${err?.stack || err?.message || err}`,
    );
  }
}

async function runStoryCloseLocked({
  storyId,
  epicId,
  cwd,
  worktreePath,
  skipDashboard,
  skipValidationParam,
  resumeFlag,
  restartFlag,
  noEvidenceFlag,
  orchestration,
  agentSettings,
  provider,
  story,
  epicBranch,
  storyBranch,
  notifyFn,
}) {
  // Prior-state detection + --resume / --restart dispatch.
  const { resumeFromConflict, resumeFromMerge, resumeFromPostMerge } =
    dispatchRecovery({
      cwd,
      storyId,
      epicId,
      epicBranch,
      storyBranch,
      orchestration,
      resume: resumeFlag,
      restart: restartFlag,
      progress,
      logger: Logger,
    });

  const tasks = await fetchChildTasks(provider, storyId);
  // Prime the cache so cascadeCompletion + transitionTicketState reuse the
  // already-hydrated tickets instead of re-reading them via REST.
  provider.primeTicketCache([story, ...tasks]);
  progress('TASKS', `Found ${tasks.length} child Task(s)`);

  // Restore the phase timer from the snapshot story-init left in
  // `<mainCwd>/.git/`; missing — fall back to a fresh timer.
  const prior = loadPhaseTimerState({ mainCwd: cwd, storyId });
  const phaseTimer = createPhaseTimer(storyId, prior ? { restore: prior } : {});

  // Pre-merge gates surface formatting / MI drift in the worktree rather
  // than on the Epic at pre-push time. Skipped on resume-from-* paths
  // because the gates already ran on the original close; re-running them
  // against a possibly-reaped worktree is wasted work and may itself fail.
  const skipValidation = shouldSkipValidation({
    skipValidationParam,
    resumeFromConflict,
    resumeFromMerge,
    resumeFromPostMerge,
  });
  if (!skipValidation) {
    const gateOutcome = await runPreMergeValidation({
      cwd,
      worktreePath,
      epicBranch,
      storyBranch,
      agentSettings,
      storyId,
      epicId,
      noEvidenceFlag,
      phaseTimer,
      provider,
    });
    if (gateOutcome?.status === 'blocked') {
      return emitBaselineBlockedResult({ storyId, gateOutcome, progress });
    }
    // Story #2136 / Task #2143 — coverage-capture exit 124 is a bounded-
    // timeout trip, not a test-suite failure. Flip the Story to
    // `agent::blocked` + post a friction comment naming the timeout, then
    // short-circuit the close. The hang is recoverable (operator either
    // bumps the budget or fixes the runaway test), so we do not fall
    // through to merge.
    if (gateOutcome?.status === 'blocked-timeout') {
      return emitCoverageTimeoutBlockedResult({
        storyId,
        epicId,
        gateOutcome,
        agentSettings,
        provider,
        progress,
      });
    }
    await runAutoRefreshSafely({
      storyId,
      epicId,
      cwd: worktreePath || cwd,
      epicBranch,
      storyBranch,
      agentSettings,
    });
  }

  // Everything past validation is the `close` phase; runPostMergeClose
  // marks `api-sync` once the merge lands.
  phaseTimer.mark('close');

  // Skip the merge runner entirely on the already-merged path — the merge
  // already landed on `origin/epic/<id>` during the prior close attempt; the
  // only remaining work is the post-merge pipeline (ticket transitions,
  // cascade, health, dashboard regen).
  if (!resumeFromPostMerge) {
    const mergeArgs = {
      cwd,
      epicBranch,
      storyBranch,
      storyTitle: story.title,
      storyId,
      epicId,
      orchestration,
      log: progressLog,
    };
    await (resumeFromConflict ? runResumeMerge : runFinalizeMerge)(mergeArgs);
  } else {
    progress(
      'MERGE',
      `Skipping rebase + merge — story tip already reachable from ${epicBranch}`,
    );
  }

  const result = await runPostMergeClose({
    orchestration,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    cwd,
    projectRoot: PROJECT_ROOT,
    config: { agentSettings, orchestration },
    provider,
    notify: notifyFn,
    tasks,
    skipDashboard,
    progress,
    logger: Logger,
    phaseTimer,
    clearPhaseTimerState,
  });

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'DONE',
    `✅ Story #${storyId} merged into ${epicBranch}. ${result.ticketsClosed.length} ticket(s) closed.`,
  );
  return { success: true, result };
}

runAsCli(
  import.meta.url,
  async () => {
    const envelope = await runStoryClose();
    // Story #1289: preflight refusal returns `{ exitCode: 2, success: false }`
    // synchronously rather than throwing — translate that to a process exit so
    // the CLI surface honours the project-wide "preflight refused" reservation.
    if (envelope?.exitCode === PREFLIGHT_REFUSED_EXIT_CODE) {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
    return envelope;
  },
  {
    source: 'story-close',
    onError: (err) => {
      // exitCode=2 also covers two prior reservations: dispatchRecovery's
      // prior-state refusal (printed to stderr; operator passes --resume /
      // --restart) and now Story #1289's preflight refusal (printed by
      // preflight-runner; operator runs the listed fix commands). Both paths
      // suppress the stack trace and exit cleanly.
      if (err?.exitCode === 2) process.exit(2);
      Logger.error(`[phase=fatal] [story-close] ${err.stack || err.message}`);
      process.exit(1);
    },
  },
);
