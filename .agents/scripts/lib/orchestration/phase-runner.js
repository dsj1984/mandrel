/**
 * phase-runner.js — Lightweight wrappers for "named phase" error handling.
 *
 * Many orchestration entry points (`single-story-init.js`,
 * `single-story-close.js`, and other phase modules) repeat the same
 * `try { ... } catch (err) {
 * logger.error('[phase=foo] ' + err.message); ... }` block. These two
 * helpers consolidate that pattern.
 *
 *   - `runPhase(name, fn, opts)`: Run `fn()`. On error, log with a
 *     `[phase=<name>]` prefix. If `fatal: true`, rethrow; otherwise
 *     return `opts.fallback` (default `undefined`) so the caller can
 *     continue.
 *
 *   - `runSafely(fn, opts)`: Run `fn()` and swallow any error after
 *     logging it. Convenience for unnamed best-effort cleanup steps.
 *
 * Both helpers handle sync and async `fn`s — the return value is always
 * a Promise that resolves to the function's value (or `fallback`).
 */

import { NOOP_LOGGER } from '../Logger.js';

/**
 * @typedef {object} PhaseLogger
 * @property {(msg: string) => void} [error]
 * @property {(msg: string) => void} [warn]
 */

function pickLogger(logger) {
  if (!logger) return NOOP_LOGGER;
  return {
    error:
      typeof logger.error === 'function'
        ? logger.error.bind(logger)
        : NOOP_LOGGER.error,
    warn:
      typeof logger.warn === 'function'
        ? logger.warn.bind(logger)
        : NOOP_LOGGER.warn,
  };
}

/**
 * Run `fn` under a named phase. On error:
 *   - logs `[phase=<name>] <message>` via `logger.error`
 *   - if `fatal` is true, rethrows the original error
 *   - otherwise returns `fallback`
 *
 * @template T
 * @param {string} name - Phase name (used in the log prefix).
 * @param {() => (T | Promise<T>)} fn
 * @param {{ logger?: PhaseLogger, fallback?: T, fatal?: boolean }} [opts]
 * @returns {Promise<T | undefined>}
 */
export async function runPhase(name, fn, opts = {}) {
  const logger = pickLogger(opts.logger);
  const fatal = opts.fatal === true;
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[phase=${name}] ${message}`);
    if (fatal) throw err;
    return opts.fallback;
  }
}

/**
 * Run `fn` and swallow errors after logging. Equivalent to
 * `runPhase('safe', fn, { logger, fatal: false })` but without requiring
 * the caller to invent a phase name.
 *
 * @template T
 * @param {() => (T | Promise<T>)} fn
 * @param {{ logger?: PhaseLogger }} [opts]
 * @returns {Promise<T | undefined>}
 */
export async function runSafely(fn, opts = {}) {
  const logger = pickLogger(opts.logger);
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[phase=safe] ${message}`);
    return undefined;
  }
}
