#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-close.js — Story Execution Closure (CLI shell).
 *
 * Thin pipeline that wires the phase modules under
 * `lib/orchestration/story-close/phases/`. Each phase runs as a discrete
 * step and may short-circuit the pipeline with a `{ status: 'blocked' }`
 * envelope. Pipeline shape:
 *
 *   1. parse + resolveCloseInputs (lib/orchestration/story-close/close-inputs.js)
 *   2. preflight                  (phases/preflight.js)
 *   3. state-flip → closing       (inline helper below)
 *   4. capture starting branch    (phases/branch-restore.js)
 *   5. acquire per-Epic merge lock + run the locked pipeline
 *      (phases/locked-pipeline.js — gates, refresh, close)
 *   6. restore starting branch    (finally; phases/branch-restore.js)
 *
 * Usage: `node story-close.js --story <ID> [--epic <ID>]`. Exit codes:
 *   0  ok
 *   1  error
 *   2  prior-state (pass --resume / --restart) OR preflight refused
 *
 * @see .agents/workflows/helpers/deliver-stories.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { tempRootFrom } from './lib/config/temp-paths.js';
import { Logger } from './lib/Logger.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import { createLedgerWriter } from './lib/orchestration/lifecycle/ledger-writer.js';
import { checkCdOutGuard } from './lib/orchestration/story-close/cd-out-guard.js';
import { resolveCloseInputs } from './lib/orchestration/story-close/close-inputs.js';
import { withEpicMergeLock } from './lib/orchestration/story-close/merge-runner.js';
import {
  captureStartingBranch,
  restoreStartingBranch,
} from './lib/orchestration/story-close/phases/branch-restore.js';
import { runStoryCloseLocked } from './lib/orchestration/story-close/phases/locked-pipeline.js';
import {
  emitPreflightBlockedResult,
  runStoryClosePreflight,
} from './lib/orchestration/story-close/phases/preflight.js';
import { describeAutoRefreshOutcome } from './lib/orchestration/story-close/phases/refresh.js';
import {
  renderCoverageTimeoutFrictionBody,
  renderSpawnTimeoutFrictionBody,
  resolveSpawnTimeoutReason,
} from './lib/orchestration/story-close/phases/timeout-blocked.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './lib/orchestration/ticketing.js';
import { PREFLIGHT_REFUSED_EXIT_CODE } from './lib/preflight-runner.js';
import { notify } from './notify.js';

// Re-exports preserved for historical test imports. Each underlying
// implementation now lives under `phases/`.
export {
  captureStartingBranch,
  checkCdOutGuard,
  describeAutoRefreshOutcome,
  renderCoverageTimeoutFrictionBody,
  renderSpawnTimeoutFrictionBody,
  resolveSpawnTimeoutReason,
  restoreStartingBranch,
  runStoryClosePreflight,
};

const progress = Logger.createProgress('story-close', { stderr: true });
const progressLog = (tag, msg) => progress(tag, msg);

/**
 * Best-effort lifecycle-bus wiring. Story #2241 / Task #2247 — bus emits
 * land in the Epic-scoped NDJSON ledger so a sub-agent's `story.merged` /
 * `story.blocked` records sit alongside the parent runner's `wave.*`.
 * A wiring failure logs and returns `null` — the close result must never
 * depend on lifecycle observability.
 */
function wireLifecycleBus({ epicId, config }) {
  try {
    const lifecycleBus = createBus();
    const tempRoot = tempRootFrom(config);
    const ledger = createLedgerWriter({
      epicId: Number(epicId),
      tempRoot,
    });
    ledger.register(lifecycleBus);
    return lifecycleBus;
  } catch (err) {
    Logger.warn?.(
      `[story-close] ⚠️ lifecycle bus init failed (continuing without emits): ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Phase 3 — flip the Story label to `agent::closing` once preflight has
 * passed and before we acquire the per-Epic merge lock. Best-effort.
 */
async function transitionToClosing({ provider, storyId, notifyFn }) {
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
  const resolved = await resolveCloseInputs({
    storyIdParam,
    epicIdParam,
    skipDashboardParam,
    skipValidationParam,
    cwdParam,
    resumeParam,
    restartParam,
    injectedProvider,
  });
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
    config,
    provider,
    story,
    epicBranch,
    storyBranch,
  } = resolved;

  const notifyFn = (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, { config, provider, ...opts });

  const bus = wireLifecycleBus({ epicId, config });

  progress('INIT', `Closing Story #${storyId}...`);

  // Phase 2 — preflight (exit-code 2 reservation when refused).
  const preflightOutcome = await runStoryClosePreflight({ storyId, cwd });
  if (!preflightOutcome.ok) {
    const blockedResult = await emitPreflightBlockedResult({
      storyId,
      preflight: preflightOutcome,
      progress,
    });
    return {
      success: false,
      result: blockedResult,
      exitCode: PREFLIGHT_REFUSED_EXIT_CODE,
    };
  }

  // Phase 3 — flip Story → `agent::closing`.
  await transitionToClosing({ provider, storyId, notifyFn });

  // Phase 4 — capture the starting branch so the `finally` block can
  // restore it on any throw inside the merge-lock-protected region.
  const startingBranch = captureStartingBranch(cwd);
  if (!startingBranch.ok) {
    Logger.warn?.(
      `[story-close] branch-restore: could not capture starting branch (${startingBranch.reason}); finally-block restore will be skipped.`,
    );
  }

  // Phase 5 — acquire per-Epic merge lock for the entire close flow.
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
          config,
          provider,
          story,
          epicBranch,
          storyBranch,
          notifyFn,
          bus,
          progress,
          progressLog,
        }),
    );
  } finally {
    restoreStartingBranch({ cwd, captured: startingBranch });
  }
}

runAsCli(
  import.meta.url,
  async () => {
    const envelope = await runStoryClose();
    if (envelope?.exitCode === PREFLIGHT_REFUSED_EXIT_CODE) {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
    // Story #2840 — a blocked envelope (code-review-critical, etc.) carries
    // its own exit code so the CLI fails non-zero without losing the
    // envelope shape that callers serialise.
    if (Number.isInteger(envelope?.exitCode) && envelope.exitCode !== 0) {
      process.exit(envelope.exitCode);
    }
    return envelope;
  },
  {
    source: 'story-close',
    onError: (err) => {
      // exitCode=2 covers two reservations: dispatchRecovery's
      // prior-state refusal AND Story #1289's preflight refusal.
      if (err?.exitCode === 2) process.exit(2);
      Logger.error(`[phase=fatal] [story-close] ${err.stack || err.message}`);
      process.exit(1);
    },
  },
);
