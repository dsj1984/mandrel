/**
 * close-validation/runner.js — The `runCloseValidation` orchestrator.
 *
 * Runs typecheck, lint, test, format check, and maintainability/coverage/
 * CRAP regression checks before the story merge so drift is caught in the
 * worktree rather than at pre-push time on the Epic branch. All gates
 * inherit stdio so the operator sees the raw output; the returned summary
 * surfaces actionable hints on failure.
 */

import {
  recordPass as defaultRecordPass,
  shouldSkip as defaultShouldSkip,
  hashCommandConfig,
} from '../validation-evidence.js';
import {
  isFormatterEligible,
  listChangedFilesForFormatGate,
} from './commands.js';
import { DEFAULT_GATES, partitionGates } from './gates.js';
import { defaultGateRunner } from './process.js';
import { defaultGetHeadSha } from './projections/head-sha.js';

/** @typedef {import('./gates.js').Gate} Gate */

function applyChangedFileScope({ gate, spawnCwd, log }) {
  if (!gate.changedFileScope) {
    return { gate, cmd: gate.cmd, args: gate.args, skip: false };
  }
  const changedFiles = listChangedFilesForFormatGate({
    cwd: spawnCwd,
    baseRef: gate.changedFileScope.baseRef,
  });
  // Filter to the formatter-eligible subset before deciding to skip. A
  // non-empty diff that contains zero formatter-eligible files (e.g. a
  // docs-only Story) must take the skip path, not invoke biome with only
  // ineligible paths — biome reports "No files were processed" and exits 1
  // in that case (Story #3410).
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
  return {
    gate,
    cmd: gate.cmd,
    args: [...args, ...eligibleFiles],
    skip: false,
  };
}

/**
 * Run every gate sequentially. Stops collecting after the first failure but
 * still returns a summary so the caller decides how to surface the result.
 *
 * Worktree locality (Story #1120): when `worktreePath` is supplied, every
 * gate runner is spawned with `cwd: worktreePath` so the gate sees the
 * Story branch's post-rebase tree. Evidence reads/writes still key against
 * `cwd` (the main checkout) because the per-Epic temp tree lives under
 * the main `.git/`. Failure messages name the worktree path.
 *
 * Evidence-aware: when both `storyId` and `epicId` are provided and
 * `useEvidence !== false`, each gate consults `validation-evidence
 * .shouldSkip()` against current HEAD + the gate's command-config hash. A
 * matching record skips the gate; a successful run is recorded so the
 * next caller in the local hot path can skip in turn.
 *
 * `onGateStart` is invoked immediately before each gate's runner spawn.
 * story-close uses it to drive `phaseTimer.mark(...)` for per-gate
 * wall-clock telemetry. Errors thrown from the hook propagate.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath?: string,
 *   gates?: Gate[],
 *   runner?: (cmd: string, args: string[], opts: { cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void }) => Promise<{ status: number }> | { status: number },
 *   log?: (m: string) => void,
 *   onGateStart?: (gate: Gate) => void,
 *   storyId?: number|null,
 *   epicId?: number|null,
 *   useEvidence?: boolean,
 *   evidenceClock?: () => number,
 *   getHeadSha?: (cwd: string) => string|null,
 *   recordPass?: typeof defaultRecordPass,
 *   shouldSkip?: typeof defaultShouldSkip,
 * }} opts
 * @returns {{ ok: boolean, failed: Array<{ gate: Gate, status: number, cwd: string }>, skipped: Array<{ gate: Gate, reason: string }> }}
 */
