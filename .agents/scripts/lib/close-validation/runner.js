/**
 * Runs the close gates (typecheck, lint, test, format, baselines) in the
 * Story worktree before merge; the summary carries failure hints.
 */

import { getQuality } from '../config/quality.js';
import { COVERAGE_TIMEOUT_EXIT_CODE } from '../coverage-capture.js';
import {
  FULL_SUITE_LOCK_EXPIRY_ENV,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
} from '../full-suite-lock.js';
import { gitSpawn } from '../git-utils.js';
import {
  recordPass as defaultRecordPass,
  shouldSkip as defaultShouldSkip,
  treeFingerprint as defaultTreeFingerprint,
  hashCommandConfig,
} from '../validation-evidence.js';
import {
  isFormatterEligible,
  listChangedFilesForFormatGate,
} from './commands.js';
import { DEFAULT_GATES, GATE_TIMEOUT_HINT, partitionGates } from './gates.js';
import { defaultGateRunner } from './process.js';
import { runProjectionAdvisories as defaultRunProjections } from './projections/advisories.js';
import { defaultGetHeadSha } from './projections/head-sha.js';

/** @typedef {import('./gates.js').Gate} Gate */

/**
 * Classify a non-zero gate exit and log it as what it is: `75` is an expired
 * full-suite lock wait (nothing ran), `124` a killed suite (no verdict), and
 * anything else a real failure with the gate's own hint. Returns the
 * `failed[]` entry, carrying `outcome` so callers never re-derive it; its
 * `gate.hint` is the one that fits the outcome (none when deferred), so a
 * caller replaying it never prints the failing-tests hint for a non-failure.
 *
 * @param {{ gate: Gate, status: number, cwd: string, log: (m: string) => void }} args
 * @returns {{ gate: Gate, status: number, cwd: string, outcome: 'deferred'|'timeout'|'failed' }}
 */
function reportGateExit({ gate, status, cwd, log }) {
  if (status === LOCK_WAIT_EXPIRED_EXIT_CODE) {
    log(
      `[close-validation] ⏸ ${gate.name} deferred (exit ${status}) — the full-suite lock wait expired, so nothing ran in ${cwd}`,
    );
    const { hint: _failureHint, ...deferredGate } = gate;
    return { gate: deferredGate, status, cwd, outcome: 'deferred' };
  }
  if (status === COVERAGE_TIMEOUT_EXIT_CODE) {
    log(
      `[close-validation] ⏱ ${gate.name} timed out (exit ${status}) in ${cwd}`,
    );
    log(`[close-validation]   hint: ${GATE_TIMEOUT_HINT}`);
    return {
      gate: { ...gate, hint: GATE_TIMEOUT_HINT },
      status,
      cwd,
      outcome: 'timeout',
    };
  }
  log(`[close-validation] ✖ ${gate.name} failed (exit ${status}) in ${cwd}`);
  if (gate.hint) log(`[close-validation]   hint: ${gate.hint}`);
  return { gate, status, cwd, outcome: 'failed' };
}

function applyChangedFileScope({ gate, spawnCwd, log }) {
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
 *   onGateStart?: (gate: Gate) => void,
 *   storyId?: number|null,
 *   standalone?: boolean,
 *   useEvidence?: boolean,
 *   evidenceClock?: () => number,
 *   getHeadSha?: (cwd: string) => string|null,
 *   getTreeFingerprint?: (cwd: string) => string|null,
 *   recordPass?: typeof defaultRecordPass,
 *   shouldSkip?: typeof defaultShouldSkip,
 *   deferOnLockExpiry?: boolean,
 * }} opts `deferOnLockExpiry`: an expired full-suite lock wait spawns
 *   nothing (here or in any gate child) and reports `LOCK_WAIT_EXPIRED_EXIT_CODE`.
 * @returns {{ ok: boolean, failed: Array<{ gate: Gate, status: number, cwd: string, outcome: 'deferred'|'timeout'|'failed' }>, skipped: Array<{ gate: Gate, reason: string }> }}
 *   `outcome` classifies the exit: `deferred` (75), `timeout` (124), else `failed`.
 */
export async function runCloseValidation({
  cwd,
  worktreePath,
  gates = DEFAULT_GATES,
  runner = defaultGateRunner,
  log = () => {},
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
  deferOnLockExpiry = false,
} = {}) {
  const failed = [];
  const lockOpts = fullSuiteLockOptions({ config, deferOnLockExpiry });
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
      `[close-validation] ▶ ${gate.name}${worktreePath ? ` (cwd=${worktreePath})` : ''}`,
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
    });
    return { status: result?.status ?? 1 };
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
    const configHash = hashCommandConfig({
      cmd: execution.cmd,
      args: execution.args,
      cwd: spawnCwd,
    });
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
        firstIndepFailure = { gate, status: result.status };
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
    const { gate, status } = firstIndepFailure;
    failed.push(reportGateExit({ gate, status, cwd: spawnCwd, log }));
    return { ok: false, failed, skipped };
  }

  await runSerialGates(serial, {
    spawnCwd,
    log,
    failed,
    skipped,
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

  return { ok: failed.length === 0, failed, skipped };
}

/**
 * The `fullSuiteLock` gate shares coverage capture's timeout so a hung suite
 * fails instead of holding the host lock; the same figure bounds its lock
 * wait (`resolveFullSuiteLockBudget`), so it outwaits any live holder. Under `deferOnLockExpiry` every
 * gate child inherits the defer opt-in via env.
 *
 * @param {{ config: object|null, deferOnLockExpiry: boolean }} args
 * @returns {{ forGate: (gate: object) => object }}
 */
function fullSuiteLockOptions({ config, deferOnLockExpiry }) {
  const timeoutMs = getQuality(config).coverage?.timeoutMs;
  const deferEnv = deferOnLockExpiry
    ? { [FULL_SUITE_LOCK_EXPIRY_ENV]: 'defer' }
    : null;
  return {
    forGate(gate) {
      const env = deferEnv ? { ...gate.env, ...deferEnv } : gate.env;
      return {
        ...(env ? { env } : {}),
        ...(gate.fullSuiteLock ? { timeoutMs, deferOnLockExpiry } : {}),
      };
    },
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
    evidenceActive,
    evidenceClock,
    evidenceVerdict,
    recordIfActive,
    dispatchGate,
  },
) {
  const failGate = (gate, status) => {
    failed.push(reportGateExit({ gate, status, cwd: spawnCwd, log }));
  };
  for (const gate of serial) {
    let execution;
    try {
      execution = applyChangedFileScope({ gate, spawnCwd, log });
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
    const configHash = hashCommandConfig({
      cmd: execution.cmd,
      args: execution.args,
      cwd: spawnCwd,
    });
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
    if (result.status !== 0) {
      failGate(gate, result.status);
      return;
    }
    log(`[close-validation] ✓ ${gate.name}`);
    recordIfActive(
      gate,
      configHash,
      evidenceActive ? evidenceClock() - startedAt : 0,
    );
  }
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
