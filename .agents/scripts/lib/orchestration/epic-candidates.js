/**
 * epic-candidates.js — rank the open container Epics a new plan could join.
 *
 * Story #5155. `plan-persist` has always been able to *create* a container
 * Epic, and to re-adopt one whose fingerprint matches the exact cohort it is
 * re-persisting. Neither helps the case this module exists for: a second plan,
 * days later, adding work that belongs under the Epic a first plan opened. The
 * fingerprint is keyed on the child set, so a different cohort never matches
 * it — by design, since adopting the wrong container silently mis-files a run.
 *
 * So the join has to be a **decision**, not a hash collision: this module
 * surfaces every open Epic with an overlap score, and the operator picks at
 * Gate #3. The list is deliberately **complete rather than thresholded** — a
 * low score is evidence for the operator to weigh, and hiding a candidate is
 * how a plan silently opens its second container for one body of work.
 *
 * Scoring reuses `duplicate-search.js`'s tokenizer and Jaccard overlap rather
 * than growing a second similarity notion in the codebase; like that module's,
 * it is a triage signal and not a semantic search.
 *
 * @module lib/orchestration/epic-candidates
 * @see Story #5155
 */

import { overlapScore, tokenize } from '../duplicate-search.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { concurrentMap, FANOUT_CONCURRENCY } from '../util/concurrent-map.js';
import { isEpicTicket, readEpicChildIds } from './epic-container.js';

/**
 * Build an issue URL for an Epic the provider returned without one.
 *
 * @param {number} id
 * @param {{ owner?: string, repo?: string }} [opts]
 * @returns {string}
 */
function buildEpicUrl(id, { owner, repo } = {}) {
  if (owner && repo) return `https://github.com/${owner}/${repo}/issues/${id}`;
  return `#${id}`;
}

/**
 * Fetch the titles of an Epic's children, for scoring only.
 *
 * Child titles matter because a container's own title and goal are short and
 * abstract ("Auth hardening", one paragraph), while the seed that should match
 * it is concrete. The children are where the shared vocabulary actually lives.
 *
 * Entirely best-effort: no `getTicket`, an unreadable child, or a throw all
 * degrade to fewer title tokens, never to a failed envelope. A candidate that
 * scores low because its children could not be read is still *listed* — the
 * operator sees every open Epic regardless.
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
 * Score one open Epic against the seed.
 *
 * @param {{ epic: object, seedTokens: Set<string>, provider: object, owner?: string, repo?: string }} opts
 * @returns {Promise<{ id: number, title: string, url: string, score: number, childIds: number[] }|null>}
 */
async function scoreEpic({ epic, seedTokens, provider, owner, repo }) {
  // `listTicketsByLabel` hands back the declared ticket shape, in which `id`
  // is the issue number. The `number`-then-`id` fallback this replaced read as
  // defensive and was not: on that shape it never fired, and on a raw REST
  // payload it was the only thing standing between this and scoring an Epic
  // under its database id.
  const id = Number(epic?.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const title = typeof epic?.title === 'string' ? epic.title : '';
  const body = typeof epic?.body === 'string' ? epic.body : '';
  const childIds = readEpicChildIds(body);
  const childTitles = await readChildTitles({ childIds, provider });

  // The fingerprint marker and checklist ids are machine noise; the tokenizer
  // drops short and non-alphabetic tokens, so the corpus is effectively the
  // title, the `## Goal` prose and the child titles.
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
 * Find every open container Epic, ranked by overlap with the seed.
 *
 * **Only open Epics are candidates.** A closed Epic is a completed body of
 * work; joining one would reopen a container the epilogue deliberately closed,
 * and silently re-scope a finished plan. The operator files a new Epic or
 * reopens the old one by hand.
 *
 * Failures degrade to `[]` — like the duplicate search, this is a triage
 * signal offered at a gate, and no plan should fail to be authored because
 * the Epic listing was unavailable.
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

  // Descending score, then ascending id: a stable order for two Epics that
  // tie, so the same backlog always renders the same list.
  return scored
    .filter((c) => c !== null)
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
