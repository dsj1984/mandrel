/**
 * GitHub Provider — error classifier, the shared transient-retry loop, and
 * the sub-issues GraphQL shape.
 *
 * `classifyGithubError` buckets errors as `feature-disabled` / `permission` /
 * `transient` / `permanent`. Transient rules run before the 401/403
 * permission rule because a secondary rate limit arrives as HTTP 403.
 */

/**
 * Schema facts (absent field, disabled feature) no retry can change. Never
 * add a bare `sub-issues` needle: it matches the endpoint name, so a rate
 * limit "while fetching sub-issues" would skip retry; GraphQL spells the
 * field without the hyphen.
 */
const FEATURE_DISABLED_MESSAGES = [
  'feature not available',
  'feature is not enabled',
  "field 'subissues'",
  'field "subissues"',
  'subissues is not available',
  // `<x> field` names the field, never the endpoint.
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

// Connectivity blips: gh-CLI puts Go HTTP errors on stderr; `fetch` puts the
// reason on `err.cause`. `\b50[234]\b` catches a status present only in text.
const TRANSIENT_NETWORK_RE =
  /i\/o timeout|dial tcp|TLS handshake timeout|connection reset|connection refused|temporary failure|could not resolve host|no such host|network is unreachable|socket hang up|fetch failed|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\b50[234]\b/i;

/** Scans stderr, message, code and `cause.*` from both transport paths. */
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
 * Separate function to keep {@link extractErrorFields}'s complexity down.
 *
 * @param {unknown} err
 * @returns {string}
 */
function stderrText(err) {
  return typeof err?.stderr === 'string' ? err.stderr : '';
}

/**
 * The `gh` transport has no `err.status`, only the status printed on stderr.
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
 * Pure. `detail` is message + stderr and is what keyword rules must read: on
 * the `gh` path the message is only `gh exited with code 1` and every
 * actionable word (status, rate limit, missing field) lives on stderr.
 */
export function extractErrorFields(err) {
  const message = typeof err.message === 'string' ? err.message : String(err);
  const stderr = stderrText(err);
  const lower = message.toLowerCase();
  return {
    lower,
    detail: `${lower} ${stderr.toLowerCase()}`,
    status:
      typeof err.status === 'number' ? err.status : statusFromStderr(stderr),
    code: typeof err.code === 'string' ? err.code : undefined,
  };
}

export function isTransientStatus(status) {
  if (status === 429) return true;
  return typeof status === 'number' && status >= 500;
}

export function isTransientByCodeOrMessage(code, lower) {
  if (TRANSIENT_CODES.has(code)) return true;
  return matchesAny(lower, TRANSIENT_MESSAGES);
}

export function isPermissionSignal(status, lower) {
  if (status === 401 || status === 403) return true;
  return matchesAny(lower, PERMISSION_MESSAGES);
}

export function classifyGithubError(err) {
  if (!err) return 'permanent';
  // Matched by name to avoid a circular import with `lib/gh-exec.js`.
  if (err.name === 'GhExecTimeoutError') return 'transient';
  // Rule order is load-bearing: every transient rule precedes permission.
  const { detail, status, code } = extractErrorFields(err);
  if (matchesAny(detail, FEATURE_DISABLED_MESSAGES)) return 'feature-disabled';
  if (isTransientStatus(status)) return 'transient';
  if (isTransientByCodeOrMessage(code, detail)) return 'transient';
  if (isTransientNetworkError(err)) return 'transient';
  if (isPermissionSignal(status, detail)) return 'permission';
  return 'permanent';
}

export const TRANSIENT_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 6,
  baseDelayMs: 500,
  capMs: 30_000,
  jitterMs: 500,
});

/**
 * The provider's single retry primitive: jittered exponential backoff; only
 * a `'transient'` classification retries, anything else throws at once.
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