export async function runCloseValidation({
  cwd,
  worktreePath,
  gates = DEFAULT_GATES,
  runner = defaultGateRunner,
  log = () => {},
  onGateStart,
  storyId = null,
  epicId = null,
  useEvidence = true,
  evidenceClock = () => Date.now(),
  getHeadSha = (resolvedCwd) => defaultGetHeadSha(resolvedCwd),
  recordPass = defaultRecordPass,
  shouldSkip = defaultShouldSkip,
} = {}) {
  const failed = [];
  const skipped = [];
  const evidenceActive = useEvidence && storyId != null && epicId != null;
  // Evidence keys against the main checkout's HEAD because the per-Epic
  // evidence file lives under the main `.git/`. Gate spawn, in contrast,
  // runs in the worktree when one is supplied — that's the whole point of
  // Story #1120.
  const spawnCwd = worktreePath ?? cwd;
  const headSha = evidenceActive ? getHeadSha(spawnCwd) : null;

  // Helper closures so the parallel and serial passes share evidence
  // bookkeeping bit-for-bit.

  /** Returns a `{ skip: true }` verdict when evidence makes the gate redundant. */
  const evidenceVerdict = (gate, configHash) => {
    if (!(evidenceActive && headSha)) return { skip: false };
    const verdict = shouldSkip(
      {
        storyId,
        gateName: gate.name,
        currentSha: headSha,
        configHash,
        inputFingerprint: gate.inputFingerprint ?? null,
      },
      { cwd, epicId },
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
          inputFingerprint: gate.inputFingerprint ?? null,
        },
        { cwd, epicId },
      );
    } catch (err) {
      log(
        `[close-validation]   ⚠ failed to record evidence for ${gate.name}: ${err?.message ?? err}`,
      );
    }
  };

  /**
   * Run a single gate. When `gate.run` is a function the gate executes
   * **in process** (Story #1973 / Task #1984 — per-kind baseline gates
   * removed their `child_process.spawn(node check-<kind>.js)` arm and
   * call `compare(head, base)` directly). The `run` callable receives
   * the same `(cmd, args, opts)` argv shape as `runner` so it slots into
   * the existing contract without churn at the runner boundary.
   * Otherwise the supplied `runner` is used (default: spawn).
   *
   * @returns {Promise<{ status: number }>}
   */
  const dispatchGate = async (gate, signal) => {
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
      ...(gate.env ? { env: gate.env } : {}),
    });
    return { status: result?.status ?? 1 };
  };

  const { independent, serial } = partitionGates(gates);

  // ── Phase 1: independent gates in parallel ──────────────────────────
  // First non-zero exit pins `firstFailure` and aborts every in-flight
  // sibling via SIGTERM. Other gates' results are still awaited (so we
  // never leak children) but their non-zero status is intentionally
  // dropped: only one error surfaces.
  const ac = new AbortController();
  let firstIndepFailure = null;

  const indepTasks = independent.map(async (gate) => {
    let execution;
    try {
      execution = applyChangedFileScope({ gate, spawnCwd, log });
    } catch (err) {
      if (!firstIndepFailure) {
        firstIndepFailure = { gate, status: 1, cwd: spawnCwd };
        log(
          `[close-validation] ✖ ${gate.name} failed to resolve changed-file scope: ${err?.message ?? err}`,
        );
        ac.abort();
      }
      return;
    }
    if (execution.skip) {
      skipped.push({ gate, reason: 'no-changed-files' });
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
        { ...gate, cmd: execution.cmd, args: execution.args },
        ac.signal,
      );
    } catch (err) {
      result = { status: 1, error: err };
    }
    if (result.status !== 0) {
      if (!firstIndepFailure) {
        firstIndepFailure = { gate, status: result.status, cwd: spawnCwd };
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
    failed.push(firstIndepFailure);
    log(
      `[close-validation] ✖ ${firstIndepFailure.gate.name} failed (exit ${firstIndepFailure.status}) in ${spawnCwd}`,
    );
    if (firstIndepFailure.gate.hint) {
      log(`[close-validation]   hint: ${firstIndepFailure.gate.hint}`);
    }
    return { ok: false, failed, skipped };
  }

  // ── Phase 2: serial gates in declared order ─────────────────────────
  for (const gate of serial) {
    let execution;
    try {
      execution = applyChangedFileScope({ gate, spawnCwd, log });
    } catch (err) {
      failed.push({ gate, status: 1, cwd: spawnCwd });
      log(
        `[close-validation] ✖ ${gate.name} failed to resolve changed-file scope: ${err?.message ?? err}`,
      );
      if (gate.hint) log(`[close-validation]   hint: ${gate.hint}`);
      break;
    }
    if (execution.skip) {
      skipped.push({ gate, reason: 'no-changed-files' });
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
    const result = await dispatchGate({
      ...gate,
      cmd: execution.cmd,
      args: execution.args,
    });
    if (result.status !== 0) {
      failed.push({ gate, status: result.status, cwd: spawnCwd });
      log(
        `[close-validation] ✖ ${gate.name} failed (exit ${result.status}) in ${spawnCwd}`,
      );
      if (gate.hint) log(`[close-validation]   hint: ${gate.hint}`);
      break;
    }
    log(`[close-validation] ✓ ${gate.name}`);
    recordIfActive(
      gate,
      configHash,
      evidenceActive ? evidenceClock() - startedAt : 0,
    );
  }

  return { ok: failed.length === 0, failed, skipped };
}
