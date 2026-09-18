/**
 * gh-exec.js — `gh` CLI wrapper. `args` is always an array spawned without a
 * shell, so argument injection is impossible by construction.
 */

import { spawn as defaultSpawn } from 'node:child_process';

let _spawnCount = 0;

/**
 * @returns {number}
 */
export function getSpawnCount() {
  return _spawnCount;
}

export function resetSpawnCount() {
  _spawnCount = 0;
}

/** `code` is null when the process never produced one. */
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

export class GhExecTimeoutError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhExecTimeoutError';
    this.timeoutMs = details.timeoutMs ?? null;
  }
}

export class GhNotInstalledError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhNotInstalledError';
  }
}

export class GhAuthError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhAuthError';
  }
}

/** Primary or secondary rate limit — callers back off, not re-auth. */
export class GhRateLimitError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhRateLimitError';
  }
}

export class GhNotFoundError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhNotFoundError';
  }
}

export class GhScopeError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhScopeError';
  }
}

export class GhGraphqlError extends GhExecError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'GhGraphqlError';
  }
}

/**
 * Message plus the last stderr line — where `gh` prints the actionable
 * reason, which the classified message omits.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeGhFailure(err) {
  const message = String(err?.message ?? err ?? 'unknown error');
  const lines = String(err?.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.at(-1);
  return detail ? `${message}: ${detail}` : message;
}

/**
 * @param {object} ctx
 * @param {string} [ctx.stderr]
 * @param {number|null} [ctx.code]
 * @param {string[]} [ctx.args]
 * @param {string} [ctx.stdout]
 * @param {Error}  [ctx.spawnError]
 * @returns {GhExecError}
 */
/**
 * First match wins.
 *
 * @type {Array<{
 *   test: (h: string) => boolean,
 *   build: (details: object) => Error,
 * }>}
 */
const CLASSIFY_RULES = [
  {
    pattern:
      /command not found|is not recognized|no such file or directory.*gh/,
    build: (d) =>
      new GhNotInstalledError(
        'gh-exec: gh CLI is not installed or not on PATH',
        d,
      ),
  },
  {
    pattern: /requires authentication|not logged into|authentication required/,
    build: (d) =>
      new GhAuthError(
        'gh-exec: gh is not authenticated — run `gh auth login`',
        d,
      ),
  },
  {
    pattern: /secondary rate limit|api rate limit exceeded|rate limit exceeded/,
    build: (d) =>
      new GhRateLimitError('gh-exec: gh API rate limit exceeded', d),
  },
  {
    pattern:
      /missing.*scope|requires the .* scope|your token has not been granted the required scopes/,
    build: (d) =>
      new GhScopeError(
        'gh-exec: gh token is missing a required OAuth scope',
        d,
      ),
  },
  {
    pattern: /http 404|could not resolve to a|not found/,
    build: (d) => new GhNotFoundError('gh-exec: resource not found', d),
  },
  {
    pattern: /^graphql:|graphql error|graphql.*errors/,
    build: (d) => new GhGraphqlError('gh-exec: GraphQL error from gh api', d),
  },
];

function classifySpawnError(spawnError, details) {
  if (spawnError && spawnError.code === 'ENOENT') {
    return new GhNotInstalledError(
      `gh-exec: gh CLI is not installed or not on PATH: ${spawnError.message}`,
      details,
    );
  }
  return null;
}

export function classify({
  stderr = '',
  code = null,
  args,
  stdout = '',
  spawnError,
} = {}) {
  const details = { args, stdout, stderr, code };
  const spawnVerdict = classifySpawnError(spawnError, details);
  if (spawnVerdict) return spawnVerdict;
  const haystack = `${stderr}`.toLowerCase();
  // With a spawnError, skip the not-installed text rule.
  const startIdx = spawnError ? 1 : 0;
  for (let i = startIdx; i < CLASSIFY_RULES.length; i += 1) {
    if (CLASSIFY_RULES[i].pattern.test(haystack))
      return CLASSIFY_RULES[i].build(details);
  }
  return new GhExecError(`gh-exec: gh exited with code ${code}`, details);
}

