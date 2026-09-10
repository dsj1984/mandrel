/**
 * dependency-candidates.js — open Stories a newly planned Story may need to
 * wait for.
 *
 * Story #5155. `depends_on[]` has always ordered *siblings within one plan*.
 * Nothing surfaced the other ordering that actually bites: a Story authored
 * today that edits a file an already-open Story from an earlier plan is going
 * to rewrite. Delivered concurrently, the second lands on a base the first
 * just changed — and the planner had no way to see it coming, because the
 * duplicate search asks "is this the same Story?" (title/body similarity),
 * never "does this Story touch what I am about to touch?".
 *
 * Overlap here is therefore computed on **declared footprints**, not prose:
 * the seed's `predictedPaths` against each open Story's parsed `changes[]`,
 * via the same `storyFootprint` the wave runner uses to withhold colliding
 * Stories at dispatch. That is deliberate — the planner sees the collision the
 * runtime would later enforce, one layer earlier and while it is still cheap
 * to order around.
 *
 * The result is **advisory**: an overlap is a prompt to consider an edge, not
 * proof one is needed. Two Stories can touch a shared barrel file with no real
 * ordering between them; only the operator knows.
 *
 * @module lib/orchestration/dependency-candidates
 * @see Story #5155
 */

import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import { storyFootprint } from '../wave-runner/footprint.js';

/**
 * Build an issue URL for a Story the provider returned without one.
 *
 * @param {number} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildStoryUrl(id, { owner, repo } = {}) {
  if (owner && repo) return `https://github.com/${owner}/${repo}/issues/${id}`;
  return `#${id}`;
}

/**
 * Read one open Story's declared footprint.
 *
 * Total by construction: an unparseable body yields an empty footprint, which
 * intersects with nothing and drops the Story from the candidate list. A
 * hand-written Story with no `## Changes` section is exactly that case, and it
 * is the right outcome — there is no declared footprint to collide with.
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
 * Find open Stories whose declared footprint intersects the seed's predicted
 * paths.
 *
 * Returns `[]` **without contacting the provider** when the seed named no
 * paths: with nothing to intersect, every candidate would score empty, and the
 * round-trip would buy nothing. That short-circuit is load-bearing for the
 * common one-line seed, which mentions no file at all.
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
    // The declared ticket shape: `id` is the issue number. Reading it through
    // the old `number`-then-`id` fallback was the bug in waiting — on this
    // shape the fallback never fires, and on a raw REST payload it silently
    // produced database ids for every candidate the planner offered.
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
