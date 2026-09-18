/**
 * GitHub Provider — bounds a composed `/search/issues` query. Search answers
 * a `q` over 256 chars with a non-transient 422 that would abort a scan.
 */

const GITHUB_SEARCH_MAX_QUERY = 256;

/**
 * Truncate the free text on a whole-token boundary to fit `max`. Qualifiers
 * are the scope and are never dropped, even if they alone exceed `max`.
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

  const reserve = quals.length + (quals.length > 0 ? 1 : 0);
  const budget = max - reserve;
  const bounded = fitTokens(free.split(/\s+/).filter(Boolean), budget);
  return bounded.length > 0 ? `${bounded} ${quals}`.trim() : quals;
}

/**
 * Leading tokens that fit `budget`; '' when even the first doesn't.
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
