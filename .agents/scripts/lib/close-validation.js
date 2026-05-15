/**
 * close-validation.js — Shift-left validation gates for story-close.
 *
 * Runs typecheck, lint, test, format check, and maintainability/coverage/
 * CRAP regression checks before the story merge so drift is caught in the
 * worktree rather than at pre-push time on the Epic branch. Format command
 * is configurable via `agentSettings.commands.formatCheck`; default is
 * `npx biome format .`. All gates inherit stdio so the operator sees the
 * raw output; the returned summary surfaces actionable hints on failure.
 *
 * Pre-merge MI projection (Story #781) is re-exported from
 * `close-validation/projections/maintainability.js` — the engine that
 * surfaces, by name, the files that would breach their per-file MI
 * baseline post-merge so the operator can ship a `baseline-refresh:`
 * commit atomically with the Story PR.
 */

import { spawn } from 'node:child_process';
import { writeFile as defaultWriteFile } from 'node:fs/promises';
import { defaultGetHeadSha } from './close-validation/projections/head-sha.js';
import { getCommands } from './config/commands.js';
import { getQuality } from './config/quality.js';
import { storyArtifactPath } from './config/temp-paths.js';
import { getSpawnCount as defaultGetSpawnCount } from './gh-exec.js';
import {
  recordPass as defaultRecordPass,
  shouldSkip as defaultShouldSkip,
  hashCommandConfig,
} from './validation-evidence.js';

/**
 * @typedef {Object} Gate
 * @property {string}   name  - Short label used in progress logs.
 * @property {string}   cmd   - Executable to run.
 * @property {string[]} args  - Arguments passed to `cmd`.
 * @property {string}   [hint] - Remediation hint shown on failure.
 */

/**
 * Fallback typecheck command — the gate is mandatory by design (Epic-branch
 * type regressions surface in the next Story's pre-push otherwise).
 */
const TYPECHECK_FALLBACK = 'npm run typecheck';

const TYPECHECK_HINT =
  'TypeScript regression — fix type errors on the Story branch before retrying close. If the failure is a stale generated type (e.g. wrangler types), regenerate locally and commit before the close.';

/** Default formatter command when `agentSettings.commands.formatCheck` is unset. */
const FORMAT_CHECK_FALLBACK = 'npx biome format .';

/**
 * Build the format-gate hint dynamically from the resolved write command so
 * a Prettier-only repo gets `prettier --write` in its hint, not biome.
 */
function buildFormatHint(writeCmd) {
  const cmd =
    writeCmd && writeCmd.trim().length > 0
      ? writeCmd
      : 'npx biome format --write .';
  return `Run \`${cmd}\` to auto-fix formatting drift.`;
}

/**
 * Resolve a string `agentSettings.commands.<key>` with a fallback when the
 * value is missing, empty, or the resolver throws on malformed settings.
 * Shared engine behind the three resolveX command helpers.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function resolveCommandWithFallback(settings, key, fallback) {
  try {
    const cmds = getCommands({ agentSettings: settings });
    const value = cmds[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // Malformed settings — fall through to the framework default.
  }
  return fallback;
}

/**
 * Resolve the typecheck command. Reads `agentSettings.commands.typecheck`;
 * falls back to `npm run typecheck`. The framework-wide
 * `COMMANDS_DEFAULTS.typecheck` is `null` but this gate is mandatory, so
 * we apply the fallback here. Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string}
 */
export function resolveTypecheckCommand(settings) {
  return resolveCommandWithFallback(settings, 'typecheck', TYPECHECK_FALLBACK);
}

/**
 * Resolve the format-check command. Reads `agentSettings.commands.formatCheck`;
 * falls back to `npx biome format .` so existing repos keep working byte-
 * for-byte. Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string}
 */
export function resolveFormatCheckCommand(settings) {
  return resolveCommandWithFallback(
    settings,
    'formatCheck',
    FORMAT_CHECK_FALLBACK,
  );
}

/**
 * Resolve the format-write command used by story-close format-autofix (and
 * surfaced in the format-gate hint). Reads `agentSettings.commands.formatWrite`;
 * falls back to `npx biome format --write .`. Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string}
 */
