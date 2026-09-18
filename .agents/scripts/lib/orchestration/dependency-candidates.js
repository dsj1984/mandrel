/**
 * dependency-candidates.js — open Stories from earlier plans whose declared
 * footprint overlaps a new seed's predicted paths, via the same
 * `storyFootprint` the wave runner uses to withhold collisions — so the
 * planner sees the collision the runtime would enforce. Advisory: an overlap
 * suggests an edge, it does not prove one.
 *
 * @module lib/orchestration/dependency-candidates
 */

import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import { storyFootprint } from '../wave-runner/footprint.js';

/**
 * @param {number} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildStoryUrl(id, { owner, repo } = {}) {
  if (owner && repo) return `https://github.com/${owner}/${repo}/issues/${id}`;
  return `#${id}`;
}

/**
 * Declared footprint; empty (never a candidate) when unparseable.
 *
 * @param {object} issue
 * @returns {Set<string>}
 */
function footprintOf(issue) {
  const body = typeof issue?.body === 'string' ? issue.body : '';
  if (body === '') return new Set();
  try {
    return storyFootprint(parseStoryBody(body).body);
  } catch {
    return new Set();
  }
}

/**
 * Returns `[]` without contacting the provider when the seed names no paths
 * (the common case).
 *
 * @param {{
 *   predictedPaths: string[],
 *   provider: object,
 *   owner?: string,
 *   repo?: string,
 *   excludeIds?: Iterable<number|string>,
 * }} args
 * @returns {Promise<Array<{ id: number, title: string, url: string, state: string, overlappingPaths: string[] }>>}
 */
export async function findDependencyCandidates({
  predictedPaths,
  provider,
  owner,
  repo,
  excludeIds = [],
}) {
  const wanted = (Array.isArray(predictedPaths) ? predictedPaths : []).filter(
    (p) => typeof p === 'string' && p.trim() !== '',
  );
  if (wanted.length === 0) return [];
  if (typeof provider?.listTicketsByLabel !== 'function') return [];

  const excluded = new Set(
    [...excludeIds].map((id) => Number(id)).filter((n) => Number.isFinite(n)),
  );

  let issues;
  try {
    issues = await provider.listTicketsByLabel({
      state: 'open',
      labels: TYPE_LABELS.STORY,
    });
  } catch (err) {
    Logger.warn(
      `[dependency-candidates] open-Story listing degraded to no candidates: ${err?.message ?? err}`,
    );
    return [];
  }

  const out = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    // Declared ticket shape: `id` is the issue number.
    const id = Number(issue?.id);
    if (!Number.isInteger(id) || id <= 0 || excluded.has(id)) continue;

    const footprint = footprintOf(issue);
    if (footprint.size === 0) continue;

    const overlappingPaths = wanted.filter((p) => footprint.has(p));
    if (overlappingPaths.length === 0) continue;

    out.push({
      id,
      title: typeof issue?.title === 'string' ? issue.title : '',
      url: issue?.url ?? buildStoryUrl(id, { owner, repo }),
      state: typeof issue?.state === 'string' ? issue.state : 'open',
      overlappingPaths,
    });
  }

  // Most-entangled first, then ascending id for a stable render.
  return out.sort(
    (a, b) =>
      b.overlappingPaths.length - a.overlappingPaths.length || a.id - b.id,
  );
}