/**
 * @param {object} opts
 * @param {string[]} opts.args
 * @param {string} [opts.input]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.spawnImpl]
 * @returns {Promise<object|{stdout:string,stderr:string,code:number}>}
 *   Parsed JSON when `args` contains `--json`, else the raw envelope.
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
      // Counted before the call so an immediate-throw spawn still counts.
      _spawnCount += 1;
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

/**
 * Typed `gh` facade over an `exec` implementation (tests inject a fake).
 *
 * @param {Function} execImpl
 * @param {object} [defaultExecOpts] — per-call options win.
 */
export function createGh(execImpl = exec, defaultExecOpts = {}) {
  const execWithDefaults = (opts) => execImpl({ ...defaultExecOpts, ...opts });
  /**
   * @param {object} opts
   * @param {string} [opts.method='GET']
   * @param {string} opts.endpoint
   * @param {object} [opts.body]          Written to stdin via --input -.
   * @param {string[]} [opts.fields]      Projected as `--jq .a,.b`.
   * @param {boolean} [opts.paginate]
   * @param {object}  [opts.execOpts]
   */
  function api({
    method = 'GET',
    endpoint,
    body,
    fields,
    paginate = false,
    execOpts = {},
  } = {}) {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return Promise.reject(
        new GhExecError('gh.api: `endpoint` is required', { args: [] }),
      );
    }
    const args = ['api', '-X', method, endpoint];
    if (paginate) args.push('--paginate');
    if (Array.isArray(fields) && fields.length > 0) {
      args.push('--jq', fields.map((f) => `.${f}`).join(','));
    }
    let input;
    if (body !== undefined && body !== null) {
      args.push('--input', '-');
      input = JSON.stringify(body);
    }
    return execWithDefaults({ args, input, ...execOpts });
  }

  function jsonFlag(fields) {
    if (!Array.isArray(fields) || fields.length === 0) return [];
    return ['--json', fields.join(',')];
  }

  function idStr(id) {
    return typeof id === 'number' ? String(id) : id;
  }

  const issue = {
    view: (id, fields) =>
      execWithDefaults({
        args: ['issue', 'view', idStr(id), ...jsonFlag(fields)],
      }),
    edit: (id, flags = []) =>
      execWithDefaults({ args: ['issue', 'edit', idStr(id), ...flags] }),
    comment: (id, bodyText) =>
      execWithDefaults({
        args: ['issue', 'comment', idStr(id), '--body-file', '-'],
        input: bodyText,
      }),
    list: (flags = [], fields) =>
      execWithDefaults({
        args: ['issue', 'list', ...flags, ...jsonFlag(fields)],
      }),
  };

  const pr = {
    view: (id, fields) =>
      execWithDefaults({
        args: ['pr', 'view', idStr(id), ...jsonFlag(fields)],
      }),
    create: (flags = []) =>
      execWithDefaults({ args: ['pr', 'create', ...flags] }),
    edit: (id, flags = []) =>
      execWithDefaults({ args: ['pr', 'edit', idStr(id), ...flags] }),
    merge: (id, flags = []) =>
      execWithDefaults({ args: ['pr', 'merge', idStr(id), ...flags] }),
    /** Bring a `mergeStateStatus: BEHIND` PR up to date with its base. */
    updateBranch: (id, flags = []) =>
      execWithDefaults({ args: ['pr', 'update-branch', idStr(id), ...flags] }),
    list: (flags = [], fields) =>
      execWithDefaults({
        args: ['pr', 'list', ...flags, ...jsonFlag(fields)],
      }),
  };

  const label = {
    create: (name, flags = []) =>
      execWithDefaults({ args: ['label', 'create', name, ...flags] }),
    edit: (name, flags = []) =>
      execWithDefaults({ args: ['label', 'edit', name, ...flags] }),
    list: (flags = [], fields) =>
      execWithDefaults({
        args: ['label', 'list', ...flags, ...jsonFlag(fields)],
      }),
  };

  const repo = {
    view: (target, fields) => {
      const args = ['repo', 'view'];
      if (target) args.push(target);
      args.push(...jsonFlag(fields));
      return execWithDefaults({ args });
    },
    edit: (target, flags = []) => {
      const args = ['repo', 'edit'];
      if (target) args.push(target);
      args.push(...flags);
      return execWithDefaults({ args });
    },
  };

  const defaults = Object.freeze({ ...defaultExecOpts });
  return { api, issue, pr, label, repo, defaults };
}