export function resolveFormatWriteCommand(settings) {
  return resolveCommandWithFallback(
    settings,
    'formatWrite',
    'npx biome format --write .',
  );
}

/**
 * Resolve whether the CRAP gate is enabled. When enabled, the close-
 * validation graph drops the standalone `test` gate because coverage-
 * capture already runs the suite under c8 instrumentation (Story #1798).
 *
 * Reads `crap.enabled` from any of the shapes call sites pass us (the
 * resolved legacy-shim shape, the raw `.agentrc.json` shape, and the raw
 * partial-config shape some unit tests construct directly). Defaults to
 * `true` so an omitted setting matches `CRAP_GATE_DEFAULTS.enabled`. We
 * deliberately do NOT round-trip through `getQuality()` here because that
 * resolver expects the unresolved `gates.crap.*` shape.
 *
 * @param {object|undefined|null} agentSettings
 * @returns {boolean}
 */
function isCrapGateEnabled(agentSettings) {
  if (!agentSettings || typeof agentSettings !== 'object') return true;
  const candidates = [
    agentSettings?.quality?.crap?.enabled,
    agentSettings?.delivery?.quality?.gates?.crap?.enabled,
    agentSettings?.quality?.gates?.crap?.enabled,
  ];
  const firstBoolean = candidates.find((v) => typeof v === 'boolean');
  return firstBoolean ?? true;
}

/**
 * Conditionally produce the standalone `test` gate entry. Returns an empty
 * array when the CRAP gate is enabled (Story #1798: coverage-capture is the
 * canonical test runner in that mode); returns the legacy single-entry
 * gate otherwise. Splitting this out keeps `buildDefaultGates` flat for
 * the CRAP-cyclomatic gate.
 *
 * @param {object|undefined|null} agentSettings
 * @returns {Gate[]}
 */
function buildTestGateEntry(agentSettings) {
  if (isCrapGateEnabled(agentSettings)) return [];
  return [{ name: 'test', cmd: 'npm', args: ['test'] }];
}

/**
 * Build the canonical close-validation gate list.
 *
 * Ordering (cheapest fast-fail first): typecheck → lint → [test] →
 * format → check-maintainability → coverage-capture → check-crap →
 * [check-mutation]. The standalone `test` gate is dropped when
 * `crap.enabled === true` (Story #1798) because coverage-capture carries
 * test-failure signalling under c8 in that mode.
 *
 * `typecheck` is mandatory; consumers may customise the command via
 * `agentSettings.commands.typecheck` (default `npm run typecheck`).
 *
 * Story #1120: when `epicBranch` is supplied, the maintainability and CRAP
 * gates receive `--epic-ref <epicBranch>` so they read their committed
 * baseline at the Epic-branch HEAD via `git show` rather than via a
 * working-tree fs read.
 *
 * Story #1945: by default the CRAP gate runs `--full-scope` at close time,
 * mirroring CI's post-merge `push` event on main. Diff-scoped close-
 * validation can miss method-level regressions in untouched files whose
 * coverage drifts because of shared fixtures, run-order, or
 * instrumentation paths — those surfaced as red main-branch builds in
 * incidents like PR #1942 → hotfix #1944. Catching them at close costs a
 * full-tree CRAP scan (~3s on a ~1400-method repo) but spares the
 * forced-rebase + hotfix round-trip after auto-merge. Pass
 * `fullScopeCrap: false` to revert to diff-scope behaviour (exposed to
 * operators via the `--no-full-scope-crap` flag on
 * `single-story-close.js`).
 *
 * @param {{ agentSettings?: object, epicBranch?: string, fullScopeCrap?: boolean }} [opts]
 * @returns {Gate[]}
 */
