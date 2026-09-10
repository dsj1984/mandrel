/**
 * close-validation/runner.js — The `runCloseValidation` orchestrator.
 *
 * Runs typecheck, lint, test, format check, and maintainability/coverage/
 * CRAP regression checks before the story merge so drift is caught in the
 * worktree rather than at pre-push time on the Epic branch. All gates
 * inherit stdio so the operator sees the raw output; the returned summary
 * surfaces actionable hints on failure.
 */

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
import { DEFAULT_GATES, partitionGates } from './gates.js';
import { defaultGateRunner } from './process.js';
import { runProjectionAdvisories as defaultRunProjections } from './projections/advisories.js';
import { defaultGetHeadSha } from './projections/head-sha.js';

/** @typedef {import('./gates.js').Gate} Gate */

function applyChangedFileScope({ gate, spawnCwd, log }) {
  // Story #5278 — a skip the gate list already decided (the coverage-capture
  // gate whose incremental skip is known to fire). Honoured before anything
  // else so the gate is recorded as `skipped` with its real reason rather
  // than spawned to discover the same thing minutes later.
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
  // The extension filter cannot see biome's own config-ignore axis
  // (`files.includes` allowlist / `files.ignore` / `overrides`). When every
  // eligible-by-extension path is also config-ignored, the scoped biome
  // invocation exits 1 with "No files were processed" — a false negative for
  // the gate (Story #4292). Flag the scoped run so the runner downgrades that
  // specific exit to a clean skip instead of a formatting failure.
  return {
    gate,
    cmd: gate.cmd,
    args: [...args, ...eligibleFiles],
    skip: false,
    tolerateNoFilesProcessed: true,
  };
}

/**
 * Run every gate sequentially. Stops collecting after the first failure but
 * still returns a summary so the caller decides how to surface the result.
 *
 * Worktree locality (Story #1120): when `worktreePath` is supplied, every
 * gate runner is spawned with `cwd: worktreePath` so the gate sees the
 * Story branch's post-rebase tree. Evidence reads/writes still key against
 * `cwd` (the main checkout) because the temp tree lives under the main
 * `.git/`. Failure messages name the worktree path.
 *
 * Evidence-aware: when `storyId` is provided alongside `standalone: true`,
 * and `useEvidence !== false`, each gate consults
 * `validation-evidence.shouldSkip()` against current HEAD + the gate's
 * command-config hash. A matching record skips the gate; a successful run
 * is recorded so the next caller in the local hot path can skip in turn.
 *
 * Standalone keyspace (Story #4250): `standalone: true` routes the evidence
 * file to the storyId-anchored
 * `<tempRoot>/standalone/stories/story-<id>/validation-evidence.json`
 * keyspace. v2.0.0 removed the Epic tier and its Epic-keyed keyspace.
 *
 * `onGateStart` is invoked immediately before each gate's runner spawn, so a
 * caller can record per-gate wall-clock telemetry. Errors thrown from the
 * hook propagate.
 *
 * Projection advisories (Story #4776): when `baseBranch` and `storyBranch`
 * are both supplied and every gate passed, the maintainability and CRAP
 * pre-merge projections run through `projections/advisories.js` and log
 * their advisories to the same `log` sink the gates use. They are advisory
 * by construction — the returned `ok` is decided entirely by the gates, so
 * a projected breach never fails a close. They are skipped after a gate
 * failure, where the operator needs the failing gate's evidence, not a
 * baseline-refresh nudge.
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
  const skipped = [];
  // Evidence is active when a Story id is present AND there is a keyspace to
  // anchor on (`standalone: true` — Story #4250's storyId-anchored
  // keyspace, now the only one).
  const evidenceActive = useEvidence && storyId != null && standalone;
  const evidenceStoreOpts = { cwd, standalone };
  // Evidence keys against the main checkout's HEAD because the evidence
  // file lives under the main `.git/`. Gate spawn, in contrast,
  // runs in the worktree when one is supplied — that's the whole point of
  // Story #1120.
  const spawnCwd = worktreePath ?? cwd;
  const headSha = evidenceActive ? getHeadSha(spawnCwd) : null;
  // Story #5278 — one tree fingerprint for the whole run, not one per gate.
  // Every gate here reads the same working tree, so an identical tree means
  // identical inputs for all of them; a per-gate scope would be narrower but
  // would have to model each gate's read set, and being wrong about that
  // grants a skip the gate did not earn. A gate that carries its own
  // `inputFingerprint` still wins.
  const treeSha = evidenceActive ? getTreeFingerprint(spawnCwd) : null;

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
      ...(gate.env ? { env: gate.env } : {}),
      // Story #5278 — only the full-suite gate can end up *waiting* on the
      // host lock, and only it is expensive enough for the wait to change the
      // answer: whoever we queued behind may have deposited this gate's
      // evidence while we sat there. Re-asking the same question the runner
      // asked before the wait is the whole mechanism; a `{ status: 0 }`
      // stands in for the spawn.
      ...(gate.fullSuiteLock && configHash
        ? {
            skipIfSatisfied: () =>
              evidenceVerdict(gate, configHash).skip
                ? { status: 0 }
                : undefined,
          }
        : {}),
      // Story #5173 — forwarded unconditionally (never a conditional spread
      // like the two below): `defaultGateRunner` already treats a falsy value
      // as "no lock", so a branch here would only add a decision point to the
      // hottest function in this file.
      fullSuiteLock: gate.fullSuiteLock,
      ...(gate.tolerateNoFilesProcessed
        ? { tolerateNoFilesProcessed: true }
        : {}),
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

  // ── Phase 3: advisory projections ───────────────────────────────────
  // Story #4776 — the projection layer's live call site. Deliberately
  // outside the `ok` computation: a projected breach informs, it never
  // fails a close.
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
 * Phase 2 helper — run the serial gates in declared order, stopping at the
 * first failure. Extracted from `runCloseValidation` (Story #4926); the
 * evidence bookkeeping stays bit-identical to the parallel pass because both
 * call the same injected `evidenceVerdict` / `recordIfActive` closures.
 *
 * Mutates the caller's `failed` / `skipped` accumulators — the same arrays
 * Phase 1 already wrote into, so the returned verdict stays one list.
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
  const failGate = (gate, status, message) => {
    failed.push({ gate, status, cwd: spawnCwd });
    log(message);
    if (gate.hint) log(`[close-validation]   hint: ${gate.hint}`);
  };
  for (const gate of serial) {
    let execution;
    try {
      execution = applyChangedFileScope({ gate, spawnCwd, log });
    } catch (err) {
      failGate(
        gate,
        1,
        `[close-validation] ✖ ${gate.name} failed to resolve changed-file scope: ${err?.message ?? err}`,
      );
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
      failGate(
        gate,
        result.status,
        `[close-validation] ✖ ${gate.name} failed (exit ${result.status}) in ${spawnCwd}`,
      );
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
 * Phase 3 helper — run the advisory projections, absorbing every failure.
 *
 * No-ops without a branch pair to diff (resume / legacy callers), and can
 * never influence the close verdict: the caller has already decided `ok`
 * before this runs, and a throw here is logged, not propagated.
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
