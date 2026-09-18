/**
 * epic-candidates.js — rank the open container Epics a new plan could join,
 * for the operator to pick at Gate #3 (joining a different cohort is a
 * decision, not a fingerprint match). The list is complete, never
 * thresholded: hiding a low scorer is how one body of work gets two
 * containers. Scoring reuses `duplicate-search.js`'s tokenizer and overlap —
 * a triage signal, not semantic search.
 *
 * @module lib/orchestration/epic-candidates
 */

import { overlapScore, tokenize } from '../duplicate-search.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { concurrentMap, FANOUT_CONCURRENCY } from '../util/concurrent-map.js';
import { isEpicTicket, readEpicChildIds } from './epic-container.js';

/**
 * @param {number} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildEpicUrl(id, { owner, repo } = {}) {
  if (owner && repo) return `https://github.com/${owner}/${repo}/issues/${id}`;
  return `#${id}`;
}

/**
 * Child titles carry the concrete vocabulary an abstract Epic title lacks.
 * Best-effort: failures only reduce tokens.
 *
 * @param {{ childIds: number[], provider: object }} opts
 * @returns {Promise<string>} Space-joined child titles ('' when none resolved).
 */
async function readChildTitles({ childIds, provider }) {
  if (childIds.length === 0 || typeof provider?.getTicket !== 'function') {
    return '';
  }
  const titles = await concurrentMap(
    childIds,
    async (id) => {
      try {
        const child = await provider.getTicket(id);
        return typeof child?.title === 'string' ? child.title : '';
      } catch {
        return '';
      }
    },
    { concurrency: FANOUT_CONCURRENCY },
  );
  return titles.filter((t) => t !== '').join(' ');
}

/**
 * @param {{ epic: object, seedTokens: Set<string>, provider: object, owner?: string, repo?: string }} opts
 * @returns {Promise<{ id: number, title: string, url: string, score: number, childIds: number[] }|null>}
 */
async function scoreEpic({ epic, seedTokens, provider, owner, repo }) {
  // Declared ticket shape: `id` is the issue number.
  const id = Number(epic?.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const title = typeof epic?.title === 'string' ? epic.title : '';
  const body = typeof epic?.body === 'string' ? epic.body : '';
  const childIds = readEpicChildIds(body);
  const childTitles = await readChildTitles({ childIds, provider });

  // The tokenizer drops marker/id noise.
  const corpus = `${title}\n${body}\n${childTitles}`;
  const score = overlapScore(seedTokens, tokenize(corpus));

  return {
    id,
    title,
    url: epic?.url ?? buildEpicUrl(id, { owner, repo }),
    score: Number(score.toFixed(4)),
    childIds,
  };
}

/**
 * Every open container Epic ranked by seed overlap. Closed Epics are
 * finished work and never candidates. Failures degrade to `[]`.
 *
 * @param {{
 *   seed: string,
 *   provider: object,
 *   owner?: string,
 *   repo?: string,
 * }} args
 * @returns {Promise<Array<{ id: number, title: string, url: string, score: number, childIds: number[] }>>}
 */
export async function findOpenEpicCandidates({ seed, provider, owner, repo }) {
  if (typeof seed !== 'string' || seed.trim() === '') return [];
  if (typeof provider?.listTicketsByLabel !== 'function') return [];

  const seedTokens = tokenize(seed);
  if (seedTokens.size === 0) return [];

  let issues;
  try {
    issues = await provider.listTicketsByLabel({
      state: 'open',
      labels: TYPE_LABELS.EPIC,
    });
  } catch (err) {
    Logger.warn(
      `[epic-candidates] open-Epic listing degraded to no candidates: ${err?.message ?? err}`,
    );
    return [];
  }

  const epics = (Array.isArray(issues) ? issues : []).filter(isEpicTicket);
  const scored = await concurrentMap(
    epics,
    (epic) => scoreEpic({ epic, seedTokens, provider, owner, repo }),
    { concurrency: FANOUT_CONCURRENCY },
  );

  // Ties break on id.
  return scored
    .filter((c) => c !== null)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