export function buildDefaultGates({
  agentSettings,
  epicBranch,
  fullScopeCrap = true,
} = {}) {
  const typecheckCmdString = resolveTypecheckCommand(agentSettings);
  const [typecheckCmd, ...typecheckArgs] = typecheckCmdString
    .split(/\s+/)
    .filter(Boolean);
  const formatCheckString = resolveFormatCheckCommand(agentSettings);
  const [formatCmd, ...formatArgs] = formatCheckString
    .split(/\s+/)
    .filter(Boolean);
  const formatWriteString = resolveFormatWriteCommand(agentSettings);
  const epicRefArgs =
    typeof epicBranch === 'string' && epicBranch.length > 0
      ? ['--epic-ref', epicBranch]
      : [];
  return [
    {
      name: 'typecheck',
      cmd: typecheckCmd,
      args: typecheckArgs,
      hint: TYPECHECK_HINT,
    },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
    ...buildTestGateEntry(agentSettings),
    {
      // Gate name kept generic ("format") so the close-orchestrator log line
      // and the per-gate phase-timer key don't shift when a repo swaps biome
      // for Prettier / dprint via `agentSettings.commands.formatCheck`. The
      // actual command and the remediation hint resolve from config.
      name: 'format',
      cmd: formatCmd,
      args: formatArgs,
      hint: buildFormatHint(formatWriteString),
    },
    {
      name: 'check-maintainability',
      cmd: 'node',
      args: ['.agents/scripts/check-maintainability.js', ...epicRefArgs],
      hint: 'Run `npm run maintainability:update` to refresh the baseline — the refreshed baseline MUST be committed on the story branch.',
    },
    {
      name: 'coverage-capture',
      cmd: 'node',
      args: ['.agents/scripts/coverage-capture.js'],
      hint: 'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.',
    },
    {
      name: 'check-crap',
      cmd: 'node',
      args: [
        '.agents/scripts/check-crap.js',
        ...epicRefArgs,
        ...(fullScopeCrap ? ['--full-scope'] : []),
      ],
      hint: fullScopeCrap
        ? 'Reduce complexity or add coverage on the flagged methods. If the regression is environmental (e.g. Linux vs. Windows coverage drift on an untouched file), run `npm run crap:update -- --full-scope` and commit a `baseline-refresh:` tagged subject + non-empty body. Self-skips when `agentSettings.quality.crap.enabled` is false.'
        : 'Reduce complexity or add coverage on the flagged methods, or run `npm run crap:update` and commit with a `baseline-refresh:` tagged subject + non-empty body if the drift is justified. Self-skips when `agentSettings.quality.crap.enabled` is false.',
    },
    ...buildMutationGateEntry(agentSettings),
    {
      // Story #1912 / Task #1917 — unified floor + tolerance + schema gate.
      // Runs IN ADDITION to the per-kind regression checks above; the
      // redundancy is intentional for this Epic and collapses to a single
      // gate in follow-up Epic #1943. `check-baselines.js` self-skips
      // gates whose `enabled === false` is configured, so this is safe to
      // register unconditionally.
      name: 'check-baselines',
      cmd: 'node',
      args: ['.agents/scripts/check-baselines.js', '--format', 'text'],
      hint: 'Unified baselines gate breached. Inspect the JSON report (`node .agents/scripts/check-baselines.js`) to see which kind/component/axis fell below floor; remediate the underlying file(s) or — when the regression is intentional — refresh the relevant baseline through its per-kind update script and commit with a `baseline-refresh:` tagged subject.',
    },
  ];
}

/**
 * Conditionally include the mutation gate (Story #1736) when
 * `delivery.quality.gates.mutation.enabled` is true. The script
 * self-skips when no Stryker config is detected, so the gate is safe to
 * register unconditionally — but we keep the registration gated on the
 * `enabled` flag so consumers who explicitly opt out don't pay the
 * spawn-and-detect cost on every close.
 *
 * @param {object|undefined} agentSettings
 * @returns {Gate[]}
 */
function buildMutationGateEntry(agentSettings) {
  try {
    const quality = getQuality({ agentSettings });
    const mutation = quality.gates?.mutation;
    if (!mutation || mutation.enabled === false) return [];
  } catch {
    // Malformed settings — registering the gate is harmless because the
    // script itself self-skips when prerequisites are missing.
  }
  return [
    {
      name: 'check-mutation',
      cmd: 'node',
      args: ['.agents/scripts/check-mutation.js'],
      hint: 'Mutation gate breached. Add tests that kill the surviving mutants, or — when the regression is intentional and justified — refresh the baseline with `node .agents/scripts/update-mutation-baseline.js` and commit it on the story branch with a `baseline-refresh:` tagged subject. Self-skips when no Stryker config is detected (`npx stryker init`).',
    },
  ];
}

