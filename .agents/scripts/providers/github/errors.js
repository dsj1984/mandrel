/**
 * GitHub Provider — error classifier + sub-issues GraphQL shape.
 *
 * `classifyGithubError` buckets `gh-exec`-thrown errors into 4 categories
 * (`feature-disabled` / `permission` / `transient` / `permanent`) so the
 * sub-issues fallback and the shared retry loop have a deterministic
 * switch. Rate-limit detection wins over the 401/403 → permission rule
 * because GitHub's secondary rate limit is delivered as HTTP 403 with a
 * known message; if we bucketed it as 'permission' it would never be
 * retried.
 *
 * `SUB_ISSUES_QUERY` is the GraphQL shape the sub-issues read path uses.
 * Story #5008 removed the add/remove mutations with the write surface.
 *
 * Extracted from `../github.js` in Story #1846 / Task #1857.
 */

/**
 * Needles that mean "this API surface does not exist here", not "this call
 * failed". Every one names a *schema* fact — an absent GraphQL field, a
 * disabled feature — so a match is a settled answer no retry can improve.
 *
 * The bare `sub-issues` needle used to sit in this list and had to go: it
 * matches the endpoint's own name, so any error that merely *mentions* the
 * surface classified as `feature-disabled`. A secondary rate limit delivered
 * as `HTTP 403: API rate limit exceeded while fetching sub-issues` is the live
 * case — genuinely transient, but bucketed here it bypassed
 * `withTransientRetry` entirely and the Epic rollup read the burst as "this
 * repo has no sub-issues", degrading to the body checklist on a read that
 * would have succeeded a second later. The narrower `subissues` spellings
 * below still catch the real schema errors, because GraphQL names the field
 * without the hyphen.
 */
const FEATURE_DISABLED_MESSAGES = [
  'feature not available',
  'feature is not enabled',
  "field 'subissues'",
  'field "subissues"',
  'subissues is not available',
  // The field, never the endpoint. `<x> field` cannot appear in "while
  // fetching sub-issues", which is what makes these safe to keep after the
  // bare needle's removal.
  'subissues field',
  'sub_issues field',
  'sub-issues field',
  "doesn't exist on type",
  'does not exist on type',
  'unknown field',
];

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
]);

const TRANSIENT_MESSAGES = [
  'rate limit',
  'secondary rate limit',
  'abuse detection',
  'fetch failed',
  'network',
  'timeout',
  'timed out',
  'aborted',
];

const PERMISSION_MESSAGES = ['unauthorized', 'forbidden', 'permission'];

// Network/connectivity blips that the gh-CLI path surfaces on `err.stderr`
// (Go HTTP errors, e.g. `dial tcp ...: i/o timeout`) and the direct `fetch`
// path surfaces as `TypeError: fetch failed` with the real reason on
// `err.cause` (e.g. `ETIMEDOUT`, `ENOTFOUND`). Folded in from the former
// `transient-retry.js` predicate (Story #4298) so the single canonical
// classifier retries the **union** of transient HTTP statuses/codes AND
// transient network errors. The `\b50[234]\b` alternative also catches a
// bare 502/503/504 surfaced only in an error message string (no `.status`).
const TRANSIENT_NETWORK_RE =
  /i\/o timeout|dial tcp|TLS handshake timeout|connection reset|connection refused|temporary failure|could not resolve host|no such host|network is unreachable|socket hang up|fetch failed|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\b50[234]\b/i;

/**
 * True when an error looks like a retryable network/connectivity blip.
 * Scans the union of fields both transport paths populate (`stderr`,
 * `message`, `code`, and the nested `cause.message` / `cause.code` the
 * `fetch` path uses). Module-private — folded in from the former
 * `transient-retry.js` predicate (Story #4298) and consumed only by
 * `classifyGithubError` below; its behavior is exercised through that public
 * classifier rather than as a standalone export (keeps the dead-export gate
 * green — nothing outside this module imports it).
 */
function isTransientNetworkError(err) {
  const hay = [
    err?.stderr,
    err?.message,
    err?.code,
    err?.cause?.message,
    err?.cause?.code,
  ]
    .filter(Boolean)
    .join(' ');
  return TRANSIENT_NETWORK_RE.test(hay);
}

