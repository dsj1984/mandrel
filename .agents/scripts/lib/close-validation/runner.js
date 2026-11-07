/**
 * Runs the close gates (typecheck, lint, test, format, baselines) in the
 * Story worktree before merge; the summary carries failure hints.
 */

import { getQuality } from '../config/quality.js';
import {
  COVERAGE_HOST_RESOURCES_EXIT_CODE,
  COVERAGE_OVER_BUDGET_EXIT_CODE,
  COVERAGE_TIMEOUT_EXIT_CODE,
} from '../coverage-capture.js';
import {
  fullSuiteLockPolicy,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
} from '../full-suite-lock.js';
import { gitSpawn } from '../git-utils.js';
import {
  recordPass as defaultRecordPass,
  shouldSkip as defaultShouldSkip,
  treeFingerprint as defaultTreeFingerprint,
  hashCommandConfig,
} from '../validation-evidence.js';
import { presetCiDeferral } from './ci-deferral.js';
import {
  isFormatterEligible,
  listChangedFilesForFormatGate,
} from './commands.js';
import {
  COVERAGE_DEFERRED_SKIP_REASON,
  DEFAULT_GATES,
  GATE_TIMEOUT_HINT,
  OVER_BUDGET_BLOCK_HINT,
  partitionGates,
  withFailureRows,
} from './gates.js';
import { defaultGateRunner } from './process.js';
import { runProjectionAdvisories as defaultRunProjections } from './projections/advisories.js';
import { defaultGetHeadSha } from './projections/head-sha.js';

/** @typedef {import('./gates.js').Gate} Gate */

/**
 * Classify a non-zero gate exit and log it as what it is: `75` is an expired
 * full-suite lock wait (nothing ran), `124` a killed suite (no verdict), and
 * `76` an over-budget capture the policy blocks (a deferring gate never gets
 * here), `77` a suite gate that lost workers to host memory, and anything else a real failure with the gate's own hint. Returns the
 * `failed[]` entry, carrying `outcome` so callers never re-derive it; its
 * `gate.hint` is the one that fits the outcome (none when deferred), so a
 * caller replaying it never prints the failing-tests hint for a non-failure.
 *
 * @param {{ gate: Gate, status: number, cwd: string, log: (m: string) => void, failureRows?: string[] }} args
 * @returns {{ gate: Gate, status: number, cwd: string, outcome: 'deferred'|'timeout'|'over-budget'|'host-resources'|'failed' }}
 */
function reportGateExit({ gate, status, cwd, log, failureRows }) {
  if (status === LOCK_WAIT_EXPIRED_EXIT_CODE) {
    log(
      `[close-validation] ⏸ ${gate.name} deferred (exit ${status}) — the full-suite lock wait expired, so nothing ran in ${cwd}`,
    );
    const { hint: _failureHint, ...deferredGate } = gate;
    return { gate: deferredGate, status, cwd, outcome: 'deferred' };
  }
  const hinted = hintedExit(gate, status);
  if (hinted) return reportHintedExit({ gate, status, cwd, log, ...hinted });
  log(`[close-validation] ✖ ${gate.name} failed (exit ${status}) in ${cwd}`);
  const failedGate = withFailureRows(gate, failureRows);
  if (failedGate.hint) log(`[close-validation]   hint: ${failedGate.hint}`);
  return { gate: failedGate, status, cwd, outcome: 'failed' };
}

