/**
 * The one child-process execution surface. It owns three policies: the
 * stdout ceiling (Node's 1 MB default kills the child with ENOBUFS for a
 * reason unrelated to the command), shell-free argv, and result/error
 * normalisation. Each wrapper takes an optional injected `run` so callers
 * keep their own test seams. New modules must not import
 * `node:child_process` directly (an enforcement test allowlists importers).
 *
 * @module lib/child-exec
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const MIB = 1024 * 1024;

/**
 * Not exported: callers get it by using a wrapper, never by remembering a
 * number. `maxBuffer` caps rather than reserves, so generous is free.
 *
 * @type {number}
 */
const MAX_BUFFER_BYTES = 64 * MIB;

/**
 * Deliberately lower bound for `diagnose-friction.js`: a reported policy
 * limit (it records `executionMaxBuffer` on the friction row), not an
 * overflow guard.
 *
 * @type {number}
 */
export const INTERCEPTOR_MAX_BUFFER_BYTES = 10 * MIB;

/**
 * `maxBuffer` goes last so a caller's spread cannot reset it to 1 MB.
 *
 * @param {{ encoding: string }} defaults
 * @param {object} rest
 * @param {number} maxBuffer
 * @returns {object}
 */
function childOptions(defaults, rest, maxBuffer) {
  return { ...defaults, shell: false, ...rest, maxBuffer };
}

/**
 * Throws on non-zero exit, like `execFileSync`.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {Function} [opts.run]
 * @param {number}   [opts.maxBuffer]
 * @returns {string}
 */
export function execFileCapture(file, args, opts = {}) {
  const { run = execFileSync, maxBuffer = MAX_BUFFER_BYTES, ...rest } = opts;
  return run(file, args, childOptions({ encoding: 'utf8' }, rest, maxBuffer));
}

const execFileAsync = promisify(execFile);

/**
 * Rejects on non-zero exit.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function execFileCaptureAsync(file, args, opts = {}) {
  const { run = execFileAsync, maxBuffer = MAX_BUFFER_BYTES, ...rest } = opts;
  return run(file, args, childOptions({ encoding: 'utf8' }, rest, maxBuffer));
}

/**
 * Raw `spawnSync` result (untrimmed output, `null` status preserved); never
 * throws on non-zero exit.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function spawnChild(file, args, opts = {}) {
  const { run = spawnSync, maxBuffer = MAX_BUFFER_BYTES, ...rest } = opts;
  return run(
    file,
    args,
    childOptions({ encoding: 'utf-8', stdio: 'pipe' }, rest, maxBuffer),
  );
}

/**
 * A `null` status becomes 1 (`process.exit(null)` would exit 0); streams are
 * trimmed.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function spawnCapture(file, args, opts = {}) {
  const result = spawnChild(file, args, opts);
  return {
    status: result?.status ?? 1,
    stdout: (result?.stdout ?? '').toString().trim(),
    stderr: (result?.stderr ?? '').toString().trim(),
  };
}

/**
 * `status=null` is printed verbatim: it means the child was killed.
 *
 * @param {object} failure
 * @param {string} failure.label
 * @param {number|null} failure.status
 * @param {unknown} [failure.stderr]
 * @returns {string}
 */
export function formatChildFailure({ label, status, stderr }) {
  const detail = (stderr ?? '').toString().trim();
  return `${label} failed (status=${status}): ${detail}`;
}