/**
 * Default gate list resolved with no consumer agentSettings — uses the
 * `npm run typecheck` fallback for the typecheck gate. Call sites that have a
 * resolved agentSettings object in scope (e.g. `story-close.js`) should
 * prefer `buildDefaultGates({ agentSettings })` so a configured
 * `agentSettings.commands.typecheck` is honoured.
 *
 * @type {Gate[]}
 */
export const DEFAULT_GATES = buildDefaultGates();

/**
 * Gates whose I/O is read-only against the working tree (no shared mutable
 * state, no overlapping ports/sockets). Safe to run concurrently — see
 * `runCloseValidation` for the Promise.all + AbortController plumbing.
 */
export const INDEPENDENT_GATE_NAMES = new Set(['lint', 'format', 'typecheck']);

/**
 * Partition a gate list into the parallel-safe set and the order-sensitive
 * remainder. Order is preserved within each bucket so the serial walk stays
 * cheapest-fast-fail-first (test → check-maintainability → coverage → crap).
 *
 * @param {Gate[]} gates
 * @returns {{ independent: Gate[], serial: Gate[] }}
 */
export function partitionGates(gates) {
  const independent = [];
  const serial = [];
  for (const gate of gates) {
    if (INDEPENDENT_GATE_NAMES.has(gate.name)) independent.push(gate);
    else serial.push(gate);
  }
  return { independent, serial };
}

/**
 * Pipe a child stream's output line-by-line through `emit`, prepending
 * `prefix` to each line. Tail bytes without a trailing newline flush on
 * `end` so the operator never loses the last line of a gate's output.
 */
function pipePrefixed(stream, prefix, emit) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      emit(prefix + buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) emit(prefix + buf);
  });
}

/**
 * Default async gate runner — used by `runCloseValidation` when no `runner`
 * is injected. Spawns the gate via `child_process.spawn`, prefixes every
 * stdout/stderr line with `[gate-name] ` (so concurrent gates don't bleed
 * into each other in the operator's terminal), and resolves only when the
 * child exits.
 *
 * Honours `opts.signal`: a TERM is delivered to the child the moment the
 * signal fires, so a sibling gate's failure aborts the rest of the wave
 * promptly. The promise still resolves (rather than rejecting) on abort —
 * `runCloseValidation` sees a non-zero status and folds it into the
 * already-recorded first-failure.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, gateName?: string, log?: (m: string) => void }} opts
 * @returns {Promise<{ status: number }>}
 */
/** Wire the AbortSignal so an abort kills the child. Returns the cleanup fn. */
export function attachGateAbortHandler(child, signal) {
  if (!signal) return () => {};
  const killChild = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* race: already exited */
    }
  };
  if (signal.aborted) {
    killChild();
    return () => {};
  }
  signal.addEventListener('abort', killChild, { once: true });
  return () => signal.removeEventListener('abort', killChild);
}

/** SIGTERM (no exit code) on abort → non-zero so the gate counts as failed. */
export function gateExitCode(code, sig) {
  if (typeof code === 'number') return code;
  return sig ? 143 : 1;
}