export function applyChangedFileScope({ gate, spawnCwd, log }) {
  // A skip decided when the gate list was built wins over everything.
  if (gate.skip) {
    log(`[close-validation] ⏭ ${gate.name} skipped (${gate.skip.reason})`);
    return {
      gate,
      cmd: gate.cmd,
      args: gate.args,
      skip: true,
      skipReason: gate.skip.reason,
    };
  }
  if (!gate.changedFileScope) {
    return { gate, cmd: gate.cmd, args: gate.args, skip: false };
  }
  const changedFiles = listChangedFilesForFormatGate({
    cwd: spawnCwd,
    baseRef: gate.changedFileScope.baseRef,
  });
  // Biome exits 1 ("No files were processed") on only-ineligible paths.
  const eligibleFiles = changedFiles.filter(isFormatterEligible);
  if (eligibleFiles.length === 0) {
    log(
      `[close-validation] ⏭ ${gate.name} skipped (no formatter-eligible changed files)`,
    );
    return { gate, cmd: gate.cmd, args: gate.args, skip: true };
  }
  const args =
    gate.args[gate.args.length - 1] === '.'
      ? gate.args.slice(0, -1)
      : gate.args;
  log(
    `[close-validation] ↳ ${gate.name} scoped to ${eligibleFiles.length} formatter-eligible changed file(s) from ${gate.changedFileScope.baseRef}...HEAD`,
  );
  // The extension filter cannot see biome's config ignores; if every path is
  // config-ignored biome exits 1 "No files were processed" — downgrade that.
  return {
    gate,
    cmd: gate.cmd,
    args: [...args, ...eligibleFiles],
    skip: false,
    tolerateNoFilesProcessed: true,
  };
}

/**
 * Independent gates run in parallel (first failure aborts the rest), then
 * serial gates in order, stopping at the first failure. Gates spawn in
 * `worktreePath`; evidence is keyed to `cwd` (main checkout). With
 * `storyId` + `standalone`, a matching evidence record skips a gate and a
 * pass is recorded. Projection advisories run only after every gate passes
 * and never affect `ok`. `onGateStart` errors propagate.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath?: string,
 *   gates?: Gate[],
 *   baseBranch?: string|null,
 *   storyBranch?: string|null,
 *   config?: object|null,
 *   runProjections?: typeof defaultRunProjections,
 *   runner?: (cmd: string, args: string[], opts: { cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void }) => Promise<{ status: number }> | { status: number },
 *   log?: (m: string) => void,
 *   lockEvents?: object|null,
 *   onGateStart?: (gate: Gate) => void,
 *   storyId?: number|null,
 *   standalone?: boolean,
 *   useEvidence?: boolean,
 *   evidenceClock?: () => number,
 *   getHeadSha?: (cwd: string) => string|null,
 *   getTreeFingerprint?: (cwd: string) => string|null,
 *   recordPass?: typeof defaultRecordPass,
 *   shouldSkip?: typeof defaultShouldSkip,
 * }} opts An expired full-suite lock wait spawns nothing (here or in any gate
 *   child) and reports `LOCK_WAIT_EXPIRED_EXIT_CODE`.
 * @returns {{ ok: boolean, failed: Array<{ gate: Gate, status: number, cwd: string, outcome: 'deferred'|'timeout'|'over-budget'|'host-resources'|'failed' }>, skipped: Array<{ gate: Gate, reason: string }>, deferred: Array<{ gate: Gate, status: number|null, reason: 'over-budget'|'suite-of-record-ci' }> }}
 *   `outcome` classifies the exit: `deferred` (75), `timeout` (124),
 *   `over-budget` (76 under `block`), `host-resources` (77 from a suite gate),
 *   else `failed`. `deferred[]` holds a
 *   `deferOnOverBudget` gate that exited 76, or a `suiteOfRecordCi` capture
 *   never spawned: not a failure, no evidence.
 */
