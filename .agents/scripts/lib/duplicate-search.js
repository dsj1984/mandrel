/**
 * duplicate-search.js — Cross-Story Duplicate Detection
 *
 * Used by `/plan` to surface open Stories whose scope overlaps with a
 * seed / seed-file / tickets corpus before new Stories are created.
 * Returns ranked candidates with an overlap score and URL so the host
 * LLM can pause for HITL confirmation.
 *
 * Design notes:
 *  - The provider abstraction (`listIssuesByLabel` for `type::story`) is
 *    the only I/O surface; the scoring routine is pure and trivially
 *    testable in isolation.
 *  - Scoring is intentionally simple (token Jaccard over title + body).
 *    It is a triage signal, not a semantic-search replacement.
 *  - Provider errors propagate verbatim — the caller is responsible
 *    for translating them into a friction comment or operator-visible
 *    failure.
 */

import { TYPE_LABELS } from './label-constants.js';

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
 * Build the issue URL for an id. The candidate exposes the URL so the
 * HITL pause can render clickable links without a second round-trip.
 *
 * @param {number|string} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildIssueUrl(id, opts = {}) {
  const owner = opts.owner || process.env.GITHUB_OWNER;
  const repo = opts.repo || process.env.GITHUB_REPO;
  if (owner && repo) {
    return `https://github.com/${owner}/${repo}/issues/${id}`;
  }
  return `#${id}`;
}

/**
 * Rank a pre-fetched open-Story list against a seed corpus.
 * Pure helper shared by the provider-backed search and tests.
 *
 * @param {{
 *   seed: string,
 *   openStories: Array<{ id:number, title?:string, body?:string, url?:string }>,
 *   minScore?: number,
 *   maxResults?: number,
 *   owner?: string,
 *   repo?: string,
 *   excludeIds?: Iterable<number|string>,
 * }} args
 * @returns {Array<{ id: number, title: string, score: number, url: string }>}
 */
export function rankOpenStoryDuplicates({
  seed,
  openStories,
  minScore = DEFAULT_MIN_SCORE,
  maxResults = DEFAULT_MAX_RESULTS,
  owner,
  repo,
  excludeIds = [],
}) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('rankOpenStoryDuplicates: seed must be a non-empty string');
  }
  if (!Array.isArray(openStories)) {
    throw new Error('rankOpenStoryDuplicates: openStories must be an array');
  }

  const seedTokens = tokenize(seed);
  if (seedTokens.size === 0) return [];

  const excluded = new Set(
    [...excludeIds].map((id) => Number(id)).filter((n) => Number.isFinite(n)),
  );

  const ranked = [];
  for (const story of openStories) {
    const id = Number(story?.id ?? story?.number);
    if (!Number.isFinite(id) || excluded.has(id)) continue;
    const title = story.title || '';
    const corpus = `${title}\n${story.body || ''}`;
    const candidateTokens = tokenize(corpus);
    const score = overlapScore(seedTokens, candidateTokens);
    if (score >= minScore) {
      ranked.push({
        id,
        title,
        score: Number(score.toFixed(4)),
        url: story.url || buildIssueUrl(id, { owner, repo }),
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

/**
 * Fetch open Stories via the ticketing provider.
 *
 * @param {object} provider
 * @returns {Promise<Array<{ id:number, title:string, body:string, url?:string }>>}
 */
async function fetchOpenStories(provider) {
  if (!provider || typeof provider.listIssuesByLabel !== 'function') {
    throw new Error(
      'findSimilarOpenStories: provider must implement listIssuesByLabel()',
    );
  }
  const issues = await provider.listIssuesByLabel({
    state: 'open',
    labels: TYPE_LABELS.STORY,
  });
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => ({
    id: Number(issue.number ?? issue.id),
    title: issue.title ?? '',
    body: issue.body ?? '',
    url: issue.html_url ?? issue.url ?? undefined,
  }));
}

/**
 * Find open Stories whose title + body overlap with the supplied seed
 * above a configurable threshold.
 *
 * @param {{
 *   seed: string,
 *   provider: import('./ITicketingProvider.js').ITicketingProvider,
 *   minScore?: number,
 *   maxResults?: number,
 *   owner?: string,
 *   repo?: string,
 *   excludeIds?: Iterable<number|string>,
 * }} args
 * @returns {Promise<Array<{ id: number, title: string, score: number, url: string }>>}
 */
export async function findSimilarOpenStories({
  seed,
  provider,
  minScore = DEFAULT_MIN_SCORE,
  maxResults = DEFAULT_MAX_RESULTS,
  owner,
  repo,
  excludeIds = [],
}) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('findSimilarOpenStories: seed must be a non-empty string');
  }

  const openStories = await fetchOpenStories(provider);
  return rankOpenStoryDuplicates({
    seed,
    openStories,
    minScore,
    maxResults,
    owner,
    repo,
    excludeIds,
  });
}

export const __test = {
  STOPWORDS,
  DEFAULT_MIN_SCORE,
  DEFAULT_MAX_RESULTS,
  buildIssueUrl,
  buildEpicUrl: buildIssueUrl,
};
