/**
 * plan-reachability.js — deterministic persist-side scan of draft tickets'
 * route paths against the nav registry, run before any provider call so an
 * orphaned surface is fixed by a free one-line amend.
 *
 * A route-adding Story that never cites the registry is an orphan unless
 * every one of its route paths is mentioned by some registry-citing Story in
 * the plan (the navigation owner). `skipped` when `routeGlobs` is empty.
 * Pure, no I/O.
 */

import {
  extractStoryPaths,
  globToRegExp,
  resolveNavConfig,
} from './plan-navigation.js';

/** Used when `navRegistry` is unconfigured but `routeGlobs` is. */
const FALLBACK_REGISTRY_TOKENS = ['nav registry', 'navigation'];

/**
 * @typedef {Object} ReachabilityOrphan
 * @property {string} story The offending draft story's slug (or title).
 * @property {string[]} paths Route paths with no navigation owner.
 */

/**
 * @typedef {Object} DraftReachabilityResult
 * @property {'skipped'|'ok'|'orphans'} status
 * @property {string[]} reasons
 * @property {ReachabilityOrphan[]} orphans
 * @property {number} scanned Draft stories scanned (0 when skipped).
 */

/**
 * @param {object} input
 * @param {Array<{ slug?: string, title?: string, body?: string }>} input.tickets
 *   The draft ticket set about to be created.
 * @param {object} [input.config] Resolved `.agentrc.json`.
 * @returns {DraftReachabilityResult}
 */
export function evaluateDraftReachability({ tickets, config }) {
  const { routeGlobs, navRegistry } = resolveNavConfig(config);

  if (routeGlobs.length === 0) {
    return {
      status: 'skipped',
      reasons: ['No planning.navigation.routeGlobs configured — skipped.'],
      orphans: [],
      scanned: 0,
    };
  }

  const stories = Array.isArray(tickets) ? tickets : [];
  const matchers = routeGlobs.map(globToRegExp);
  const registryTokens =
    navRegistry.length > 0
      ? navRegistry.map((t) => t.toLowerCase())
      : FALLBACK_REGISTRY_TOKENS;

  const scannedStories = stories.map((story) => {
    const body = typeof story?.body === 'string' ? story.body : '';
    const paths = extractStoryPaths(body);
    const routePaths = paths.filter((p) => matchers.some((rx) => rx.test(p)));
    const text = [body, story?.title ?? ''].join('\n').toLowerCase();
    const referencesRegistry = registryTokens.some((tok) => text.includes(tok));
    return { story, paths, routePaths, referencesRegistry };
  });

  // Every path a registry-citing Story mentions is covered plan-wide.
  const coveredPaths = new Set();
  for (const s of scannedStories) {
    if (!s.referencesRegistry) continue;
    for (const p of s.paths) coveredPaths.add(p);
  }

  const orphans = [];
  for (const s of scannedStories) {
    if (s.referencesRegistry || s.routePaths.length === 0) continue;
    const uncovered = s.routePaths.filter((p) => !coveredPaths.has(p));
    if (uncovered.length === 0) continue;
    orphans.push({
      story: s.story?.slug ?? s.story?.title ?? '<unnamed story>',
      paths: uncovered,
    });
  }

  if (orphans.length > 0) {
    const registryHint =
      navRegistry.length > 0 ? navRegistry.join(', ') : 'the nav registry';
    return {
      status: 'orphans',
      reasons: [
        `${orphans.length} route-adding draft story(ies) leave orphan surfaces with no navigation owner (registry: ${registryHint}).`,
      ],
      orphans,
      scanned: stories.length,
    };
  }

  return {
    status: 'ok',
    reasons: [
      `${stories.length} draft story(ies) scanned — every route-adding story has a navigation owner.`,
    ],
    orphans: [],
    scanned: stories.length,
  };
}

/**
 * @param {DraftReachabilityResult} result A `status: 'orphans'` result.
 * @returns {string}
 */
export function renderReachabilityOrphans(result) {
  const lines = [
    '[plan-persist] SOFT FAILURE — reachability orphans (route-glob vs navRegistry):',
    ...result.orphans.map((o) => `  - ${o.story}: ${o.paths.join(', ')}`),
    '',
    'Nothing was written to GitHub. Apply ONE targeted amend to tickets.json',
    'adding a navigation owner (at most one reachability Story per plan) that',
    'cites the orphaned routes and the nav registry, then re-run the persist',
    'once.',
  ];
  return lines.join('\n');
}