export async function runCloseValidation({
  cwd,
  worktreePath,
  gates = DEFAULT_GATES,
  runner = defaultGateRunner,
  log = () => {},
  lockEvents = null,
  onGateStart,
  baseBranch = null,
  storyBranch = null,
  config = null,
  runProjections = defaultRunProjections,
  storyId = null,
  standalone = false,
  useEvidence = true,
  evidenceClock = () => Date.now(),
  getHeadSha = (resolvedCwd) => defaultGetHeadSha(resolvedCwd),
  getTreeFingerprint = (resolvedCwd) =>
    defaultTreeFingerprint(resolvedCwd, gitSpawn),
  recordPass = defaultRecordPass,
  shouldSkip = defaultShouldSkip,
} = {}) {
  const failed = [];
  const deferred = [];
  const lockOpts = fullSuiteLockOptions({ config, lockEvents });
  const skipped = [];
  const evidenceActive = useEvidence && storyId != null && standalone;
  const evidenceStoreOpts = { cwd, standalone };
  const spawnCwd = worktreePath ?? cwd;
  const headSha = evidenceActive ? getHeadSha(spawnCwd) : null;
  // One whole-tree fingerprint for every gate: a per-gate read set that is
  // modelled wrong would grant a skip the gate did not earn. A gate's own
  // `inputFingerprint` still wins.
  const treeSha = evidenceActive ? getTreeFingerprint(spawnCwd) : null;

  const evidenceVerdict = (gate, configHash) => {
    if (!(evidenceActive && headSha)) return { skip: false };
    const verdict = shouldSkip(
      {
        storyId,
        gateName: gate.name,
        currentSha: headSha,
        configHash,
        inputFingerprint: gate.inputFingerprint ?? treeSha,
      },
      evidenceStoreOpts,
    );
    if (verdict.skip) {
      const tsHint = verdict.record?.timestamp
        ? ` recorded ${verdict.record.timestamp}`
        : '';
      log(
        `[close-validation] ⏭ ${gate.name} skipped (${verdict.reason}: SHA=${headSha.slice(0, 7)}${tsHint})`,
      );
    }
    return verdict;
  };

  const recordIfActive = (gate, configHash, durationMs) => {
    if (!(evidenceActive && headSha)) return;
    try {
      recordPass(
        {
          storyId,
          gateName: gate.name,
          sha: headSha,
          configHash,
          exitCode: 0,
          durationMs,
          inputFingerprint: gate.inputFingerprint ?? treeSha,
          ...gate.evidenceNote,
        },
        evidenceStoreOpts,
      );
    } catch (err) {
      log(
        `[close-validation]   ⚠ failed to record evidence for ${gate.name}: ${err?.message ?? err}`,
      );
    }
  };

  /**
   * A `gate.run` function executes in process with the `runner` signature.
   *
   * @returns {Promise<{ status: number }>}
   */
  const dispatchGate = async (gate, signal, configHash) => {
    log(
      `[close-validation] ▶ ${gate.label ?? gate.name}${worktreePath ? ` (cwd=${worktreePath})` : ''}`,
    );
    if (typeof onGateStart === 'function') onGateStart(gate);
    const dispatcher = typeof gate.run === 'function' ? gate.run : runner;
    const result = await dispatcher(gate.cmd, gate.args, {
      cwd: spawnCwd,
      gateName: gate.name,
      log,
      signal,
      ...lockOpts.forGate(gate),
      // Whoever held the full-suite lock may have deposited this gate's
      // evidence meanwhile; re-check after the wait instead of spawning.
      ...(gate.fullSuiteLock && configHash
        ? {
            skipIfSatisfied: () =>
              evidenceVerdict(gate, configHash).skip
                ? { status: 0 }
                : undefined,
          }
        : {}),
      // Unconditional: the runner treats falsy as "no lock".
      fullSuiteLock: gate.fullSuiteLock,
      ...(gate.tolerateNoFilesProcessed
        ? { tolerateNoFilesProcessed: true }
        : {}),
      retainFailureRows: gate.retainFailureRows,
    });
    return { status: result?.status ?? 1, failureRows: result?.failureRows };
  };

  const { independent, serial } = partitionGates(gates);

  // Phase 1. The first failure aborts siblings; they are still awaited (no
  // leaked children) but only one error surfaces.
  const ac = new AbortController();
  let firstIndepFailure = null;

  const indepTasks = independent.map(async (gate) => {
    let execution;
    try {
      execution = applyChangedFileScope({ gate, spawnCwd, log });
    } catch (err) {
      if (!firstIndepFailure) {
        firstIndepFailure = { gate, status: 1 };
        log(
          `[close-validation] ✖ ${gate.name} failed to resolve changed-file scope: ${err?.message ?? err}`,
        );
        ac.abort();
      }
      return;
    }
    if (execution.skip) {
      skipped.push({
        gate,
        reason: execution.skipReason ?? 'no-changed-files',
      });
      return;
    }
    const configHash = gateConfigHash(gate, execution, spawnCwd);
    const verdict = evidenceVerdict(gate, configHash);
    if (verdict.skip) {
      skipped.push({ gate, reason: verdict.reason });
      return;
    }
    const startedAt = evidenceActive ? evidenceClock() : 0;
    let result;
    try {
      result = await dispatchGate(
        {
          ...gate,
          cmd: execution.cmd,
          args: execution.args,
          tolerateNoFilesProcessed: execution.tolerateNoFilesProcessed,
        },
        ac.signal,
        configHash,
      );
    } catch (err) {
      result = { status: 1, error: err };
    }
    if (result.status !== 0) {
      if (!firstIndepFailure) {
        firstIndepFailure = { ...result, gate };
        ac.abort();
      }
      return;
    }
    log(`[close-validation] ✓ ${gate.name}`);
    recordIfActive(
      gate,
      configHash,
      evidenceActive ? evidenceClock() - startedAt : 0,
    );
  });

  await Promise.all(indepTasks);

  if (firstIndepFailure) {
    failed.push(reportGateExit({ ...firstIndepFailure, cwd: spawnCwd, log }));
    return { ok: false, failed, skipped, deferred };
  }

  await runSerialGates(serial, {
    spawnCwd,
    log,
    failed,
    skipped,
    deferred,
    evidenceActive,
    evidenceClock,
    evidenceVerdict,
    recordIfActive,
    dispatchGate,
  });

  if (failed.length === 0) {
    await runAdvisoryProjections({
      runProjections,
      cwd: spawnCwd,
      baseBranch,
      storyBranch,
      config,
      log,
    });
  }

  return { ok: failed.length === 0, failed, skipped, deferred };
}

