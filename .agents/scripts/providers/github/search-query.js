/**
 * GitHub Provider — composed `/search/issues` query bound (Story #4678).
 *
 * `IssuesGateway#searchIssues` is the only place that knows the *composed* `q`
 * — the caller's free text plus the `repo:<owner>/<repo> type:issue` qualifiers
 * it appends. GitHub Search rejects a query over 256 characters with HTTP 422,
 * which is neither transient nor caught, so an over-long title over a deep path
 * would abort the whole scan. This module owns the defensive guard: it truncates
 * the free-text portion on a whole-token boundary until the composed `q` fits.
 *
 * Pure and unit-testable — no I/O.
 */

/**
 * GitHub Search's documented maximum query length, in characters. Module-private
 * — `composeBoundedQuery` is the only supported way to apply it, so the bound
 * cannot drift between call sites.
 */
const GITHUB_SEARCH_MAX_QUERY = 256;

/**
 * Compose a `/search/issues` query from free text plus fixed qualifiers,
 * truncating the free-text portion on a whole-token boundary so the whole
 * composed string is at most `max` characters. Qualifiers are never dropped —
 * they are the load-bearing scope (`repo:` / `type:`) — so when even the
 * qualifiers alone exceed the budget the qualifier string is returned as-is.
 *
 * @param {string} freeText — the caller's free-text search term(s).
 * @param {string[]} qualifiers — fixed qualifier tokens (e.g. `repo:o/r`).
 * @param {number} [max] — character ceiling for the composed query.
 * @returns {string} the composed query, at most `max` characters.
 */
export function composeBoundedQuery(
  freeText,
  qualifiers,
  max = GITHUB_SEARCH_MAX_QUERY,
) {
  const quals = qualifiers.join(' ');
  const free = String(freeText ?? '').trim();
  const full = `${free} ${quals}`.trim();
  if (full.length <= max) return full;

  // Reserve space for the qualifiers (and the joining space) and fit as many
  // leading free-text tokens as the remaining budget allows.
  const reserve = quals.length + (quals.length > 0 ? 1 : 0);
  const budget = max - reserve;
  const bounded = fitTokens(free.split(/\s+/).filter(Boolean), budget);
  return bounded.length > 0 ? `${bounded} ${quals}`.trim() : quals;
}

/**
 * Join as many leading `tokens` as fit within `budget` characters, on a
 * whole-token boundary (space-separated). Returns '' when the budget cannot fit
 * even the first token. Module-private — exercised through
 * {@link composeBoundedQuery}, the only caller.
 *
 * @param {string[]} tokens
 * @param {number} budget
 * @returns {string}
 */
function fitTokens(tokens, budget) {
  const kept = [];
  let length = 0;
  for (const token of tokens) {
    const cost = kept.length === 0 ? token.length : token.length + 1;
    if (length + cost > budget) break;
    kept.push(token);
    length += cost;
  }
  return kept.join(' ');
}
