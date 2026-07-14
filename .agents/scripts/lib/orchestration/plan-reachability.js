/**
 * plan-reachability.js — deterministic draft-ticket reachability check for
 * the persist surface (Epic #4474 PR6, design §4: the 8.4 reachability
 * critic demoted from a fresh-context sub-agent to a persist-side scan).
 *
 * Route-glob scan of the paths a Story declares vs the
 * `planning.navigation.navRegistry` token list, run over the **draft**
 * ticket set inside `plan-persist.js` step 4.5, before any provider call,
 * so an orphaned surface is caught while a one-line targeted amend is
 * still free (nothing has been written to GitHub yet).
 *
 * Plan-level coverage semantics (the convergence contract): a route-adding
 * story that never references the nav registry produces orphan surfaces —
 * UNLESS every one of its route paths is also mentioned by some story in
 * the plan that DOES reference the registry (the "navigation owner"). That
 * is exactly what the documented recovery produces: the author appends the
 * single reachability Story (which cites the orphaned routes and the nav
 * registry) in one targeted amend, and the re-run persist passes.
 *
 * Silent no-op when `planning.navigation` is unconfigured (`routeGlobs`
 * empty) — reported as `status: 'skipped'` so the caller can append the
 * audit record to the plan-metrics ledger.
 *
 * Pure over its inputs (tickets + resolved config), no I/O.
 */

import {
  extractStoryPaths,
  globToRegExp,
  resolveNavConfig,
} from './plan-navigation.js';

/**
 * Fallback tokens when `navRegistry` is unconfigured but `routeGlobs` is.
 */
const FALLBACK_REGISTRY_TOKENS = ['nav registry', 'navigation'];

/**
 * @typedef {Object} ReachabilityOrphan
 * @property {string} story The offending draft story's slug (or title).
 * @property {string[]} paths The route-matching paths with no navigation
 *   owner anywhere in the plan.
 */

/**
 * @typedef {Object} DraftReachabilityResult
 * @property {'skipped'|'ok'|'orphans'} status
 * @property {string[]} reasons
 * @property {ReachabilityOrphan[]} orphans Empty unless `status` is
 *   `'orphans'`.
 * @property {number} scanned Draft stories scanned (0 when skipped).
 */

/**
 * Evaluate draft-ticket reachability against the configured navigation
 * surface.
 *
 * @param {object} input
 * @param {Array<{ slug?: string, title?: string, body?: string }>} input.tickets
 *   The draft ticket set the persist is about to create (fan-out: the
 *   authored `tickets.json`; amend: the merged set).
 * @param {object} [input.config] Resolved `.agentrc.json` (threads
 *   `planning.navigation`).
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

  // Pass 1: per-story scan — declared paths, route matches, registry refs.
  const scannedStories = stories.map((story) => {
    const body = typeof story?.body === 'string' ? story.body : '';
    const paths = extractStoryPaths(body);
    const routePaths = paths.filter((p) => matchers.some((rx) => rx.test(p)));
    const text = [body, story?.title ?? ''].join('\n').toLowerCase();
    const referencesRegistry = registryTokens.some((tok) => text.includes(tok));
    return { story, paths, routePaths, referencesRegistry };
  });

  // Pass 2: navigation owners — every path mentioned by a
  // registry-referencing story is covered plan-wide.
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
 * Render the named soft-failure message the persist CLI prints — the
 * orphan-surface list plus the one-targeted-amend recovery contract.
 *
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