/** The gate's `evidenceIdentity` argv hash, else its spawned argv's. */
function gateConfigHash(gate, execution, cwd) {
  const { cmd, args } = gate.evidenceIdentity ?? execution;
  return hashCommandConfig({ cmd, args, cwd });
}

/**
 * The `fullSuiteLock` gate shares coverage capture's timeout
 * (`coverage.timeoutMs`) so a hung suite fails instead of holding the host
 * lock; the same figure bounds its lock wait (`resolveFullSuiteLockBudget`).
 *
 * @param {{ config: object|null, lockEvents: object|null }} args
 * @returns {{ forGate: (gate: object) => object }}
 */
function fullSuiteLockOptions({ config, lockEvents }) {
  const timeoutMs = getQuality(config).coverage?.timeoutMs;
  return {
    forGate(gate) {
      const env = gateEnv(gate, lockEvents);
      return {
        ...(env ? { env } : {}),
        ...(lockEvents ? { onLockEvent: lockEvents.emit } : {}),
        ...(gate.fullSuiteLock
          ? fullSuiteGateOptions(gate, timeoutMs, config)
          : {}),
      };
    },
  };
}

/** Any child but a `lockEventChannel` one would leak the channel to tests. */
function gateEnv(gate, lockEvents) {
  if (!(gate.lockEventChannel && lockEvents)) return gate.env;
  return { ...lockEvents.env, ...gate.env };
}

/**
 * A full-suite gate's kill bound, the command its lock-expiry line names, and
 * the admission policy evidence-gate and coverage-capture resolve too — so
 * `fullSuiteLock: false` / `MANDREL_FULL_SUITE_LOCK=0` reach close as well.
 *
 * @param {{ cmd: string, args?: string[] }} gate
 * @param {number} timeoutMs
 * @param {object|null} config
 */