function matchesAny(haystack, needles) {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

/** `gh` renders the HTTP status onto stderr as `HTTP 403: <reason>`. */
const GH_STDERR_STATUS_RE = /\bHTTP (\d{3})\b/i;

/**
 * The captured `gh` stderr, or `''` when the error carries none.
 *
 * Its own function so {@link extractErrorFields} keeps the cyclomatic weight it
 * had before stderr became a classification input — the field is read twice
 * there, and inlining the guard twice is what pushed the CRAP ratchet.
 *
 * @param {unknown} err
 * @returns {string}
 */
function stderrText(err) {
  return typeof err?.stderr === 'string' ? err.stderr : '';
}

/**
 * Recover the HTTP status from a `gh`-CLI failure's stderr.
 *
 * The `fetch` transport sets `err.status`; the `gh` transport does not — it
 * has only an exit code, and puts the status in the text it printed. Without
 * this, every `gh`-path failure reached the status rules as `undefined` and a
 * 403 or a 429 was indistinguishable from an unclassifiable error (Story
 * #5210).
 *
 * @param {unknown} stderr
 * @returns {number|undefined}
 */
function statusFromStderr(stderr) {
  if (typeof stderr !== 'string') return undefined;
  const m = GH_STDERR_STATUS_RE.exec(stderr);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/**
 * Extract `{ lower, detail, status, code }` from an error in the shape
 * `gh-exec` throws. Pure — exported style for unit-testability without
 * instantiating the provider. Defensive on shape: errors arrive as `Error`
 * objects, plain `{message,status,code}` bags, or non-Errors stringified into
 * `String(err)`.
 *
 * `lower` is the message alone. `detail` is the message **plus** any captured
 * `stderr`, and is what the keyword rules read: on the `gh` path the message
 * is the classified summary (`gh-exec: gh exited with code 1`) and every
 * actionable word — the status line, `secondary rate limit`, the missing
 * GraphQL field — lives only on stderr. Matching the keyword lists against the
 * message alone is what flattened a retryable 403 to `permanent` and let the
 * Epic rollup treat a rate-limit burst as a settled answer (Story #5210).
 */
export function extractErrorFields(err) {
  const message = typeof err.message === 'string' ? err.message : String(err);
  const stderr = stderrText(err);
  const lower = message.toLowerCase();
  return {
    lower,
    // Unconditional concatenation: with no stderr this is the message plus a
    // trailing space, which every `includes` rule below reads identically.
    detail: `${lower} ${stderr.toLowerCase()}`,
    status:
      typeof err.status === 'number' ? err.status : statusFromStderr(stderr),
    code: typeof err.code === 'string' ? err.code : undefined,
  };
}

/** Pure predicate: HTTP status that signals "transient — retry-eligible". */
export function isTransientStatus(status) {
  if (status === 429) return true;
  return typeof status === 'number' && status >= 500;
}

/** Pure predicate: error code/message signals "transient — retry-eligible". */
export function isTransientByCodeOrMessage(code, lower) {
  if (TRANSIENT_CODES.has(code)) return true;
  return matchesAny(lower, TRANSIENT_MESSAGES);
}

/** Pure predicate: HTTP status / message signals "permission denied". */
export function isPermissionSignal(status, lower) {
  if (status === 401 || status === 403) return true;
  return matchesAny(lower, PERMISSION_MESSAGES);
}

export function classifyGithubError(err) {
  if (!err) return 'permanent';
  // `GhExecTimeoutError` (from `lib/gh-exec.js`) carries a message of the
  // shape `"gh-exec: gh <args> exceeded <N>ms"` — no transient keyword and
  // no `.status` / `.code`. Match by `err.name` to avoid a circular import
  // between this module and `lib/gh-exec.js`. Story #2860.
  if (err.name === 'GhExecTimeoutError') return 'transient';
  // Every keyword rule below reads `detail` (message + stderr), never `lower`
  // alone: the `gh` transport carries its reason exclusively on stderr, so a
  // message-only match sees nothing but the exit code. Rule ORDER is
  // load-bearing and unchanged — a secondary rate limit is delivered as HTTP
  // 403, so the transient rules must stay ahead of the permission rule or it
  // would bucket as 'permission' and never retry.
  const { detail, status, code } = extractErrorFields(err);
  if (matchesAny(detail, FEATURE_DISABLED_MESSAGES)) return 'feature-disabled';
  if (isTransientStatus(status)) return 'transient';
  if (isTransientByCodeOrMessage(code, detail)) return 'transient';
  // Union with the former `transient-retry.js` predicate (Story #4298):
  // retry on network/connectivity blips the status/code checks above miss
  // (e.g. a `dial tcp ... i/o timeout` on `err.stderr` from the gh-CLI path,
  // or `ECONNREFUSED` / `ENETUNREACH`). Checked before the permission rule so
  // a transient network failure never masquerades as a permanent denial.
  if (isTransientNetworkError(err)) return 'transient';
  if (isPermissionSignal(status, detail)) return 'permission';
  return 'permanent';
}

// ---------------------------------------------------------------------------
// Transient-retry helper (Story #2852; unified in Story #4298)
// ---------------------------------------------------------------------------
//
// The single canonical `withTransientRetry` for the GitHub provider. Story
// #4298 collapsed the former two divergent same-named implementations (this
// one + the network-only one in the deleted `transient-retry.js`) into this
// one primitive. Its default classifier (`classifyGithubError`) is the
// **union** predicate — it retries on transient HTTP statuses/codes AND on
// transient network/connectivity errors — so every former consumer of either
// module keeps (or gains) its prior retry coverage with no shim.
//
// Read-path callers (paginateRest, getTicket, getNativeSubIssues, …) all
// absorb the same jittered exponential backoff on transient GitHub errors
// through this one primitive, instead of bubbling a one-shot
// 502/429/ECONNRESET that kills a longer pipeline (e.g. the /mandrel-deliver
// Phase E retro). The network consumers repointed here
// (branch-protection, labels, projects-v2-graphql) call with no opts, so
// they adopt these defaults; their retry *classes* (the network blips) are
// preserved via the unified classifier above.

export const TRANSIENT_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 6,
  baseDelayMs: 500,
  capMs: 30_000,
  jitterMs: 500,
});

