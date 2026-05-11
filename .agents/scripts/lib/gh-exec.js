/**
 * gh-exec.js — spawn-based wrapper around the `gh` CLI.
 *
 * Story #1356 (Epic #1179 — v6 Epic A: MCP + gh CLI rebase). This is the
 * core shim that subsequent provider rewrites build on. It deliberately
 * stays narrow:
 *
 *   - `exec({ args, input, timeoutMs })` shells out via
 *     `child_process.spawn('gh', args, { stdio: ['pipe','pipe','pipe'] })`.
 *     `args` is always an array — no string-interpolated command line, no
 *     `shell: true`. That keeps argument injection impossible by
 *     construction.
 *   - When `args` contains the literal `--json` flag, stdout is run through
 *     `JSON.parse` before returning. Callers that pass `--json` are asking
 *     for structured data; honor that.
 *   - When `args` does not contain `--json`, the raw `{ stdout, stderr, code }`
 *     envelope is returned. This is what `gh api` callers and the few
 *     "read raw text" call sites want.
 *
 * Error surface is intentionally a single base class in this Task —
 * `GhExecTimeoutError` is the only specialization required by the
 * acceptance criteria. Task #1369 layers the rest of the typed error
 * classes (auth-required, not-found, GraphQL, etc.) on top of `GhExecError`.
 * Task #1370 adds the typed convenience wrappers (`issue.view`, `pr.create`,
 * `api`, etc.).
 *
 * The module exports `exec` as the default export plus named exports for
 * the error classes so callers can `instanceof`-check without importing
 * the whole module namespace.
 */

import { spawn as defaultSpawn } from 'node:child_process';

/**
 * Base class for all gh-exec errors. Carries the args that were passed to
 * `gh`, the captured stdout/stderr, and the process exit code (or null when
 * the process never produced one — e.g. timeout, spawn error).
 */
export class GhExecError extends Error {
  constructor(message, { args, stdout = '', stderr = '', code = null } = {}) {
    super(message);
    this.name = 'GhExecError';
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Raised when the child process is killed by the `timeout` option before it
 * exits on its own. Distinct from `GhExecError` so callers (retry loops,
 * watchdog code) can match on `instanceof GhExecTimeoutError`.
 */
export class GhExecTimeoutError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhExecTimeoutError';
    this.timeoutMs = details.timeoutMs ?? null;
  }
}

/**
 * Spawn `gh` with the given args. Returns a Promise.
 *
 * @param {object} opts
 * @param {string[]} opts.args
 *   Positional + flag arguments to pass to `gh`. Must be an array — string
 *   command lines are rejected so callers cannot accidentally invite shell
 *   interpolation.
 * @param {string} [opts.input]
 *   Optional stdin payload. Written to the child once and then closed.
 * @param {number} [opts.timeoutMs]
 *   Optional wall-clock timeout. When the child is killed by this timeout
 *   the returned Promise rejects with `GhExecTimeoutError`.
 * @param {Function} [opts.spawnImpl]
 *   Test seam — defaults to `child_process.spawn`. Tests inject a fake that
 *   returns an `EventEmitter`-shaped object.
 * @returns {Promise<object|{stdout:string,stderr:string,code:number}>}
 *   When `args` contains `--json`, resolves to the parsed JSON value.
 *   Otherwise resolves to `{ stdout, stderr, code }`.
 */
export function exec({
  args,
  input,
  timeoutMs,
  spawnImpl = defaultSpawn,
} = {}) {
  if (!Array.isArray(args)) {
    return Promise.reject(
      new GhExecError('gh-exec: `args` must be an array', { args }),
    );
  }

  const spawnOpts = {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  };
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    spawnOpts.timeout = timeoutMs;
  }

  const wantsJson = args.includes('--json');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('gh', args, spawnOpts);
    } catch (err) {
      reject(
        new GhExecError(`gh-exec: spawn failed: ${err.message}`, { args }),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(
        new GhExecError(`gh-exec: process error: ${err.message}`, {
          args,
          stdout,
          stderr,
        }),
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;

      // Node sets `signal` to `SIGTERM` when the spawn `timeout` fires.
      const timedOut =
        spawnOpts.timeout !== undefined &&
        (signal === 'SIGTERM' || code === null);
      if (timedOut && spawnOpts.timeout !== undefined) {
        reject(
          new GhExecTimeoutError(
            `gh-exec: gh ${args.join(' ')} exceeded ${spawnOpts.timeout}ms`,
            { args, stdout, stderr, code, timeoutMs: spawnOpts.timeout },
          ),
        );
        return;
      }

      if (wantsJson) {
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(
            new GhExecError(
              `gh-exec: --json was requested but stdout was not valid JSON: ${err.message}`,
              { args, stdout, stderr, code },
            ),
          );
        }
        return;
      }

      resolve({ stdout, stderr, code });
    });

    if (typeof input === 'string' && child.stdin) {
      child.stdin.end(input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

export default exec;