function defaultGateRunner(cmd, args, opts = {}) {
  const { cwd, signal, gateName, log } = opts;
  const child = spawn(cmd, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = gateName ? `[${gateName}] ` : '';
  const emit =
    typeof log === 'function' ? log : (m) => process.stdout.write(`${m}\n`);
  pipePrefixed(child.stdout, prefix, emit);
  pipePrefixed(child.stderr, prefix, emit);
  const detach = attachGateAbortHandler(child, signal);
  return new Promise((resolve) => {
    child.on('exit', (code, sig) => {
      detach();
      resolve({ status: gateExitCode(code, sig) });
    });
    child.on('error', () => {
      detach();
      resolve({ status: 1 });
    });
  });
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

  /** Run a single gate through the injected runner; returns `{ status }`. */
  const dispatchGate = async (gate, signal) => {
    log(
      `[close-validation] ▶ ${gate.name}${worktreePath ? ` (cwd=${worktreePath})` : ''}`,
    );
    if (typeof onGateStart === 'function') onGateStart(gate);
    const result = await runner(gate.cmd, gate.args, {
      cwd: spawnCwd,
      gateName: gate.name,
      log,
      signal,
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
    const configHash = hashCommandConfig({
      cmd: gate.cmd,
      args: gate.args,
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
      result = await dispatchGate(gate, ac.signal);
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
    const configHash = hashCommandConfig({
      cmd: gate.cmd,
      args: gate.args,
      cwd: spawnCwd,
    });
    const verdict = evidenceVerdict(gate, configHash);
    if (verdict.skip) {
      skipped.push({ gate, reason: verdict.reason });
      continue;
    }
    const startedAt = evidenceActive ? evidenceClock() : 0;
    const result = await dispatchGate(gate);
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

/**
 * Pre-merge MI ceiling projection helpers — `projectMaintainabilityRegressions`
 * and `formatMaintainabilityProjection` were extracted to
 * `close-validation/projections/maintainability.js` (Story #1850) so the
 * parent module stays below the 700-LOC ceiling and the inline guard
 * cascade collapses into the shared `validateProjectionInputs` predicate.
 * The re-export below preserves the public contract — every existing call
 * site continues to import from `./close-validation.js`.
 */
export {
  formatMaintainabilityProjection,
  projectMaintainabilityRegressions,
} from './close-validation/projections/maintainability.js';

/**
 * Throw-away ghSpawnCount emitter (Story #1795 / Epic #1788).
 *
 * Writes the current `gh-exec` spawn counter to
 * `temp/epic-<eid>/story-<sid>/gh-spawn-count.json` so the
 * `analyze-execution.js` child process can read it and emit a
 * `ghSpawnCount` field on the `story-perf-summary` payload. The Story-
 * close orchestrator calls this inside `runPostMergeClose` right before
 * the perf-summary phase, capturing every `gh` invocation from preflight
 * through the merge in one counter snapshot.
 *
 * @param {object} opts
 * @param {number|string} opts.epicId
 * @param {number|string} opts.storyId
 * @param {object} [opts.config] - Resolved config bag so `tempRoot`
 *   resolution honours the consumer's configured path.
 * @param {() => number} [opts.getSpawnCountFn=defaultGetSpawnCount] - Test seam.
 * @param {typeof defaultWriteFile} [opts.writeFileFn=defaultWriteFile] - Test seam.
 * @param {{ warn?: (s: string) => void }} [opts.logger] - Best-effort
 *   failure-path logger; never throws.
 * @returns {Promise<{ status: 'ok'|'failed', path?: string, ghSpawnCount?: number, reason?: string }>}
 */
export async function emitGhSpawnCount({
  epicId,
  storyId,
  config,
  getSpawnCountFn = defaultGetSpawnCount,
  writeFileFn = defaultWriteFile,
  logger,
} = {}) {
  const eid = Number(epicId);
  const sid = Number(storyId);
  if (!Number.isInteger(eid) || eid < 1 || !Number.isInteger(sid) || sid < 1) {
    return { status: 'failed', reason: 'invalid-ids' };
  }
  let ghSpawnCount;
  try {
    ghSpawnCount = getSpawnCountFn();
  } catch (err) {
    logger?.warn?.(
      `[close-validation] gh-spawn-count read failed: ${err?.message ?? err}`,
    );
    return { status: 'failed', reason: 'counter-read-failed' };
  }
  const targetPath = storyArtifactPath(eid, sid, 'gh-spawn-count.json', config);
  const payload = {
    kind: 'gh-spawn-count',
    epicId: eid,
    storyId: sid,
    ghSpawnCount,
    capturedAt: new Date().toISOString(),
  };
  try {
    await writeFileFn(targetPath, JSON.stringify(payload, null, 2));
    return { status: 'ok', path: targetPath, ghSpawnCount };
  } catch (err) {
    logger?.warn?.(
      `[close-validation] gh-spawn-count emit failed: ${err?.message ?? err}`,
    );
    return { status: 'failed', reason: 'write-failed' };
  }
}
