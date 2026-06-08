/**
 * lib/findings/semantic-issue-search.js — Semantic candidate search for findings.
 *
 * Dedup has two stages. This module owns the **first** stage: a meaning-first
 * candidate search that surfaces issues likely to describe the same problem as
 * a finding, *before* the exact fingerprint confirmation in
 * `route-finding.js` runs. The fingerprint is precise but brittle — a reworded
 * title or a moved file produces a fresh sha even when the underlying problem
 * is the same. The semantic pass casts a wider net so the confirmation stage
 * has the right candidates to inspect.
 *
 * The search scans BOTH open and closed issues, and explicitly includes the
 * sub-issues of any in-scope Epic (a regression that was closed under a prior
 * Epic, or a still-open sibling Story, must be reachable). Epic sub-issues are
 * fetched through the same injected port so a closed-then-reopened problem is
 * never missed.
 *
 * Pure orchestration: no network I/O lives here. The `search` port — and the
 * optional `listEpicSubIssues` port — are injected by the caller (production
 * wires them to the GitHub provider; tests pass in-memory stubs). The unit
 * test for this module performs no network calls.
 */

const DEFAULT_LIMIT = 25;

/**
 * Normalise a free-text string for token comparison: lowercased, trimmed,
 * punctuation collapsed to spaces.
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
 * Tokenise normalised text into a Set of words, dropping very short noise
 * tokens that carry no discriminating signal.
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
 * Jaccard similarity between two token sets. Returns 0 when either set is
 * empty so an empty query never spuriously matches.
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
 * Build the search query text for a finding. The title carries the strongest
 * signal; area and primaryFile sharpen it. This is the text both the
 * (production) full-text search port and the local relevance scorer key on.
 * @param {object} finding
 * @returns {string}
 */
export function buildQuery(finding) {
  return [finding?.title, finding?.area, finding?.primaryFile]
    .map((v) => normaliseText(v))
    .filter((v) => v.length > 0)
    .join(' ');
}

/**
 * Score a candidate issue against the finding's query tokens. Title overlap
 * dominates; body overlap is a weaker secondary signal so a verbose body
 * cannot drown out a precise title match.
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
 * De-duplicate issue records by `number`, keeping the first occurrence.
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
 * Find semantically-similar candidate issues for a finding.
 *
 * The `search` port runs the host's issue search (production: GitHub
 * full-text search across open AND closed issues). When an `epicId` is in
 * scope and a `listEpicSubIssues` port is supplied, that Epic's sub-issues
 * are folded into the candidate pool so a regression closed under a prior
 * Epic — or an open sibling Story — is never missed. The pooled candidates
 * are scored locally by token overlap and returned best-first.
 *
 * @param {object} finding — canonical finding ({ title, area, primaryFile, ... }).
 * @param {object} ports
 * @param {(query: string) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} ports.search
 *   Required. Queries both open and closed issues for the finding's query text.
 * @param {(epicId: number) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.listEpicSubIssues]
 *   Optional. Lists the sub-issues of the in-scope Epic.
 * @param {object} [options]
 * @param {number|null} [options.epicId] — Epic whose sub-issues to include.
 * @param {number} [options.limit] — max candidates to return (default 25).
 * @param {number} [options.minScore] — drop candidates scoring below this
 *   (default 0; every scanned issue is a candidate).
 * @returns {Promise<Array<{ number: number, state: string, title?: string, body?: string, score: number }>>}
 *   candidates sorted by descending relevance score.
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
