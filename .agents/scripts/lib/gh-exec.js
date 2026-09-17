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
 * Throw-away in-process spawn counter (Story #1795 / Epic #1788).
 *
 * Incremented once per `exec()` invocation that successfully reaches the
 * `spawnImpl('gh', ...)` call. Exported via `getSpawnCount` so the
 * Story-close structured comment can emit it under `ghSpawnCount` for
 * the ">=100 fewer spawns" acceptance criterion. This counter is
 * deliberately ephemeral — Story #1795's acceptance includes removing
 * the counter and `getSpawnCount` helper in a follow-up cleanup commit
 * before the Story merges to the Epic branch.
 */
let _spawnCount = 0;

/**
 * Return the running total of `gh` spawns since this module was loaded
 * (or since the last `resetSpawnCount()` call). Counts every spawn
 * attempt, including those that error before the child exits.
 *
 * @returns {number}
 */
export function getSpawnCount() {
  return _spawnCount;
}

/**
 * Reset the spawn counter to zero. Test seam — production code never
 * calls this. Tests that exercise the counter MUST reset it in
 * `beforeEach` so test order doesn't bleed across cases.
 */
export function resetSpawnCount() {
  _spawnCount = 0;
}

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
 * Render a `gh` failure as one operator-legible line: the error message plus
 * the reason `gh` itself printed.
 *
 * Every `GhExecError` carries the captured `stderr`, but the classified
 * message keeps only the exit status — so a caller that logs `err.message`
 * alone flattens every unclassified failure to `gh-exec: gh exited with code
 * 1`. That is exactly what hid an HTTP 422 `description is too long` behind
 * three identical "label ensure failed" warnings (Story #5201). `gh` prints
 * the actionable sentence on the *last* stderr line — the leading lines are
 * the `HTTP 422:` banner and the API URL — so that line is what is appended.
 *
 * Non-`GhExecError` inputs (a plain `Error` from a provider fake, a thrown
 * string) degrade to their own message, so this is safe on any catch path.
 *
 * @param {unknown} err
 * @returns {string} `"<message>: <gh stderr detail>"`, or just the message
 *   when no stderr was captured.
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
/**
 * Ordered rule table for `classify`. The first row whose `test(haystack)`
 * is truthy wins. Pulling these out of the function body collapses
 * `classify` from a giant if/else chain (cc ≈ 4 with many condition
 * literals → CRAP 22) to a simple find-then-construct (cc = 2).
 *
 * @type {Array<{
 *   test: (h: string) => boolean,
 *   build: (details: object) => Error,
 * }>}
 */
// Per-category combined regexes. Alternation keeps each pattern at cc=1
// (regex literals don't carry control-flow weight) so `classify`'s
// dispatch loop stays well under the CRAP=20 ceiling for the file.
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
  // If spawnError is present we skip the not-installed text heuristics so
  // callers can distinguish "binary missing" from "binary present, refused".
  const startIdx = spawnError ? 1 : 0;
  for (let i = startIdx; i < CLASSIFY_RULES.length; i += 1) {
    if (CLASSIFY_RULES[i].pattern.test(haystack))
      return CLASSIFY_RULES[i].build(details);
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
      // Throw-away spawn-count instrumentation (Story #1795). Counted
      // before the spawnImpl call so an immediate-throw spawnError still
      // reflects in the total — the measurement we care about is "did we
      // attempt to launch gh", not "did gh exit cleanly".
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

/* ---------------------------------------------------------------------- */
/* Typed convenience wrappers (Task #1370)                                 */
/* ---------------------------------------------------------------------- */

/**
 * Build a typed `gh` facade bound to a specific `exec` implementation. The
 * factory exists so tests can inject a fake `exec` (which itself wraps a fake
 * `spawn`) and assert the argv shape each wrapper produces. Production code
 * just imports the pre-bound `gh` singleton.
 *
 * The wrappers are deliberately thin: each one builds the argv array,
 * delegates to `exec`, and returns the parsed result. The only logic worth
 * naming lives in `gh.api`, which translates the structured
 * `{ method, endpoint, body, fields, paginate }` shape into the right
 * `-X / -f / --paginate / --input -` flag combination.
 *
 * @param {Function} execImpl — exec implementation. Defaults to module exec.
 * @param {object} [defaultExecOpts] — Default exec options spread into every
 *   wrapper's invocation (e.g. `{ timeoutMs: 60_000 }`). Per-call options
 *   override the defaults via spread order. Story #2860.
 */
export function createGh(execImpl = exec, defaultExecOpts = {}) {
  // Wrap execImpl so every wrapper inherits defaultExecOpts (e.g. timeoutMs)
  // without having to thread the option through each callsite. Per-call opts
  // win because they spread after the defaults. Story #2860.
  const execWithDefaults = (opts) => execImpl({ ...defaultExecOpts, ...opts });
  /**
   * `gh api` wrapper.
   *
   * @param {object} opts
   * @param {string} [opts.method='GET']  HTTP method (passed as -X <method>).
   * @param {string} opts.endpoint        e.g. '/repos/{owner}/{repo}/issues'.
   * @param {object} [opts.body]          JSON body — written to stdin via --input -.
   * @param {string[]} [opts.fields]      For graphql-style --jq field projection;
   *                                       passed as repeated --jq is not what callers
   *                                       want, so we currently surface it as
   *                                       `--jq .${fields.join(',.')}` only when
   *                                       set. Most callers will leave it unset
   *                                       and pass `endpoint` directly.
   * @param {boolean} [opts.paginate]     Add --paginate for list endpoints.
   * @param {object}  [opts.execOpts]     Forwarded to exec (timeoutMs, etc.).
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

  /**
   * Build a `--json a,b,c` flag pair from a fields array. Returns `[]` when
   * fields is unset so callers can spread without branching.
   */
  function jsonFlag(fields) {
    if (!Array.isArray(fields) || fields.length === 0) return [];
    return ['--json', fields.join(',')];
  }

  /**
   * Coerce numeric ids to strings — gh accepts both but tests assert on
   * stringly args.
   */
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
    /**
     * Bring a `mergeStateStatus: BEHIND` PR up to date with its base
     * (Story #4543). The close-and-land merge wait calls this a bounded
     * number of times rather than waiting out its budget behind a base it
     * could have caught up to.
     */
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

  // Expose the resolved defaults so callers (and tests) can introspect what
  // ceiling the facade enforces. Frozen to discourage post-construction
  // mutation. Story #2860.
  const defaults = Object.freeze({ ...defaultExecOpts });
  return { api, issue, pr, label, repo, defaults };
}

/**
 * Module-level singleton bound to the real `exec`. Production callers
 * import this; tests reach for `createGh(fakeExec)` instead.
 */
export const gh = createGh();

/* ---------------------------------------------------------------------- */
/* GraphQL reachability preflight (Story #5355)                            */
/* ---------------------------------------------------------------------- */

/**
 * The `gh pr` subcommands the facade above reaches GitHub's pull-request
 * surface through. `gh` routes **every one of them** through GitHub's
 * GraphQL API, so they stand or fall together: where GraphQL answers HTTP
 * 403 there is no PR operation left to attempt, not a degraded subset.
 *
 * Kept beside the `pr` facade it enumerates, and module-private, so the
 * refusal text below cannot drift from the surface it claims to describe.
 */
const GH_PR_SUBCOMMANDS = Object.freeze([
  'view',
  'create',
  'edit',
  'merge',
  'update-branch',
  'list',
]);

/**
 * The cheapest authenticated GraphQL read there is — "who am I". It touches
 * no repository, needs no scope beyond the one `gh` already has, and costs a
 * single API read, which is the whole budget the preflight is allowed.
 */
const GRAPHQL_PROBE_QUERY = 'query{viewer{login}}';

/** Wall-clock ceiling for the probe. A hung probe must never hold a close. */
const GRAPHQL_PROBE_TIMEOUT_MS = 15_000;

/**
 * Classify a failed probe into one of the two refusing verdicts, or back to
 * `available` when the failure says nothing about GraphQL reachability.
 *
 * The fall-through is deliberate and it is **fail-open**: a timeout, a DNS
 * blip or a novel `gh` error is not evidence that this session cannot reach
 * GraphQL, and blocking a healthy close on an ambiguous probe would trade a
 * rare late failure for a common early one. Such a probe reports `available`
 * with `reason: 'probe-inconclusive'`, so the log still shows it happened.
 *
 * @param {unknown} err The rejection `gh.api` produced.
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
  if (/http 403|403 forbidden/.test(haystack))
    return { verdict: 'unavailable', reason: 'http-403' };
  return { verdict: 'available', reason: 'probe-inconclusive' };
}

/**
 * Probe whether GitHub's GraphQL API is reachable from this session.
 *
 * One `gh api graphql` read, three verdicts:
 *
 *   - `available`    — GraphQL answered (or the probe failed in a way that
 *                      says nothing about reachability; see the fail-open
 *                      note on {@link classifyGraphqlProbeFailure}).
 *   - `unavailable`  — GraphQL answered HTTP 403. This is the Claude Code
 *                      web-session shape: the token is fine, the endpoint
 *                      is simply not reachable from here, so the entire
 *                      `gh pr` surface is gated.
 *   - `auth-failed`  — `gh` has no usable token (missing, expired or
 *                      under-scoped). A different fault with a different
 *                      remedy, deliberately NOT flattened into the one
 *                      above: telling an unauthenticated operator to "run
 *                      this somewhere else" sends them to reproduce it.
 *
 * Never throws — a preflight that can fail a close is worse than no
 * preflight at all.
 *
 * @param {{ ghFacade?: { api: Function } }} [opts]
 *   `ghFacade` is the injection seam; production passes nothing.
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
 * Render a refusing probe verdict as the operator-facing blocker.
 *
 * The two refusals get two messages because they have two remedies. The
 * unavailable text names all three things the operator needs — that GraphQL
 * is unavailable *in this session*, the whole `gh pr` surface that gates, and
 * that the fix is to run the close from a local session rather than to retry
 * here.
 *
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
