/**
 * preflight-runner.js — Shared preflight wrapper around the checks registry.
 *
 * This module is the single implementation of the "run the registry, fail
 * fast on blockers, log auto-fixes" pattern. The consumer entry points
 * (`single-story-close.js`, `mandrel-update-preflight.js`, the npm test wrapper, and
 * the bootstrap scripts) call `runPreflight({ scope })` instead of
 * re-implementing the same assemble+run+format+exit-2 dance.
 *
 * Exit-code contract (shared by every consumer):
 *   - 0 → no blocker findings (warnings/info may have been printed).
 *   - 2 → at least one `severity: 'blocker'` finding survived after
 *         auto-fixes. The wrapper prints a human-readable blocker table
 *         (`id · summary · fixCommand`) before returning. Code 2 is the
 *         project-wide "preflight refused" reservation — see
 *         `.agents/workflows/helpers/deliver-story.md` for the rationale.
 *
 * Auto-fixes are logged via `logFixes` before the blocker check so the
 * operator sees the "we corrected X" line even when a separate blocker
 * later trips the exit. Auto-fixes never themselves block.
 */

import { runChecks } from './checks/index.js';
import { assembleState } from './checks/state.js';
import { Logger } from './Logger.js';

/**
 * @typedef {object} PreflightResult
 * @property {Array<object>} findings  Unfixed findings (any severity).
 * @property {Array<object>} fixed     Findings that were auto-corrected.
 * @property {boolean} blocked         True iff `findings` contains a
 *   `severity: 'blocker'`. When `true`, the consumer must exit with code 2.
 */

/**
 * Default logger adapter — routes info/warn/error through the project
 * Logger. Kept as a module-local constant so the runner has a single seam
 * tests can swap with a spy that captures lines without going through
 * Logger's stdout/stderr.
 */
const DEFAULT_LOGGER = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
};

/**
 * Run preflight checks for `scope` against an assembled state probe.
 *
 * The consumer surface is intentionally tiny: pass a `scope` string and
 * (optionally) a `cwd`. The runner handles state assembly, the autoFix
 * flag, finding/fix routing, and pretty-print of the blocker table.
 *
 * @param {object} opts
 * @param {string} opts.scope          Consumer surface — `'story-close'`,
 *   `'npm-test'`, `'diagnose'`, etc.
 * @param {boolean} [opts.autoFix=true] Forwarded to `runChecks`. Defaults
 *   to `true` because every wiring call site at this Story's level wants
 *   auto-correction (the `retro` consumer that needs `autoFix:false` does
 *   NOT use this helper — it calls `runChecks` directly).
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]       Test-only probe injection forwarded
 *   to `assembleState`. Production callers omit this.
 * @param {object} [opts.registry]     Test-only — bypass `loadRegistry()`.
 * @param {string} [opts.dir]          Test-only fixture directory.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
 *   Defaults to the project Logger. Tests pass a spy that captures lines.
 * @returns {Promise<PreflightResult>}
 */
export async function runPreflight({
  scope,
  autoFix = true,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger = DEFAULT_LOGGER,
} = {}) {
  if (!scope || typeof scope !== 'string') {
    throw new Error('runPreflight: scope is required');
  }
  // `retro` is reserved by the runner and is never a preflight scope.
  // Catch it here so the failure mode is obvious instead of routing into
  // the runner's autoFix throw.
  if (scope === 'retro') {
    throw new Error(
      'runPreflight: retro scope is read-only — call runChecks directly',
    );
  }
  const state = assembleState({ scope, cwd, probes });
  const { findings, fixed } = await runChecks({
    scope,
    autoFix,
    state,
    registry,
    dir,
  });
  if (fixed.length > 0) logFixes(fixed, logger);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const blocked = blockers.length > 0;
  if (blocked) logBlockers(scope, blockers, logger);
  // Surface non-blocker findings as well so operators see warnings/info.
  const nonBlockerFindings = findings.filter((f) => f.severity !== 'blocker');
  if (nonBlockerFindings.length > 0) logNonBlockers(nonBlockerFindings, logger);
  return { findings, fixed, blocked };
}

/**
 * Pick the logger method for `level` — falls back through the project
 * Logger if the supplied logger is missing the level. Keeps the
 * console-allowlist test happy (no direct console.* fallback here) and
 * still lets tests swap the entire logger out.
 */
function pick(logger, level) {
  if (logger && typeof logger[level] === 'function') {
    return (msg) => logger[level](msg);
  }
  return (msg) => Logger[level](msg);
}

/**
 * Print the auto-fixed findings as a one-line-per-fix summary.
 *
 * @param {Array<object>} fixed
 * @param {object} [logger]
 */
export function logFixes(fixed, logger = DEFAULT_LOGGER) {
  const info = pick(logger, 'info');
  info(`[preflight] auto-fixed ${fixed.length} finding(s):`);
  for (const f of fixed) {
    const msg = f.fixResult?.message ?? 'fixed';
    info(`  - ${f.id}: ${msg}`);
  }
}

/**
 * Print the blocker table the operator sees on `exit 2`. Each row carries
 * `id · summary · fixCommand`; details (if present) wrap underneath.
 *
 * @param {string} scope
 * @param {Array<object>} blockers
 * @param {object} [logger]
 */
export function logBlockers(scope, blockers, logger = DEFAULT_LOGGER) {
  const error = pick(logger, 'error');
  error(
    `[preflight] ${scope}: ${blockers.length} blocker finding(s) — refusing to proceed.`,
  );
  error('');
  error('  id                          severity  summary / fixCommand');
  error(
    '  --------------------------  --------  ----------------------------------------',
  );
  for (const b of blockers) {
    // Pad short IDs to align the column; never TRUNCATE — the operator
    // needs the full id to find the check module on disk and to grep the
    // codebase for the failure mode. Long ids just push the severity
    // column right, which is fine for terminal output.
    const id = String(b.id).padEnd(26);
    const sev = String(b.severity).padEnd(8);
    error(`  ${id}  ${sev}  ${b.summary ?? ''}`);
    if (b.detail) {
      for (const line of String(b.detail).split('\n')) {
        error(`                                          ${line}`);
      }
    }
    if (b.fixCommand) {
      error(`                                          $ ${b.fixCommand}`);
    }
  }
  error('');
  error(
    '[preflight] exit 2 — fix the blockers above (or rerun the listed fix commands) and retry.',
  );
}

/**
 * Print warning/info findings as one line each. These never block.
 *
 * @param {Array<object>} findings
 * @param {object} [logger]
 */
export function logNonBlockers(findings, logger = DEFAULT_LOGGER) {
  const warn = pick(logger, 'warn');
  for (const f of findings) {
    warn(`[preflight] ${f.severity}: ${f.id} — ${f.summary ?? ''}`);
    if (f.fixCommand) warn(`    $ ${f.fixCommand}`);
  }
}

/**
 * The reserved exit code for "preflight refused". Re-exported so consumer
 * scripts can `process.exit(PREFLIGHT_REFUSED_EXIT_CODE)` instead of
 * hard-coding the magic number.
 */
export const PREFLIGHT_REFUSED_EXIT_CODE = 2;
