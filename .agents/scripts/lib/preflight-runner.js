/**
 * preflight-runner.js — run the checks registry, log auto-fixes (which never
 * block) before the blocker table, and report `blocked` so the consumer
 * exits {@link PREFLIGHT_REFUSED_EXIT_CODE}.
 */

import { runChecks } from './checks/index.js';
import { assembleState } from './checks/state.js';
import { Logger } from './Logger.js';

/**
 * @typedef {object} PreflightResult
 * @property {Array<object>} findings  Unfixed findings (any severity).
 * @property {Array<object>} fixed     Findings that were auto-corrected.
 * @property {boolean} blocked         True iff `findings` contains a
 *   `severity: 'blocker'`; the consumer must then exit 2.
 */

const DEFAULT_LOGGER = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
};

/**
 * @param {object} opts
 * @param {string} opts.scope          e.g. `'story-close'`, `'npm-test'`.
 * @param {boolean} [opts.autoFix=true]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]       Test-only.
 * @param {object} [opts.registry]     Test-only.
 * @param {string} [opts.dir]          Test-only.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
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
  // `retro` is read-only; fail here rather than in runChecks' autoFix throw.
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
  const nonBlockerFindings = findings.filter((f) => f.severity !== 'blocker');
  if (nonBlockerFindings.length > 0) logNonBlockers(nonBlockerFindings, logger);
  return { findings, fixed, blocked };
}

/** Falls back to the project Logger — never to `console.*` directly. */
function pick(logger, level) {
  if (logger && typeof logger[level] === 'function') {
    return (msg) => logger[level](msg);
  }
  return (msg) => Logger[level](msg);
}

/**
 * @param {Array<object>} fixed
 * @param {object} [logger]
 */
function logFixes(fixed, logger = DEFAULT_LOGGER) {
  const info = pick(logger, 'info');
  info(`[preflight] auto-fixed ${fixed.length} finding(s):`);
  for (const f of fixed) {
    const msg = f.fixResult?.message ?? 'fixed';
    info(`  - ${f.id}: ${msg}`);
  }
}

/**
 * @param {string} scope
 * @param {Array<object>} blockers
 * @param {object} [logger]
 */
function logBlockers(scope, blockers, logger = DEFAULT_LOGGER) {
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
    // Pad, never truncate — the operator needs the full id to find the check.
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
 * @param {Array<object>} findings
 * @param {object} [logger]
 */
function logNonBlockers(findings, logger = DEFAULT_LOGGER) {
  const warn = pick(logger, 'warn');
  for (const f of findings) {
    warn(`[preflight] ${f.severity}: ${f.id} — ${f.summary ?? ''}`);
    if (f.fixCommand) warn(`    $ ${f.fixCommand}`);
  }
}

/** Project-wide "preflight refused" exit code. */
export const PREFLIGHT_REFUSED_EXIT_CODE = 2;
