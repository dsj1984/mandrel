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

import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { streamChild } from './child-stream.js';

const MIB = 1024 * 1024;

/**
 * Not exported: callers get it by using a wrapper, never by remembering a
 * number. `maxBuffer` caps rather than reserves, so generous is free.
 *
 * @type {number}
 */
const MAX_BUFFER_BYTES = 64 * MIB;

/**
 * The ceiling, readable for *reporting* only: `diagnose-friction.js` names
 * the bound that killed an overflowed child on its friction row. Passing it
 * as a `maxBuffer` is redundant — omitting the option applies it.
 *
 * @type {number}
 */
export const REPORTED_MAX_BUFFER_BYTES = MAX_BUFFER_BYTES;

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
  return normalizeCapture(spawnChild(file, args, opts));
}

function normalizeCapture(result) {
  return {
    status: result?.status ?? 1,
    stdout: (result?.stdout ?? '').toString().trim(),
    stderr: (result?.stderr ?? '').toString().trim(),
  };
}

/**
 * The async runner behind `spawnCaptureAsync`: `input` rides stdin; a
 * timeout, overflow or spawn error resolves with a non-numeric status.
 *
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
function execCollect(file, args, { input, ...options }) {
  return new Promise((resolve) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      const status = Number.isInteger(code) ? code : null;
      const reason = status === null ? error.message : '';
      resolve({ status, stdout, stderr: stderr || reason });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/**
 * `spawnCapture` without blocking the event loop: concurrent children keep
 * draining while this one runs. Same normalisation (`null` → 1, trimmed).
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {Function} [opts.run] - async (or sync) `(file, args, options)` seam.
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function spawnCaptureAsync(file, args, opts = {}) {
  return normalizeCapture(
    await spawnChild(file, args, { run: execCollect, ...opts }),
  );
}

/**
 * Spawn and stream each output chunk to `opts.onChunk` while retaining a
 * bounded tail; see `child-stream.js` for the contract.
 *
 * @param {string}   file
 * @param {string[]} args
 * @param {object}   [opts]
 */
export const spawnStreamAsync = (file, args, opts = {}) =>
  streamChild(file, args, { spawnImpl: spawn, ...opts });

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
