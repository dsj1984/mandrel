/**
 * close-validation.js — Shift-left validation gates for story-close.
 *
 * Runs lint, test, format check, and maintainability regression check
 * before the story merge so drift is caught in the worktree rather than at
 * pre-push time on the Epic branch. The format command is configurable via
 * `agentSettings.commands.formatCheck`; default is `npx biome format .`. All gates inherit stdio so the operator
 * sees the raw output; the returned summary is used to surface actionable
 * hints when a gate fails.
 *
 * Also exports `projectMaintainabilityRegressions` — a pre-merge advisory that
 * the close script invokes before the merge step so the operator sees the
 * exact list of files that would breach their MI baseline post-merge and can
 * ship a `baseline-refresh:` commit atomically with the Story PR.
 */

import { spawn } from 'node:child_process';
import { getCommands } from './config/commands.js';
import { getQuality } from './config/quality.js';
import { gitSpawn as defaultGitSpawn } from './git-utils.js';
import { calculateForSource } from './maintainability-engine.js';
import { getBaseline } from './maintainability-utils.js';
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
 * Fallback typecheck command when `agentSettings.commands.typecheck` is unset
 * or null. Mirrors the lint/test fallback shape so the gate runs unconditionally
 * — there is intentionally no config switch to disable it (Epic-branch type
 * regressions surface in the next Story's pre-push otherwise; see CHANGELOG
 * 5.30.1).
 */
const TYPECHECK_FALLBACK = 'npm run typecheck';

const TYPECHECK_HINT =
  'TypeScript regression — fix type errors on the Story branch before retrying close. If the failure is a stale generated type (e.g. wrangler types), regenerate locally and commit before the close.';

/**
 * Default formatter command for the close-validation format gate. Used when
 * `agentSettings.commands.formatCheck` is unset or empty. Mirrors the long-
 * standing close-script behaviour so repos that don't opt in keep working.
 */
const FORMAT_CHECK_FALLBACK = 'npx biome format .';

/**
 * Build the format-gate hint dynamically from the resolved write command so a
 * Prettier-only repo gets `prettier --write` in its hint, not biome. Falls
 * back to the historical biome string when no write command is resolvable.
 */
function buildFormatHint(writeCmd) {
  const cmd =
    writeCmd && writeCmd.trim().length > 0
      ? writeCmd
      : 'npx biome format --write .';
  return `Run \`${cmd}\` to auto-fix formatting drift.`;
}

/**
 * Resolve the typecheck command for the close-validation typecheck gate.
 *
 * Reads `agentSettings.commands.typecheck` (string) when present and non-empty
 * and falls back to `npm run typecheck` otherwise. The framework-wide
 * `COMMANDS_DEFAULTS.typecheck` is `null` (disabled-means-null convention used
 * by other call sites), but the close-validation gate is mandatory by design,
 * so we apply the fallback here rather than short-circuiting on null.
 *
 * Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string} command string (e.g. `pnpm exec turbo run typecheck`)
 */
export function resolveTypecheckCommand(settings) {
  try {
    const cmds = getCommands({ agentSettings: settings });
    if (
      typeof cmds.typecheck === 'string' &&
      cmds.typecheck.trim().length > 0
    ) {
      return cmds.typecheck.trim();
    }
  } catch {
    // Malformed settings — fall through to the framework default.
  }
  return TYPECHECK_FALLBACK;
}

/**
 * Resolve the format-check command for the close-validation format gate.
 * Reads `agentSettings.commands.formatCheck` (string) when present and non-
 * empty and falls back to `npx biome format .` otherwise so existing repos
 * that haven't set the field keep their previous behaviour byte-for-byte.
 *
 * Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string}
 */
export function resolveFormatCheckCommand(settings) {
  try {
    const cmds = getCommands({ agentSettings: settings });
    if (
      typeof cmds.formatCheck === 'string' &&
      cmds.formatCheck.trim().length > 0
    ) {
      return cmds.formatCheck.trim();
    }
  } catch {
    // Malformed settings — fall through to the framework default.
  }
  return FORMAT_CHECK_FALLBACK;
}

/**
 * Resolve the format-write command used by the story-close format-autofix
 * step (and surfaced in the format-gate hint). Reads
 * `agentSettings.commands.formatWrite`; falls back to the historical
 * `npx biome format --write .` so repos that haven't opted in keep working.
 *
 * Exported for testing.
 *
 * @param {{ agentSettings?: { commands?: object } } | object | null | undefined} settings
 * @returns {string}
 */
export function resolveFormatWriteCommand(settings) {
  try {
    const cmds = getCommands({ agentSettings: settings });
    if (
      typeof cmds.formatWrite === 'string' &&
      cmds.formatWrite.trim().length > 0
    ) {
      return cmds.formatWrite.trim();
    }
  } catch {
    // Malformed settings — fall through to the framework default.
  }
  return 'npx biome format --write .';
}