export const gh = createGh();

/**
 * `gh` routes every one of these through GraphQL, so a GraphQL 403 gates the
 * whole PR surface. Kept beside `pr` so the refusal text cannot drift.
 */
const GH_PR_SUBCOMMANDS = Object.freeze([
  'view',
  'create',
  'edit',
  'merge',
  'update-branch',
  'list',
]);

/** Cheapest authenticated GraphQL read: no repo, no extra scope. */
const GRAPHQL_PROBE_QUERY = 'query{viewer{login}}';

const GRAPHQL_PROBE_TIMEOUT_MS = 15_000;

/**
 * Fail-open: an ambiguous error reports `available`. A rate limit also
 * arrives as a 403 but says nothing about reachability, so it is matched
 * before the bare 403.
 *
 * @param {unknown} err
 * @returns {{ verdict: 'available'|'unavailable'|'auth-failed', reason: string }}
 */
function classifyGraphqlProbeFailure(err) {
  const haystack = `${err?.stderr ?? ''}\n${err?.message ?? ''}`.toLowerCase();
  const authShaped =
    err instanceof GhAuthError ||
    err instanceof GhScopeError ||
    /http 401|bad credentials|requires authentication|not logged into|gh auth login/.test(
      haystack,
    );
  if (authShaped) return { verdict: 'auth-failed', reason: 'auth' };
  const rateLimited =
    err instanceof GhRateLimitError || /rate[ -]?limit/.test(haystack);
  if (rateLimited)
    return { verdict: 'available', reason: 'rate-limited-inconclusive' };
  if (/http 403|403 forbidden/.test(haystack))
    return { verdict: 'unavailable', reason: 'http-403' };
  return { verdict: 'available', reason: 'probe-inconclusive' };
}

/**
 * Is GraphQL reachable from this session? `unavailable` is the web-session
 * 403 shape; `auth-failed` has a different remedy and is kept distinct.
 * Never throws.
 *
 * @param {{ ghFacade?: { api: Function } }} [opts]
 * @returns {Promise<{ verdict: string, available: boolean, reason: string,
 *   detail: string|null }>}
 */
export async function probeGraphqlAvailability({ ghFacade = gh } = {}) {
  try {
    await ghFacade.api({
      method: 'POST',
      endpoint: 'graphql',
      body: { query: GRAPHQL_PROBE_QUERY },
      execOpts: { timeoutMs: GRAPHQL_PROBE_TIMEOUT_MS },
    });
    return {
      verdict: 'available',
      available: true,
      reason: 'ok',
      detail: null,
    };
  } catch (err) {
    const { verdict, reason } = classifyGraphqlProbeFailure(err);
    return {
      verdict,
      available: verdict === 'available',
      reason,
      detail: describeGhFailure(err),
    };
  }
}

/**
 * @param {{ verdict?: string, detail?: string|null }} probe
 * @returns {string}
 */
export function describeGraphqlPreflight({ verdict, detail } = {}) {
  const suffix = detail ? ` (gh said: ${detail})` : '';
  if (verdict === 'auth-failed') {
    return (
      'GitHub authentication failed: `gh` has no usable token (missing, expired, or missing a ' +
      'required scope), so no GitHub call this close makes can succeed. This is NOT the ' +
      'GraphQL-unavailable condition and moving sessions will not fix it — re-authenticate ' +
      '(`gh auth login`, or export a valid token) and re-run close where you are.' +
      suffix
    );
  }
  const subcommands = GH_PR_SUBCOMMANDS.map((s) => `\`gh pr ${s}\``).join(', ');
  return (
    'GitHub GraphQL is unavailable in this session (HTTP 403). `gh` routes the entire pull-request ' +
    `surface through GraphQL — ${subcommands} — so this close can neither open, inspect, nor merge ` +
    'a pull request, and every later phase would fail the same way. Retrying here will not help: ' +
    're-run the close from a local session, where GraphQL is reachable.' +
    suffix
  );
}

export default exec;
