/**
 * runtime-context.js — Dependency-injection seam for legacy utilities.
 *
 * `createRuntimeContext` returns a frozen `ctx` bag with Node defaults for
 * the four side-effect channels that the legacy `.agents/scripts/lib/*` code
 * historically imported directly: `git`, `fs`, `exec`, and `logger`.
 *
 * Callers can override any channel for tests or alternative runtimes; unset
 * channels fall back to the real Node impls so existing production call sites
 * behave identically to the pre-injection code.
 */

import { exec as nodeExec } from 'node:child_process';
import nodeFs from 'node:fs';
import * as defaultGit from './git-utils.js';
import { Logger } from './Logger.js';
import { resolveConcurrency } from './orchestration/concurrency.js';

const CONSOLE_LOGGER = Object.freeze({
  info: (m) => Logger.info(m),
  warn: (m) => Logger.warn(m),
  error: (m) => Logger.error(m),
});

/**
 * Build a runtime context bag.
 *
 * @param {object} [overrides]
 * @param {object} [overrides.git]    Injected git interface (`{ gitSync, gitSpawn, ... }`).
 *                                     Defaults to the module exports of `./git-utils.js`.
 * @param {object} [overrides.fs]     Injected fs impl. Defaults to `node:fs`.
 * @param {Function} [overrides.exec] Injected `child_process.exec`.
 * @param {object} [overrides.logger] Logger with `info`/`warn`/`error`. Defaults to console.
 * @param {object} [overrides.orchestration] Resolved orchestration config —
 *                                           used to derive `ctx.concurrency`.
 *                                           Omitting it leaves ctx.concurrency
 *                                           at its v5.21.0 constant defaults.
 * @param {object} [overrides.concurrency]   Pre-resolved concurrency caps.
 *                                           Takes precedence over `orchestration`.
 * @returns {Readonly<{git: object, fs: object, exec: Function, logger: object, concurrency: object}>}
 */
export function createRuntimeContext(overrides = {}) {
  const concurrency =
    overrides.concurrency ?? resolveConcurrency(overrides.orchestration);
  return Object.freeze({
    git: overrides.git ?? defaultGit,
    fs: overrides.fs ?? nodeFs,
    exec: overrides.exec ?? nodeExec,
    logger: overrides.logger ?? CONSOLE_LOGGER,
    concurrency,
  });
}
