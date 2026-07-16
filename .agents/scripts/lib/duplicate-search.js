/**
 * duplicate-search.js — Cross-Story Duplicate Detection
 *
 * Used by `/plan` to surface open Stories whose scope overlaps with a
 * seed / seed-file / tickets corpus before new Stories are created.
 * Returns ranked candidates with an overlap score and URL so the host
 * LLM can pause for HITL confirmation.
 *
 * Design notes:
 *  - Prefer `provider.searchIssues` to narrow open Stories server-side
 *    (`label:"type::story" state:open` + top seed tokens), capped at
 *    ~100 hits, then rank that set. Fall back to `listIssuesByLabel`
 *    when search errors, is unavailable, or returns **nothing** (same
 *    try/catch pattern as `TicketGateway.getTickets`).
 *  - The narrowing query is deliberately weak (Story #4541). GitHub ANDs
 *    free-text terms, so the former 8-token query demanded that a candidate
 *    contain all eight of a multi-sentence seed's longest words — which no
 *    real Story does. Gate #1 duplicate triage therefore reported "no
 *    candidates" on every realistic seed while looking perfectly healthy.
 *    Search is now a cheap best-case narrowing over a handful of tokens; an
 *    empty result is treated as "search did not help", not "no duplicates",
 *    and falls through to the label listing whose Jaccard ranker has real
 *    recall.
 *  - Scoring is intentionally simple (token Jaccard over title + body).
 *    It is a triage signal, not a semantic-search replacement.
 *  - Provider errors on the list fallback propagate verbatim — the
 *    caller is responsible for translating them into a friction comment
 *    or operator-visible failure.
 */

import { Logger } from './Logger.js';
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
 * How many seed tokens to pass as free-text search terms.
 *
 * GitHub ANDs these, so the cap is a precision/recall dial pointing the
 * wrong way: every extra token shrinks the candidate set. Three is a
 * best-case narrowing that can plausibly hit on a focused seed; anything
 * beyond that reliably matched nothing on a multi-sentence one (Story
 * #4541). Recall does not rest on this number — an empty result falls back
 * to label-listing plus client-side ranking.
 */
const DEFAULT_SEARCH_TOKEN_CAP = 3;
/** Hard cap on search hits ranked client-side (~one Search API page). */
const SEARCH_RESULT_CAP = 100;

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
 * Pick the highest-signal seed tokens for a Search API free-text query.
 * Longer tokens first (specificity proxy), then alphabetical for stability.
 *
 * @param {string} seed
 * @param {number} [maxTokens]
 * @returns {string[]}
 */
export function pickSearchTokens(seed, maxTokens = DEFAULT_SEARCH_TOKEN_CAP) {
  const tokens = tokenize(seed);
  return [...tokens]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, maxTokens);
}

/**
 * Build the `/search/issues` query for open Stories overlapping a seed.
 * Repo scoping is left to `provider.searchIssues`.
 *
 * @param {string} seed
 * @returns {string}
 */
export function buildOpenStorySearchQuery(seed) {
  const tokens = pickSearchTokens(seed);
  return [`label:"${TYPE_LABELS.STORY}"`, 'state:open', ...tokens].join(' ');
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
 * Normalize a provider issue (list or search hit) into the ranking shape.
 *
 * @param {object} issue
 * @returns {{ id: number, title: string, body: string, url?: string }}
 */
function normalizeIssue(issue) {
  return {
    id: Number(issue.number ?? issue.id),
    title: issue.title ?? '',
    body: issue.body ?? '',
    url: issue.html_url ?? issue.url ?? undefined,
  };
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
 * Server-narrowed open-Story fetch via `/search/issues`.
 *
 * @param {object} provider
 * @param {string} seed
 * @returns {Promise<Array<{ id:number, title:string, body:string, url?:string }>>}
 */
async function fetchOpenStoriesViaSearch(provider, seed) {
  const query = buildOpenStorySearchQuery(seed);
  const hits = await provider.searchIssues({ query });
  if (!Array.isArray(hits)) return [];
  return hits.slice(0, SEARCH_RESULT_CAP).map(normalizeIssue);
}

/**
 * Full open-Story backlog via label listing (fallback path).
 *
 * @param {object} provider
 * @returns {Promise<Array<{ id:number, title:string, body:string, url?:string }>>}
 */
async function fetchOpenStoriesViaList(provider) {
  if (typeof provider.listIssuesByLabel !== 'function') {
    throw new Error(
      'findSimilarOpenStories: provider must implement listIssuesByLabel()',
    );
  }
  const issues = await provider.listIssuesByLabel({
    state: 'open',
    labels: TYPE_LABELS.STORY,
  });
  if (!Array.isArray(issues)) return [];
  return issues.map(normalizeIssue);
}

/**
 * Fetch open-Story candidates: try Search API narrowing first, fall back to
 * `listIssuesByLabel` when search errors, is unavailable, or **returns no
 * hits**.
 *
 * The empty-result fallback is the load-bearing one (Story #4541). The
 * narrowing query ANDs seed tokens, so on any real multi-sentence seed it
 * matches nothing — and treating that as an authoritative "no duplicates
 * exist" is what made Gate #1 triage report a clean bill of health while
 * never actually looking. An empty search is evidence about the *query*, not
 * about the backlog.
 *
 * @param {object} provider
 * @param {string} seed
 * @returns {Promise<Array<{ id:number, title:string, body:string, url?:string }>>}
 */
async function fetchOpenStoryCandidates(provider, seed) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('findSimilarOpenStories: provider is required');
  }

  const hasSearch = typeof provider.searchIssues === 'function';
  const hasList = typeof provider.listIssuesByLabel === 'function';
  if (!hasSearch && !hasList) {
    throw new Error(
      'findSimilarOpenStories: provider must implement searchIssues() or listIssuesByLabel()',
    );
  }

  if (hasSearch) {
    try {
      const hits = await fetchOpenStoriesViaSearch(provider, seed);
      if (hits.length > 0 || !hasList) return hits;
      Logger.info(
        '[duplicate-search] narrowed search matched no open Stories; ' +
          'falling back to listIssuesByLabel + client-side ranking',
      );
    } catch (err) {
      if (!hasList) throw err;
      const msg = typeof err?.message === 'string' ? err.message : String(err);
      Logger.warn(
        `[duplicate-search] search-based candidate fetch failed (${msg}); ` +
          'falling back to listIssuesByLabel',
      );
    }
  }

  return fetchOpenStoriesViaList(provider);
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

  // Avoid a network round-trip when the seed cannot produce a score.
  if (tokenize(seed).size === 0) return [];

  const openStories = await fetchOpenStoryCandidates(provider, seed);
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
  DEFAULT_SEARCH_TOKEN_CAP,
  SEARCH_RESULT_CAP,
  buildIssueUrl,
  buildEpicUrl: buildIssueUrl,
};
