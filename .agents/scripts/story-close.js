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
 * @see .agents/workflows/story-deliver.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { tempRootFrom } from './lib/config/temp-paths.js';
import { getQuality, PROJECT_ROOT } from './lib/config-resolver.js';
import { gitSpawn as defaultGitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import { createLedgerWriter } from './lib/orchestration/lifecycle/ledger-writer.js';
import { runAutoRefresh } from './lib/orchestration/story-close/auto-refresh-runner.js';
import { runPreMergeGatesWithAttribution } from './lib/orchestration/story-close/baseline-attribution-wiring.js';
import { checkCdOutGuard } from './lib/orchestration/story-close/cd-out-guard.js';
import { resolveCloseInputs } from './lib/orchestration/story-close/close-inputs.js';
import { runFormatAutofix } from './lib/orchestration/story-close/format-autofix.js';
import {
  emitStoryBlockedSafe,
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
async function emitBaselineBlockedResult({
  storyId,
  gateOutcome,
  progress: log,
  bus = null,
}) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'baseline-drift-not-attributable',
    nonAttributable: gateOutcome.nonAttributable ?? [],
    commentId: gateOutcome.commentId ?? null,
  };
  // Story #2241 / Task #2247 — mirror the blocked envelope on the
  // lifecycle bus so the BlockerHandler listener sees a typed reason.
  await emitStoryBlockedSafe({
    bus,
    storyId,
    reason: 'baseline-drift-not-attributable',
    logger: Logger,
  });
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
 * Story #2165 — known spawn-timeout dispatch table. Each entry names the
 * spawn whose bounded-timeout watchdog tripped and the `.agentrc.json`
 * config key the operator tunes to raise the budget. The friction body
 * and progress log line both quote `displayName` + `configKey` so the
 * operator sees the same nomenclature wherever the timeout surfaces.
 */
const SPAWN_TIMEOUT_DESCRIPTORS = Object.freeze({
  'coverage-capture': Object.freeze({
    displayName: 'Coverage capture',
    defaultCmd: 'npm run test:coverage',
    configKey: 'delivery.quality.gates.coverage.timeoutMs',
    summary: 'The `coverage-capture` pre-merge gate',
  }),
  'check-maintainability': Object.freeze({
    displayName: 'Maintainability baseline refresh',
    defaultCmd: 'npm run maintainability:update',
    configKey: 'delivery.quality.gates.maintainability.refreshTimeoutMs',
    summary: 'The `check-maintainability` baseline-refresh path',
  }),
  'check-crap': Object.freeze({
    displayName: 'CRAP baseline refresh',
    defaultCmd: 'npm run crap:update',
    configKey: 'delivery.quality.gates.crap.refreshTimeoutMs',
    summary: 'The `check-crap` baseline-refresh path',
  }),
  'format-autofix': Object.freeze({
    displayName: 'Format autofix',
    defaultCmd: 'npx biome format --write .',
    configKey: 'delivery.quality.formatAutofix.timeoutMs',
    summary: 'The pre-gate `format-autofix` step',
  }),
});

const DEFAULT_TIMEOUT_DESCRIPTOR = Object.freeze({
  displayName: 'Close-time spawn',
  defaultCmd: '<unknown>',
  configKey: 'delivery.quality.<gate>.timeoutMs',
  summary: 'A close-time spawn',
});

function resolveSpawnTimeoutDescriptor(spawnName) {
  return SPAWN_TIMEOUT_DESCRIPTORS[spawnName] ?? DEFAULT_TIMEOUT_DESCRIPTOR;
}

/**
 * Story #2241 / Task #2247 — map a spawn-timeout name to the canonical
 * `story.blocked.reason` token the lifecycle bus emits. Operators (and the
 * BlockerHandler listener) classify on this token; the friction-comment
 * body still uses the human descriptor above.
 *
 * The dispatch table preserves the Tech-Spec contract: `format-autofix`
 * → `timeout:biome-format`, both baseline-refresh spawns →
 * `timeout:baseline-refresh`, coverage stays under its own token so a
 * separate cap-tuning surface stays addressable.
 */
const SPAWN_TIMEOUT_REASONS = Object.freeze({
  'coverage-capture': 'timeout:coverage-capture',
  'check-maintainability': 'timeout:baseline-refresh',
  'check-crap': 'timeout:baseline-refresh',
  'format-autofix': 'timeout:biome-format',
});

export function resolveSpawnTimeoutReason(spawnName) {
  return (
    SPAWN_TIMEOUT_REASONS[spawnName] ?? `timeout:${spawnName ?? 'unknown'}`
  );
}

/**
 * Render the friction-comment body posted on the Story ticket when one of
 * the close-time spawns (`coverage-capture`, baseline-refresh, or
 * `format-autofix`) trips the bounded-timeout watchdog (exit 124).
 *
 * Story #2165 generalised the helper to take a `spawnName` so both the
 * pre-existing coverage path and the new format-autofix + baseline-refresh
 * paths share one body shape. The body names which spawn fired, the
 * configured budget, and the config key the operator tunes to raise it.
 *
 * @param {{
 *   storyId: number|string,
 *   epicId?: number|string|null,
 *   timeoutMs?: number|null,
 *   spawnName?: keyof typeof SPAWN_TIMEOUT_DESCRIPTORS | string,
 *   spawnCmd?: string,
 * }} input
 */
export function renderSpawnTimeoutFrictionBody({
  storyId,
  epicId,
  timeoutMs,
  spawnName = 'coverage-capture',
  spawnCmd,
}) {
  const descriptor = resolveSpawnTimeoutDescriptor(spawnName);
  const cmd = spawnCmd || descriptor.defaultCmd;
  const seconds = Math.round((timeoutMs ?? 0) / 1000);
  const minutes = Math.round((seconds / 60) * 10) / 10;
  const budget = timeoutMs
    ? `${timeoutMs}ms (~${minutes} min)`
    : 'configured budget';
  return [
    `### ${descriptor.displayName} timed out`,
    '',
    `${descriptor.summary} spawned \`${cmd}\` for Story #${storyId} (Epic #${epicId ?? 'unknown'}) and the bounded watchdog killed the child after ${budget}.`,
    '',
    `**Exit code:** 124 (GNU \`timeout(1)\` convention — surfaced when \`spawnSync\` returns with \`signal: 'SIGKILL'\`).`,
    '',
    `**Next actions:**`,
    `- Re-run \`${cmd}\` locally inside the Story worktree to confirm the hang.`,
    `- If the command is honestly slow, raise \`${descriptor.configKey}\` in \`.agentrc.json\` and re-close.`,
    `- If a deadlock or runaway loop is the cause, isolate the offending input and fix the underlying hang.`,
    '',
    `Story label has been flipped to \`agent::blocked\`. Resume by transitioning back to \`agent::executing\` after the underlying issue is fixed.`,
  ].join('\n');
}

/**
 * Backwards-compatible wrapper for the coverage-capture timeout body
 * (Story #2136 / Task #2143). New call sites should use
 * `renderSpawnTimeoutFrictionBody` directly with the appropriate
 * `spawnName`.
 */
export function renderCoverageTimeoutFrictionBody({
  storyId,
  epicId,
  timeoutMs,
}) {
  return renderSpawnTimeoutFrictionBody({
    storyId,
    epicId,
    timeoutMs,
    spawnName: 'coverage-capture',
  });
}

/**
 * Story #2165 — resolve the timeout (ms) the upstream watchdog enforced
 * for the named spawn so the friction body + log line can quote it.
 * Best-effort: a missing/invalid resolver returns `null` and downstream
 * formatting prints "configured budget".
 *
 * The dispatch table mirrors `SPAWN_TIMEOUT_DESCRIPTORS` — adding a new
 * timeout-capable spawn means appending here and there in lockstep.
 */
function resolveSpawnTimeoutMs(spawnName, agentSettings) {
  try {
    const quality = getQuality({ agentSettings });
    switch (spawnName) {
      case 'coverage-capture':
        return quality?.coverage?.timeoutMs ?? null;
      case 'check-maintainability':
        return quality?.maintainability?.refreshTimeoutMs ?? null;
      case 'check-crap':
        return quality?.crap?.refreshTimeoutMs ?? null;
      case 'format-autofix':
        return quality?.formatAutofix?.timeoutMs ?? null;
      default:
        return null;
    }
  } catch {
    // resolveConfig failures here are diagnostic-only; the close envelope
    // still surfaces the timeout outcome.
    return null;
  }
}

/**
 * Apply the `agent::blocked` transition + friction comment when one of the
 * close-time spawns exits 124. Best-effort: failures here are logged but
 * do not interrupt the close-result envelope — the operator must see the
 * timeout outcome regardless of whether the upsert/transition writes
 * succeeded.
 *
 * Story #2136 / Task #2143 introduced this for `coverage-capture`; Story
 * #2165 generalised it to cover the format-autofix + baseline-refresh
 * spawns. The `spawnName` selects the friction-body descriptor and the
 * config key the body suggests bumping.
 *
 * @param {{
 *   storyId: number|string,
 *   epicId?: number|string|null,
 *   spawnName: string,
 *   spawnCmd?: string|null,
 *   timeoutMs?: number|null,
 *   exitCode?: number|null,
 *   agentSettings?: object,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   reason?: string,
 * }} input
 */
async function emitSpawnTimeoutBlockedResult({
  storyId,
  epicId,
  spawnName,
  spawnCmd = null,
  timeoutMs: providedTimeoutMs = null,
  exitCode = 124,
  agentSettings,
  provider,
  progress: log,
  reason,
  bus = null,
}) {
  const timeoutMs =
    providedTimeoutMs ?? resolveSpawnTimeoutMs(spawnName, agentSettings);

  const body = renderSpawnTimeoutFrictionBody({
    storyId,
    epicId,
    timeoutMs,
    spawnName,
    spawnCmd,
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
      `[story-close] failed to upsert ${spawnName}-timeout friction comment on #${storyId}: ${err?.message ?? err}`,
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

  // Story #2241 / Task #2247 — emit `story.blocked` so the lifecycle
  // bus carries a typed reason token (`timeout:biome-format`,
  // `timeout:baseline-refresh`, `timeout:coverage-capture`). The
  // BlockerHandler listener (Task #2246) subscribes to this and
  // cascades to `epic.blocked` with `sourceStoryId`. Best-effort —
  // the emit must not withhold the close-result envelope.
  await emitStoryBlockedSafe({
    bus,
    storyId,
    reason: resolveSpawnTimeoutReason(spawnName),
    logger: Logger,
  });

  const descriptor = resolveSpawnTimeoutDescriptor(spawnName);
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: reason ?? `${spawnName}-timeout`,
    gateName: spawnName,
    exitCode: exitCode ?? 124,
    timeoutMs,
    commentId,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  log(
    'BLOCKED',
    `Story #${storyId} blocked: \`${spawnCmd || descriptor.defaultCmd}\` exceeded ${timeoutMs ?? 'configured'}ms — flipped to ${STATE_LABELS.BLOCKED}.`,
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

  // Story #2241 / Task #2247 — wire a lifecycle bus + ledger writer for
  // the close path. The writer points at the same Epic-scoped NDJSON
  // ledger the wave loop populates (`temp/epic-<id>/lifecycle.ndjson`),
  // so a sub-agent's `story.merged` / `story.blocked` emits land
  // alongside the parent runner's `wave.*` / `story.dispatch.*` records.
  // Best-effort: a wiring failure (bad schemaDir, missing temp root)
  // logs and falls through with `bus = null` — the close result must
  // never depend on lifecycle observability.
  let bus = null;
  try {
    const lifecycleBus = createBus();
    const tempRoot = tempRootFrom({ agentSettings, orchestration });
    const ledger = createLedgerWriter({
      epicId: Number(epicId),
      tempRoot,
    });
    ledger.register(lifecycleBus);
    bus = lifecycleBus;
  } catch (err) {
    Logger.warn?.(
      `[story-close] ⚠️ lifecycle bus init failed (continuing without emits): ${err?.message ?? err}`,
    );
  }

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
          bus,
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
  //
  // Story #2165 — `runFormatAutofix` now applies a bounded wall-clock to
  // the formatter spawn (default 60 s, tuned via
  // `delivery.quality.formatAutofix.timeoutMs`). On SIGKILL it returns a
  // `timedOut` envelope rather than throwing; we surface that as the
  // same `{ status: 'blocked-timeout' }` shape the coverage-capture
  // watchdog uses, so the outer dispatch handles every close-time
  // spawn timeout through one path.
  const formatAutofixOutcome = runFormatAutofix({
    cwd,
    storyId,
    agentSettings,
    logger: Logger,
  });
  if (formatAutofixOutcome?.timedOut) {
    return {
      status: 'blocked-timeout',
      gateName: 'format-autofix',
      exitCode: formatAutofixOutcome.exitCode ?? 124,
      spawnCmd: formatAutofixOutcome.writeCmdString ?? null,
      timeoutMs: formatAutofixOutcome.timeoutMs ?? null,
    };
  }
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
  // Story #2205 — `committed` is the new under-cap outcome (one
  // `chore(baselines): refresh <kind> for story-<id>` commit per kind
  // that actually drifted). `amended` is the legacy alias retained for
  // any in-flight callers that still inspect the historical status name.
  if (
    refreshResult?.status === 'committed' ||
    refreshResult?.status === 'amended'
  ) {
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Committed bounded baseline drift on Story branch (${refreshResult.sha}).`,
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
  bus = null,
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
      return emitBaselineBlockedResult({
        storyId,
        gateOutcome,
        progress,
        bus,
      });
    }
    // Story #2136 / Task #2143 — coverage-capture exit 124 is a bounded-
    // timeout trip, not a test-suite failure. Flip the Story to
    // `agent::blocked` + post a friction comment naming the timeout, then
    // short-circuit the close. The hang is recoverable (operator either
    // bumps the budget or fixes the runaway test), so we do not fall
    // through to merge.
    //
    // Story #2165 — the same `blocked-timeout` shape now covers
    // `format-autofix` and the baseline-refresh spawns; dispatch through
    // the generalised emitter so each spawn gets its own descriptor +
    // config-key hint in the friction body.
    if (gateOutcome?.status === 'blocked-timeout') {
      return emitSpawnTimeoutBlockedResult({
        storyId,
        epicId,
        spawnName: gateOutcome.gateName ?? 'coverage-capture',
        spawnCmd: gateOutcome.spawnCmd ?? null,
        timeoutMs: gateOutcome.timeoutMs ?? null,
        exitCode: gateOutcome.exitCode ?? 124,
        agentSettings,
        provider,
        progress,
        bus,
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
      bus,
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
    bus,
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
