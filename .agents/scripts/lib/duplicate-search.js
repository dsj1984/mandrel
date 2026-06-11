/**
 * duplicate-search.js — Cross-Epic Duplicate Detection
 *
 * Used by `/plan` Phase 2 (s-plan-ideation) to surface open Epics
 * whose scope overlaps with a sharpened one-pager before a new Epic is
 * created. Returns ranked candidates with an overlap score and URL so
 * the host LLM can pause for HITL confirmation.
 *
 * Design notes:
 *  - The provider abstraction (`ITicketingProvider#getEpics`) is the
 *    only I/O surface; the scoring routine is pure and trivially
 *    testable in isolation.
 *  - Scoring is intentionally simple (token Jaccard over title +
 *    structured one-pager sections). It is a triage signal, not a
 *    semantic-search replacement.
 *  - Provider errors propagate verbatim — the caller is responsible
 *    for translating them into a friction comment or operator-visible
 *    failure.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'might',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'we',
  'what',
  'when',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MAX_RESULTS = 5;

/**
 * Tokenize freeform text into a deduplicated set of meaningful words.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Compute the Jaccard overlap between two token sets.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0..1
 */
export function overlapScore(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build the Epic URL for an issue id. The candidate exposes the URL so
 * the HITL pause can render clickable links without a second round-trip.
 *
 * @param {number|string} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildEpicUrl(id, opts = {}) {
  const owner = opts.owner || process.env.GITHUB_OWNER;
  const repo = opts.repo || process.env.GITHUB_REPO;
  if (owner && repo) {
    return `https://github.com/${owner}/${repo}/issues/${id}`;
  }
  return `#${id}`;
}

/**
 * Find open Epics whose title + body overlap with the supplied
 * one-pager above a configurable threshold.
 *
 * @param {{
 *   onePager: string,
 *   provider: import('./ITicketingProvider.js').ITicketingProvider,
 *   minScore?: number,
 *   maxResults?: number,
 *   owner?: string,
 *   repo?: string,
 * }} args
 * @returns {Promise<Array<{ id: number, title: string, score: number, url: string }>>}
 */
export async function findSimilarOpenEpics({
  onePager,
  provider,
  minScore = DEFAULT_MIN_SCORE,
  maxResults = DEFAULT_MAX_RESULTS,
  owner,
  repo,
}) {
  if (!onePager || typeof onePager !== 'string') {
    throw new Error(
      'findSimilarOpenEpics: onePager must be a non-empty string',
    );
  }
  if (!provider || typeof provider.getEpics !== 'function') {
    throw new Error('findSimilarOpenEpics: provider must implement getEpics()');
  }

  const seedTokens = tokenize(onePager);
  if (seedTokens.size === 0) return [];

  // Provider errors propagate verbatim — caller decides how to surface.
  const epics = await provider.getEpics({ state: 'open' });
  if (!Array.isArray(epics) || epics.length === 0) return [];

  const ranked = [];
  for (const epic of epics) {
    const corpus = `${epic.title || ''}\n${epic.body || ''}`;
    const candidateTokens = tokenize(corpus);
    const score = overlapScore(seedTokens, candidateTokens);
    if (score >= minScore) {
      ranked.push({
        id: epic.id,
        title: epic.title,
        score: Number(score.toFixed(4)),
        url: buildEpicUrl(epic.id, { owner, repo }),
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

export const __test = {
  STOPWORDS,
  DEFAULT_MIN_SCORE,
  DEFAULT_MAX_RESULTS,
  buildEpicUrl,
};