function fullSuiteGateOptions(gate, timeoutMs, config) {
  const argv = [gate.cmd, ...(gate.args ?? [])];
  const { enabled, capacity, workload } = fullSuiteLockPolicy(
    config,
    process.env,
    argv,
  );
  return {
    timeoutMs,
    lockOptions: { rerunCommand: argv.join(' '), enabled, capacity, workload },
  };
}

/**
 * Mutates the caller's `failed` / `skipped` accumulators.
 *
 * @param {Array<object>} serial
 * @param {object} deps
 * @returns {Promise<void>}
 */
async function runSerialGates(
  serial,
  {
    spawnCwd,
    log,
    failed,
    skipped,
    deferred,
    evidenceActive,
    evidenceClock,
    evidenceVerdict,
    recordIfActive,
    dispatchGate,
  },
) {
  const failGate = (gate, status, failureRows) => {
    failed.push(
      reportGateExit({ gate, status, cwd: spawnCwd, log, failureRows }),
    );
  };
  for (const gate of serial) {
    const preset = presetCiDeferral(gate, { deferred, failed, log, spawnCwd });
    if (preset === 'stop') return;
    if (preset) continue;
    let execution;
    try {
      execution = resolveSerialExecution({ gate, spawnCwd, log, deferred });
    } catch (err) {
      log(
        `[close-validation] ✖ ${gate.name} failed to resolve changed-file scope: ${err?.message ?? err}`,
      );
      failGate(gate, 1);
      return;
    }
    if (execution.skip) {
      skipped.push({
        gate,
        reason: execution.skipReason ?? 'no-changed-files',
      });
      continue;
    }
    const configHash = gateConfigHash(gate, execution, spawnCwd);
    const verdict = evidenceVerdict(gate, configHash);
    if (verdict.skip) {
      skipped.push({ gate, reason: verdict.reason });
      continue;
    }
    const startedAt = evidenceActive ? evidenceClock() : 0;
    const result = await dispatchGate(
      {
        ...gate,
        cmd: execution.cmd,
        args: execution.args,
        tolerateNoFilesProcessed: execution.tolerateNoFilesProcessed,
      },
      undefined,
      configHash,
    );
    const recordPass = () =>
      recordIfActive(
        gate,
        configHash,
        evidenceActive ? evidenceClock() - startedAt : 0,
      );
    const settle = { deferred, log, spawnCwd, failGate, recordPass };
    if (settleSerialResult(gate, result, settle)) return;
  }
}

/** @param {Gate} gate @param {number} status */
function isDeferredOverBudget(gate, status) {
  return status === COVERAGE_OVER_BUDGET_EXIT_CODE && gate.deferOnOverBudget;
}

/** A suite gate's exit 76 the policy blocks. @param {Gate} gate @param {number} status */
function isBlockedOverBudget(gate, status) {
  return (
    status === COVERAGE_OVER_BUDGET_EXIT_CODE && SUITE_GATES.has(gate.name)
  );
}

/** Replaces a suite gate's own hint on exit 77: lost workers, no failing test. */
const GATE_HOST_RESOURCES_HINT =
  'The suite lost workers to host memory (exit 77) and no test failed — do not re-run it unchanged on this host. Use fewer workers or a larger host, or — when CI runs the suite with a coverage floor — have the capture script declare the slice over budget (exit 76) under `delivery.quality.gates.coverage.onOverBudget: "defer-to-ci"`.';

/** The gates that run the suite, the only ones whose 77 means lost workers. */
const SUITE_GATES = new Set(['test', 'coverage-capture']);

/**
 * A non-failure exit that carries its own hint in place of the gate's: a
 * killed suite (124), a suite that lost workers to host memory (77), or a
 * suite over budget the policy blocks (76).
 *
 * @param {Gate} gate @param {number} status
 * @returns {{ outcome: 'timeout'|'host-resources'|'over-budget', hint: string, line: string }|null}
 */
