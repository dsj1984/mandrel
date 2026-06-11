/**
 * GitHub Provider — error classifier + sub-issues GraphQL shapes.
 *
 * `classifyGithubError` buckets `gh-exec`-thrown errors into 4 categories
 * (`feature-disabled` / `permission` / `transient` / `permanent`) so the
 * sub-issues fallback and the addSubIssue retry loop have a deterministic
 * switch. Rate-limit detection wins over the 401/403 → permission rule
 * because GitHub's secondary rate limit is delivered as HTTP 403 with a
 * known message; if we bucketed it as 'permission' it would never be
 * retried.
 *
 * `SUB_ISSUES_QUERY` / `ADD_SUB_ISSUE_MUTATION` / `REMOVE_SUB_ISSUE_MUTATION`
 * are the three GraphQL shapes the sub-issues feature reads/writes.
 *
 * Extracted from `../github.js` in Story #1846 / Task #1857.
 */

const FEATURE_DISABLED_MESSAGES = [
  'feature not available',
  'feature is not enabled',
  "field 'subissues'",
  'field "subissues"',
  'subissues is not available',
  'sub-issues',
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

function matchesAny(haystack, needles) {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

/**
 * Extract `{ lower, status, code }` from an error in the shape `gh-exec`
 * throws. Pure — exported style for unit-testability without instantiating
 * the provider. Defensive on shape: errors arrive as `Error` objects, plain
 * `{message,status,code}` bags, or non-Errors stringified into `String(err)`.
 */
export function extractErrorFields(err) {
  const message = typeof err.message === 'string' ? err.message : String(err);
  return {
    lower: message.toLowerCase(),
    status: typeof err.status === 'number' ? err.status : undefined,
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
  const { lower, status, code } = extractErrorFields(err);
  if (matchesAny(lower, FEATURE_DISABLED_MESSAGES)) return 'feature-disabled';
  if (isTransientStatus(status)) return 'transient';
  if (isTransientByCodeOrMessage(code, lower)) return 'transient';
  if (isPermissionSignal(status, lower)) return 'permission';
  return 'permanent';
}

// ---------------------------------------------------------------------------
// Transient-retry helper (Story #2852)
// ---------------------------------------------------------------------------
//
// Mirrors the addSubIssue retry contract in `sub-issues.js` so read-path
// callers (paginateRest, getTicket, getNativeSubIssues, …) absorb the same
// jittered exponential backoff on transient GitHub errors instead of
// bubbling a one-shot 502/429/ECONNRESET that kills a longer pipeline
// (e.g. the /deliver Phase E retro).

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
 * first failure. The retry shape matches `addSubIssue` in
 * `sub-issues.js:119-167`.
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

export const ADD_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!, $replaceParent: Boolean) {
    addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId, replaceParent: $replaceParent }) {
      issue { number }
      subIssue { number }
    }
  }`;

export const REMOVE_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
      issue { number }
      subIssue { number }
    }
  }`;

// Story #2982 — native parent lookup for the cascade upward walk. The
// inverse of `SUB_ISSUES_QUERY`: given a child Issue node, fetch the
// `parent` field exposed by the Sub-Issues feature so `cascadeCompletion`
// can resolve a parent even when the child body lacks the `parent: #N`
// orchestrator footer.
export const PARENT_ISSUE_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Issue {
      parent {
        number
        databaseId
        id
        title
        state
      }
    }
  }
}`;
