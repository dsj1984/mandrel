/**
 * `depends_on` entries naming an existing issue (`#<id>`) rather than a
 * sibling slug. They take no part in sibling ordering or cycle detection, and
 * are validated before any create — an unresolvable blocker on a live Story
 * reads to delivery as a permanent wedge, not an error.
 *
 * @module lib/orchestration/plan-persist/external-deps
 */

import { TYPE_LABELS } from '../../label-constants.js';

const EXTERNAL_REF_RE = /^#(\d+)$/;

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isExternalDependencyRef(entry) {
  return typeof entry === 'string' && EXTERNAL_REF_RE.test(entry.trim());
}

/**
 * @param {unknown} entry
 * @returns {number|null}
 */
export function externalDependencyId(entry) {
  if (typeof entry !== 'string') return null;
  const match = entry.trim().match(EXTERNAL_REF_RE);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * @param {Array<{ depends_on?: string[] }>} stories
 * @returns {number[]}
 */
export function collectExternalDependencyIds(stories) {
  const seen = new Set();
  const out = [];
  for (const story of Array.isArray(stories) ? stories : []) {
    for (const entry of story?.depends_on ?? []) {
      const id = externalDependencyId(entry);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function labelNames(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string');
}

/**
 * @param {number} id
 * @param {object|null} issue
 * @returns {string|null}
 */
function rejectionReason(id, issue) {
  if (!issue) return `#${id} does not exist`;
  const state = String(issue.state ?? 'open').toLowerCase();
  if (state !== 'open') {
    return `#${id} is ${state} — a landed Story cannot gate new work, so the edge would never lift`;
  }
  const labels = labelNames(issue.labels);
  if (labels.includes(TYPE_LABELS.EPIC)) {
    return `#${id} is a container Epic — Epics are never delivered, so nothing would ever satisfy the edge`;
  }
  if (!labels.includes(TYPE_LABELS.STORY)) {
    return `#${id} is not a ${TYPE_LABELS.STORY} — only a Story can be delivered and thereby unblock this one`;
  }
  return null;
}

/**
 * Every external ref must be an open Story; the error lists every bad ref.
 *
 * @param {{ provider: object, stories: Array<{ slug: string, depends_on?: string[] }> }} args
 * @returns {Promise<number[]>}
 * @throws {Error} When any ref is missing, closed, an Epic, or not a Story.
 */
export async function assertExternalDependenciesResolvable({
  provider,
  stories,
}) {
  const ids = collectExternalDependencyIds(stories);
  if (ids.length === 0) return [];

  if (typeof provider?.getTicket !== 'function') {
    throw new Error(
      '[plan-persist] provider exposes no getTicket — cannot verify the external ' +
        `depends_on reference(s): ${ids.map((i) => `#${i}`).join(', ')}.`,
    );
  }

  const problems = [];
  for (const id of ids) {
    let issue = null;
    try {
      issue = await provider.getTicket(id);
    } catch (err) {
      problems.push(`#${id} could not be read (${err?.message ?? err})`);
      continue;
    }
    const reason = rejectionReason(id, issue);
    if (reason) problems.push(reason);
  }

  if (problems.length > 0) {
    throw new Error(
      `[plan-persist] ${problems.length} external depends_on reference(s) cannot gate ` +
        `this plan:\n  - ${problems.join('\n  - ')}\n\nEvery "#<id>" entry must name an ` +
        `open ${TYPE_LABELS.STORY}. Drop the entry, or point it at a Story that is still open.`,
    );
  }

  return ids;
}
