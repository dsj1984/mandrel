/**
 * GitHub error classifier.
 *
 * Normalizes errors thrown by the GraphQL / REST transport into a small set of
 * categories the caller can react to deterministically.
 *
 * Categories:
 *   - `feature-disabled` — the feature isn't enabled on the repo/org (e.g. the
 *     sub-issues GraphQL API is not available). Callers typically suppress
 *     these and fall back to a legacy path.
 *   - `permission`       — 401/403 / auth or access denied.
 *   - `transient`        — rate-limit, 5xx, network / fetch / abort errors.
 *   - `permanent`        — everything else (treat as a hard error).
 *
 * @param {unknown} err
 * @returns {'feature-disabled'|'transient'|'permission'|'permanent'}
 */
export function classifyGithubError(err) {
  if (!err) return 'permanent';

  const message = typeof err.message === 'string' ? err.message : String(err);
  const lower = message.toLowerCase();
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.code === 'string' ? err.code : undefined;

  if (
    lower.includes('feature not available') ||
    lower.includes('feature is not enabled') ||
    lower.includes("field 'subissues'") ||
    lower.includes('field "subissues"') ||
    lower.includes('subissues is not available') ||
    lower.includes('sub-issues') ||
    lower.includes("doesn't exist on type") ||
    lower.includes('does not exist on type') ||
    lower.includes('unknown field')
  ) {
    return 'feature-disabled';
  }

  // Rate-limit detection wins over the 401/403 → permission rule. GitHub's
  // secondary rate limit is delivered as HTTP 403 with a known message; if we
  // bucketed it as 'permission' it would never be retried.
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return 'transient';
  }
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ABORT_ERR' ||
    lower.includes('rate limit') ||
    lower.includes('secondary rate limit') ||
    lower.includes('abuse detection') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted')
  ) {
    return 'transient';
  }

  if (status === 401 || status === 403) return 'permission';
  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('permission')
  ) {
    return 'permission';
  }

  return 'permanent';
}
