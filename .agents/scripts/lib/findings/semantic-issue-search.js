/**
 * lib/findings/semantic-issue-search.js — meaning-first candidate search that
 * widens the pool `route-finding.js` confirms, catching drifted fingerprints.
 * Ports are injected.
 */

const DEFAULT_LIMIT = 25;

/**
 * Headroom under GitHub Search's 256-char limit for appended qualifiers.
 */
const DEFAULT_QUERY_BUDGET = 200;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normaliseText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  return new Set(
    normaliseText(text)
      .split(' ')
      .filter((t) => t.length >= 2),
  );
}

/**
 * 0 when either set is empty, so an empty query never matches.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} similarity in [0, 1]
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Only the basename carries signal; the full path would waste query budget.
 * @param {unknown} value
 * @returns {string}
 */
function basename(value) {
  const str = String(value ?? '');
  const cut = str.split(/[\\/]/).filter(Boolean);
  return cut.length > 0 ? cut[cut.length - 1] : '';
}

/**
 * Title, area, file basename — highest signal first, cut to `budget` on a
 * token boundary.
 * @param {object} finding
 * @param {object} [options]
 * @param {number} [options.budget] — max query length in characters.
 * @returns {string}
 */
export function buildQuery(finding, { budget = DEFAULT_QUERY_BUDGET } = {}) {
  const tokens = [finding?.title, finding?.area, basename(finding?.primaryFile)]
    .map((v) => normaliseText(v))
    .filter((v) => v.length > 0)
    .join(' ')
    .split(' ')
    .filter(Boolean);

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

/**
 * Title overlap dominates so a verbose body cannot drown a precise title.
 * @param {Set<string>} queryTokens
 * @param {{ title?: string, body?: string }} issue
 * @returns {number} relevance score in [0, 1]
 */
function scoreIssue(queryTokens, issue) {
  const titleScore = jaccard(queryTokens, tokenize(issue?.title));
  const bodyScore = jaccard(queryTokens, tokenize(issue?.body));
  return titleScore * 0.75 + bodyScore * 0.25;
}

/**
 * @param {Array<{ number?: number }>} issues
 * @returns {Array<object>}
 */
function dedupeByNumber(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const number = issue?.number;
    if (typeof number !== 'number' || seen.has(number)) continue;
    seen.add(number);
    out.push(issue);
  }
  return out;
}

/**
 * Candidates scored locally by token overlap, best-first.
 *
 * @param {object} finding
 * @param {object} ports
 * @param {(query: string) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} ports.search
 * @param {(epicId: number) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.listEpicSubIssues]
 * @param {object} [options]
 * @param {number|null} [options.epicId]
 * @param {number} [options.limit]
 * @param {number} [options.minScore]
 * @returns {Promise<Array<{ number: number, state: string, title?: string, body?: string, score: number }>>}
 */
export async function searchSemanticCandidates(
  finding,
  ports = {},
  options = {},
) {
  const { search, listEpicSubIssues } = ports;
  if (typeof search !== 'function') {
    throw new Error('searchSemanticCandidates: search port is required');
  }

  const { epicId = null, limit = DEFAULT_LIMIT, minScore = 0 } = options;

  const query = buildQuery(finding);
  const queryTokens = tokenize(query);

  const pool = [];

  const searchHits = await search(query);
  if (Array.isArray(searchHits)) pool.push(...searchHits);

  if (epicId != null && typeof listEpicSubIssues === 'function') {
    const subIssues = await listEpicSubIssues(epicId);
    if (Array.isArray(subIssues)) pool.push(...subIssues);
  }

  const candidates = dedupeByNumber(pool).filter(
    (issue) =>
      issue &&
      typeof issue.number === 'number' &&
      typeof issue.state === 'string',
  );

  return candidates
    .map((issue) => ({ ...issue, score: scoreIssue(queryTokens, issue) }))
    .filter((issue) => issue.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const __testing = { tokenize, jaccard, scoreIssue, dedupeByNumber };