/**
 * Run `fn` with jittered exponential backoff on transient GitHub errors.
 * `classify` (defaults to `classifyGithubError`) decides whether each
 * failure is retry-eligible: only `'transient'` retries; every other
 * bucket (`feature-disabled` / `permission` / `permanent`) bubbles on the
 * first failure.
 *
 * `sleep` and `random` are injectable so tests can drive deterministic
 * retry paths without real-world timing.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   capMs?: number,
 *   jitterMs?: number,
 *   classify?: (err: unknown) => string,
 *   label?: string,
 *   onRetry?: (info: {
 *     attempt: number,
 *     maxAttempts: number,
 *     delay: number,
 *     err: unknown,
 *     label: string,
 *   }) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(fn, opts = {}) {
  const {
    maxAttempts = TRANSIENT_RETRY_DEFAULTS.maxAttempts,
    baseDelayMs = TRANSIENT_RETRY_DEFAULTS.baseDelayMs,
    capMs = TRANSIENT_RETRY_DEFAULTS.capMs,
    jitterMs = TRANSIENT_RETRY_DEFAULTS.jitterMs,
    classify = classifyGithubError,
    label = 'gh-api',
    onRetry,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const category = classify(err);
      const isFinal = attempt === maxAttempts - 1;
      if (category !== 'transient' || isFinal) throw err;
      const base = Math.min(capMs, baseDelayMs * 2 ** attempt);
      const delay = base + Math.floor(random() * jitterMs);
      if (typeof onRetry === 'function') {
        onRetry({ attempt: attempt + 1, maxAttempts, delay, err, label });
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Sub-issues GraphQL shapes
// ---------------------------------------------------------------------------
export const SUB_ISSUES_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue {
      subIssues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          databaseId
          id
          title
          body
          state
          labels(first: 30) { nodes { name } }
          assignees(first: 20) { nodes { login } }
        }
      }
    }
  }
}`;