function hintedExit(gate, status) {
  if (status === COVERAGE_TIMEOUT_EXIT_CODE) {
    const line = `⏱ ${gate.name} timed out (exit ${status})`;
    return { outcome: 'timeout', hint: GATE_TIMEOUT_HINT, line };
  }
  return isBlockedOverBudget(gate, status)
    ? overBudgetExit(gate, status)
    : hostResourcesExit(gate, status);
}

/** @param {Gate} gate @param {number} status */
function overBudgetExit(gate, status) {
  const line = `✖ ${gate.name} over budget (exit ${status}) — no tests ran`;
  return { outcome: 'over-budget', hint: OVER_BUDGET_BLOCK_HINT, line };
}

/** A suite gate's 77; any other gate's 77 is an ordinary failure. @param {Gate} gate @param {number} status */
function hostResourcesExit(gate, status) {
  if (status !== COVERAGE_HOST_RESOURCES_EXIT_CODE) return null;
  if (!SUITE_GATES.has(gate.name)) return null;
  const line = `⛔ ${gate.name} lost workers to host memory (exit ${status}) — no test failed`;
  return { outcome: 'host-resources', hint: GATE_HOST_RESOURCES_HINT, line };
}

function reportHintedExit({ gate, status, cwd, log, outcome, hint, line }) {
  log(`[close-validation] ${line} in ${cwd}`);
  log(`[close-validation]   hint: ${hint}`);
  return { gate: { ...gate, hint }, status, cwd, outcome };
}

/**
 * The gate's execution: a skip once a capture deferred and the gate reads
 * its artifact, else its changed-file scope.
 */
function resolveSerialExecution({ gate, spawnCwd, log, deferred }) {
  if (deferred.length === 0 || !gate.readsCoverageArtifact) {
    return applyChangedFileScope({ gate, spawnCwd, log });
  }
  log(
    `[close-validation] ⏭ ${gate.name} skipped (${COVERAGE_DEFERRED_SKIP_REASON})`,
  );
  return { gate, skip: true, skipReason: COVERAGE_DEFERRED_SKIP_REASON };
}

/**
 * Settle a dispatched serial gate: a deferral or a pass continues (a pass is
 * logged and earns evidence), any other non-zero exit fails the chain.
 *
 * @returns {boolean} `true` when the chain must stop.
 */
function settleSerialResult(gate, result, ctx) {
  const { deferred, log, spawnCwd, failGate, recordPass } = ctx;
  if (deferOverBudget(gate, result.status, { deferred, log, spawnCwd })) {
    return false;
  }
  if (result.status !== 0) {
    failGate(gate, result.status, result.failureRows);
    return true;
  }
  log(`[close-validation] ✓ ${gate.name}`);
  recordPass();
  return false;
}

/**
 * Record a flagged capture's exit 76 as deferred to CI.
 *
 * @returns {boolean} `true` when the exit was a deferral.
 */
function deferOverBudget(gate, status, { deferred, log, spawnCwd }) {
  if (!isDeferredOverBudget(gate, status)) return false;
  log(
    `[close-validation] ⏭ ${gate.name} deferred to CI (exit ${status}, onOverBudget: defer-to-ci) — no suite ran in ${spawnCwd}`,
  );
  deferred.push({ gate, status, reason: 'over-budget' });
  return true;
}

/**
 * No-op without a branch pair; a throw is logged, never propagated.
 *
 * @param {{
 *   runProjections: typeof defaultRunProjections,
 *   cwd: string,
 *   baseBranch: string|null,
 *   storyBranch: string|null,
 *   config: object|null,
 *   log: (m: string) => void,
 * }} opts
 * @returns {Promise<void>}
 */
async function runAdvisoryProjections({
  runProjections,
  cwd,
  baseBranch,
  storyBranch,
  config,
  log,
}) {
  if (!(baseBranch && storyBranch)) return;
  try {
    await runProjections({ cwd, baseBranch, storyBranch, config, log });
  } catch (err) {
    log(
      `[close-validation]   ⚠ projection advisories skipped: ${err?.message ?? err}`,
    );
  }
}
