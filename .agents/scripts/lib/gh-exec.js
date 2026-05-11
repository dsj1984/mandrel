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
 * `gh` is not on PATH (ENOENT on spawn, or stderr literally contains the
 * "command not found" / "is not recognized" phrasing for Windows). Callers
 * (`agents-bootstrap-github`) treat this as a hard preflight failure and
 * print install instructions.
 */
export class GhNotInstalledError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhNotInstalledError';
  }
}

/** `gh auth login` has not been run (or the token expired). */
export class GhAuthError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhAuthError';
  }
}

/**
 * Hit a primary or secondary rate limit. Distinct from auth so caller retry
 * loops can back off rather than re-prompt for credentials.
 */
export class GhRateLimitError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhRateLimitError';
  }
}

/** Resource (issue, PR, repo, branch) does not exist or is not visible. */
export class GhNotFoundError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhNotFoundError';
  }
}

/**
 * The authenticated user is authenticated but missing a required scope (e.g.
 * `project` for Projects V2). `gh auth refresh -s <scope>` is the canonical
 * recovery.
 */
export class GhScopeError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhScopeError';
  }
}

/**
 * GraphQL endpoint returned `errors[]` (most commonly emitted by
 * `gh api graphql`). The stderr carries the rendered error string; we
 * surface it as-is so callers can pattern-match on the specific GraphQL
 * failure if they care.
 */
export class GhGraphqlError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhGraphqlError';
  }
}

/**
 * Classify a non-zero `gh` invocation into the most specific typed error
 * subclass available. Pure function — no side effects, no I/O.
 *
 * Pattern table (order-sensitive: more specific patterns first):
 *
 *   spawnError.code === 'ENOENT'  → GhNotInstalledError
 *   /command not found|not recognized/i (no spawnError) → GhNotInstalledError
 *   /requires authentication|auth (login|status)/i      → GhAuthError
 *   /rate limit|secondary rate limit|API rate limit/i   → GhRateLimitError
 *   /missing.*scope|requires the .* scope/i             → GhScopeError
 *   /HTTP 404|not found|could not resolve/i             → GhNotFoundError
 *   /GraphQL: |graphql.*error/i                         → GhGraphqlError
 *   anything else                                       → GhExecError
 *
 * @param {object} ctx
 * @param {string} [ctx.stderr]
 * @param {number|null} [ctx.code]
 * @param {string[]} [ctx.args]
 * @param {string} [ctx.stdout]
 * @param {Error}  [ctx.spawnError]
 *   Raw error thrown by `spawn` (e.g. ENOENT). Passed through so the auth
 *   path can distinguish "missing binary" from "binary present, said no".
 * @returns {GhExecError}
 */
export function classify({
  stderr = '',
  code = null,
  args,
  stdout = '',
  spawnError,
} = {}) {
  const details = { args, stdout, stderr, code };
  const haystack = `${stderr}`.toLowerCase();

  if (spawnError && spawnError.code === 'ENOENT') {
    return new GhNotInstalledError(
      `gh-exec: gh CLI is not installed or not on PATH: ${spawnError.message}`,
      details,
    );
  }
  if (
    !spawnError &&
    (/command not found/.test(haystack) ||
      /is not recognized/.test(haystack) ||
      /no such file or directory.*gh/.test(haystack))
  ) {
    return new GhNotInstalledError(
      'gh-exec: gh CLI is not installed or not on PATH',
      details,
    );
  }

  if (
    /requires authentication/.test(haystack) ||
    /not logged into/.test(haystack) ||
    /authentication required/.test(haystack)
  ) {
    return new GhAuthError(
      'gh-exec: gh is not authenticated — run `gh auth login`',
      details,
    );
  }

  if (
    /secondary rate limit/.test(haystack) ||
    /api rate limit exceeded/.test(haystack) ||
    /rate limit exceeded/.test(haystack)
  ) {
    return new GhRateLimitError('gh-exec: gh API rate limit exceeded', details);
  }

  if (
    /missing.*scope/.test(haystack) ||
    /requires the .* scope/.test(haystack) ||
    /your token has not been granted the required scopes/.test(haystack)
  ) {
    return new GhScopeError(
      'gh-exec: gh token is missing a required OAuth scope',
      details,
    );
  }

  if (
    /http 404/.test(haystack) ||
    /could not resolve to a/.test(haystack) ||
    /not found/.test(haystack)
  ) {
    return new GhNotFoundError('gh-exec: resource not found', details);
  }

  if (
    /^graphql:/.test(haystack) ||
    /graphql error/.test(haystack) ||
    /graphql.*errors/.test(haystack)
  ) {
    return new GhGraphqlError('gh-exec: GraphQL error from gh api', details);
  }

  return new GhExecError(`gh-exec: gh exited with code ${code}`, details);
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
      reject(classify({ spawnError: err, args }));
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
      reject(classify({ spawnError: err, args, stdout, stderr, code: null }));
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

      if (code !== 0) {
        reject(classify({ args, stdout, stderr, code }));
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