/**
 * Resolve whether the CRAP gate is enabled for this run. When enabled, the
 * close-validation graph drops the standalone `test` gate because
 * coverage-capture (which CRAP depends on) already runs the suite under c8
 * instrumentation — running `npm test` separately would execute the suite
 * twice per Story close (Story #1798 / Epic #1788).
 *
 * Reads `crap.enabled` directly from each of the shapes call sites pass us:
 *   - the resolved legacy-shim shape (`agentSettings.quality.crap.enabled`),
 *     which production callers receive from `resolveConfig().agentSettings`;
 *   - the raw `.agentrc.json` shape under `delivery.quality.gates.crap.enabled`;
 *   - the raw partial-config shape (`quality.gates.crap.enabled`) some
 *     unit-test call sites construct directly.
 *
 * Defaults to `true` so a consumer that omits the gate entirely matches
 * `CRAP_GATE_DEFAULTS.enabled`. We intentionally do NOT round-trip through
 * `getQuality()` here because that resolver expects the unresolved
 * `gates.crap.*` shape and re-running it against the already-resolved
 * legacy-shim shape would silently collapse the user's setting back to the
 * framework default.
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
 * Ordering rationale (cheapest fast-fail first):
 *   1. typecheck — pure compile-time check, fastest to fail
 *   2. lint     — static analysis
 *   3. test     — full test suite (dropped when `crap.enabled === true`;
 *                 coverage-capture becomes the canonical test runner — see
 *                 Story #1798)
 *   4. format   — configurable via `agentSettings.commands.formatCheck`
 *   5. check-maintainability
 *   6. coverage-capture
 *   7. check-crap
 *
 * The `typecheck` gate is mandatory; consumers cannot opt out via config. They
 * may customise the command via `agentSettings.commands.typecheck`; otherwise
 * `npm run typecheck` is used.
 *
 * Story #1120: when `epicBranch` is supplied, the maintainability and CRAP
 * gates receive `--epic-ref <epicBranch>` so they read their committed
 * baseline at the Epic-branch HEAD via `git show` (baseline-loader) rather
 * than via a working-tree fs read. Without it, those gates fall back to the
 * legacy fs read — `baselines/*.json` on whatever the spawn cwd's working
 * tree carries.
 *
 * Story #1798: when `delivery.quality.gates.crap.enabled === true` (the
 * configured state for this repo and the framework default), the standalone
 * `test` gate is dropped from the graph; coverage-capture carries
 * test-failure signalling (exits non-zero on a failing suite, reports gate
 * identifier `coverage-capture`). When `crap.enabled === false`, the legacy
 * two-gate path is preserved so no consumer behaviour regresses.
 *
 * @param {{ agentSettings?: object, epicBranch?: string }} [opts]
 * @returns {Gate[]}
 */
export function buildDefaultGates({ agentSettings, epicBranch } = {}) {
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
      args: ['.agents/scripts/check-crap.js', ...epicRefArgs],
      hint: 'Reduce complexity or add coverage on the flagged methods, or run `npm run crap:update` and commit with a `baseline-refresh:` tagged subject + non-empty body if the drift is justified. Self-skips when `agentSettings.quality.crap.enabled` is false.',
    },
    ...buildMutationGateEntry(agentSettings),
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
 * Resolve the current `git rev-parse HEAD` SHA inside `cwd`. Returns `null`
 * when git is unavailable or the call fails — callers treat that as
 * "evidence skip disabled" so the gate runs as before.
 *
 */
function defaultGetHeadSha(cwd, gitSpawn = defaultGitSpawn) {
  try {
    const res = gitSpawn(cwd, 'rev-parse', 'HEAD');
    if (res.status !== 0) return null;
    const sha = (res.stdout || '').trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Run every gate sequentially. Stops collecting after the first failure is
 * recorded but still returns a summary so the caller can decide how to
 * surface the result.
 *
 * **Worktree locality (Story #1120).** When `worktreePath` is supplied,
 * every gate runner is spawned with `cwd: worktreePath` so the gate sees
 * the Story branch's post-rebase tree, not the main checkout's working
 * tree. Evidence reads/writes still key against `cwd` (the main checkout)
 * because the per-Epic temp tree lives under the main `.git/`. Failure
 * messages name the worktree path so the operator can locate the failing
 * tree without re-deriving it from the Story ID. When `worktreePath` is
 * omitted, behaviour is unchanged — gate spawn falls back to `cwd`.
 *
 * Evidence-aware: when both `storyId` and `epicId` are provided and
 * `useEvidence !== false`, each gate consults
 * `validation-evidence.shouldSkip()` against the current `git rev-parse
 * HEAD` + the gate's command-config hash. A matching record skips the gate
 * (logged at info level); a successful run is recorded so the next caller
 * in the local hot path can skip in turn. Without `epicId`, evidence is
 * inert (the per-Epic-tree path cannot be resolved).
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
 *   `onGateStart` is invoked immediately before each gate's runner spawn.
 *   story-close uses it to drive `phaseTimer.mark('lint'|'test')`
 *   so the per-gate wall-clock lands in the `phase-timings` structured
 *   comment. Errors thrown from the hook propagate and halt the run.
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
 * Default tolerance shared with check-maintainability.js: small floating-point
 * variances must not register as a regression.
 */
const DEFAULT_MI_TOLERANCE = 0.001;

/**
 * Project the post-merge maintainability scores for every file changed on
 * the Story branch relative to the Epic branch, and return the subset whose
 * projected score breaches the per-file baseline ceiling.
 *
 * Advisory only — the result is rendered as a log line by story-close
 * before the merge runs. The hard MI gate still runs at pre-push time via the
 * husky hook. The point of this projection is to surface the breach **before**
 * the merge so the operator can ship a `baseline-refresh:` commit atomically
 * with the Story PR rather than as a follow-on after the push.
 *
 * The "post-merge body" of each file is approximated by the file content at
 * the tip of the Story branch — a `--no-ff` merge into the Epic branch does
 * not modify file contents, so this is exact when the merge applies cleanly
 * and a close-enough projection when it auto-resolves minor conflicts.
 *
 * The helper never throws and never has side effects beyond running `git`
 * subcommands via the injected interface. Any failure path resolves to
 * `{ ok: true, regressions: [], skipped: '<reason>' }` so the caller treats
 * the advisory as best-effort.
 *
 * @param {{
 *   cwd: string,
 *   epicBranch: string,
 *   storyBranch: string,
 *   baselinePath: string,
 *   tolerance?: number,
 *   git?: { gitSpawn: typeof defaultGitSpawn },
 *   scoreSource?: (source: string) => number,
 *   loadBaseline?: (path: string) => Record<string, number>,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   regressions: Array<{ file: string, projected: number, baseline: number, drop: number }>,
 *   skipped?: string,
 *   detail?: string,
 * }}
 */
export function projectMaintainabilityRegressions({
  cwd,
  epicBranch,
  storyBranch,
  baselinePath,
  tolerance = DEFAULT_MI_TOLERANCE,
  git = { gitSpawn: defaultGitSpawn },
  scoreSource = calculateForSource,
  loadBaseline = getBaseline,
} = {}) {
  if (!cwd || !epicBranch || !storyBranch || !baselinePath) {
    return { ok: true, regressions: [], skipped: 'missing-args' };
  }

  const baseline = loadBaseline(baselinePath);
  if (!baseline || Object.keys(baseline).length === 0) {
    return { ok: true, regressions: [], skipped: 'no-baseline' };
  }

  // Refresh `origin/<epicBranch>` so the diff range resolves even if the
  // close script hasn't reached its own pull/rebase step yet. Best-effort —
  // a fetch failure is logged via `skipped: 'fetch-failed'` and the helper
  // bails rather than producing a misleading projection.
  const fetchRes = git.gitSpawn(cwd, 'fetch', 'origin', epicBranch);
  if (fetchRes.status !== 0) {
    return {
      ok: true,
      regressions: [],
      skipped: 'fetch-failed',
      detail: fetchRes.stderr || fetchRes.stdout || `exit ${fetchRes.status}`,
    };
  }

  const diff = git.gitSpawn(
    cwd,
    'diff',
    '--name-only',
    `origin/${epicBranch}...${storyBranch}`,
  );
  if (diff.status !== 0) {
    return {
      ok: true,
      regressions: [],
      skipped: 'diff-failed',
      detail: diff.stderr || diff.stdout || `exit ${diff.status}`,
    };
  }

  const changedFiles = (diff.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));

  const regressions = [];
  for (const file of changedFiles) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const baselineScore = baseline[file];
    if (typeof baselineScore !== 'number') continue;

    const show = git.gitSpawn(cwd, 'show', `${storyBranch}:${file}`);
    if (show.status !== 0) continue; // file deleted/renamed on the story branch

    const projected = scoreSource(show.stdout || '');
    if (projected < baselineScore - tolerance) {
      regressions.push({
        file,
        projected,
        baseline: baselineScore,
        drop: baselineScore - projected,
      });
    }
  }

  return { ok: regressions.length === 0, regressions };
}

/**
 * Render the pre-merge MI advisory as a human-readable multi-line log block.
 * Returns `null` when there are no regressions to surface so callers can `if`
 * past the log call without a string-empty check.
 *
 * @param {ReturnType<typeof projectMaintainabilityRegressions>} result
 * @returns {string | null}
 */
export function formatMaintainabilityProjection(result) {
  if (!result || !Array.isArray(result.regressions)) return null;
  if (result.regressions.length === 0) return null;
  const lines = [
    `[close-validation] ⚠ Pre-merge MI projection: ${result.regressions.length} file(s) would breach baseline post-merge:`,
  ];
  for (const r of result.regressions) {
    lines.push(
      `  • ${r.file}  projected=${r.projected.toFixed(2)}  baseline=${r.baseline.toFixed(2)}  drop=-${r.drop.toFixed(2)}`,
    );
  }
  lines.push(
    '[close-validation]   To land cleanly, run `npm run maintainability:update` and commit the refreshed baseline with a `baseline-refresh:` tagged subject (non-empty body) on the story branch before re-running close.',
  );
  return lines.join('\n');
}
