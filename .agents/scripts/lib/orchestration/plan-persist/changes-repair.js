/**
 * Repair-before-judging for `changes[]`, on both the structured array and a
 * serialized `## Changes` section: a plain-string bullet becomes
 * `{ path, assumption }` (probed at base: present → `refactors-existing`,
 * absent → `creates`), and a trailing parenthetical on a path is stripped.
 * Repairs are reported, not refused; an unsalvageable string is left for the
 * validator. Kept apart from the validator, whose collectors are pure.
 *
 * @module lib/orchestration/plan-persist/changes-repair
 */

import { matchBarePathToken } from '../../story-body/body-format-lints.js';
import { FILE_ASSUMPTION_VALUES } from '../file-assumption-enum.js';

const CHANGES_HEADING_RE = /^#{2,3}\s+Changes\s*$/i;

const ANY_HEADING_RE = /^#{1,6}\s+\S/;

const TRAILING_PARENTHETICAL_RE = /\s*\([^)]*\)\s*$/;

/** The canonical bullet: `` `path` — assumption ``. */
const HUMANIZED_RE = /^`([^`]+)`\s+—\s+(\S+)$/;

/**
 * @param {string} raw
 * @returns {{ path: string, stripped: boolean }}
 */
function stripParenthetical(raw) {
  const path = raw.replace(TRAILING_PARENTHETICAL_RE, '').trim();
  return { path, stripped: path !== raw.trim() };
}

/**
 * Path-shaped means `matchBarePathToken` — the parser's own grammar, so the
 * repair and the parser accept the same class.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function salvagePath(raw) {
  let s = raw
    .trim()
    .replace(/^[-*]\s+/, '')
    .trim();
  s = s.split('—')[0].trim();
  s = s
    .replace(/^[`'"]+/, '')
    .replace(/[`'"]+$/, '')
    .trim();
  s = stripParenthetical(s).path;
  return matchBarePathToken(s);
}

/**
 * @param {string} path
 * @param {(path: string) => boolean} existsAtBase
 * @returns {'refactors-existing'|'creates'}
 */
function probeAssumption(path, existsAtBase) {
  return existsAtBase(path) ? 'refactors-existing' : 'creates';
}

/**
 * `null` when the item needs no repair or cannot be repaired.
 *
 * @param {unknown} item
 * @param {(path: string) => boolean} existsAtBase
 * @returns {{ entry: { path: string, assumption: string }, repair: object }|null}
 */
function repairStructuredItem(item, existsAtBase) {
  if (typeof item === 'string') {
    const path = salvagePath(item);
    if (path === null) return null;
    const assumption = probeAssumption(path, existsAtBase);
    return {
      entry: { path, assumption },
      repair: { from: item, path, assumption, reason: 'plain-string' },
    };
  }
  if (item === null || typeof item !== 'object') return null;
  if (typeof item.path !== 'string') return null;
  const { path, stripped } = stripParenthetical(item.path);
  const authored = FILE_ASSUMPTION_VALUES.includes(item.assumption);
  if (!stripped && authored) return null;
  if (path === '') return null;
  const assumption = authored
    ? item.assumption
    : probeAssumption(path, existsAtBase);
  return {
    entry: { path, assumption },
    repair: {
      from: item.path,
      path,
      assumption,
      reason: stripped ? 'trailing-parenthetical' : 'missing-assumption',
    },
  };
}

/**
 * @param {string} line
 * @param {(path: string) => boolean} existsAtBase
 * @returns {{ line: string, repair: object }|null}
 */
function repairSectionLine(line, existsAtBase) {
  const marker = line.match(/^(\s*[-*]\s+)/);
  if (!marker) return null;
  const content = line.slice(marker[1].length).trim();
  if (content === '') return null;
  const humanized = content.match(HUMANIZED_RE);
  if (humanized) {
    const { path, stripped } = stripParenthetical(humanized[1]);
    const authored = FILE_ASSUMPTION_VALUES.includes(humanized[2]);
    if (!stripped && authored) return null;
    if (path === '') return null;
    const assumption = authored
      ? humanized[2]
      : probeAssumption(path, existsAtBase);
    return {
      line: `${marker[1]}\`${path}\` — ${assumption}`,
      repair: {
        from: content,
        path,
        assumption,
        reason: stripped ? 'trailing-parenthetical' : 'missing-assumption',
      },
    };
  }
  if (content.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const repaired = repairStructuredItem(parsed, existsAtBase);
    if (repaired === null) return null;
    return {
      line: `${marker[1]}\`${repaired.entry.path}\` — ${repaired.entry.assumption}`,
      repair: repaired.repair,
    };
  }
  const path = salvagePath(content);
  if (path === null) return null;
  const assumption = probeAssumption(path, existsAtBase);
  return {
    line: `${marker[1]}\`${path}\` — ${assumption}`,
    repair: { from: content, path, assumption, reason: 'plain-string' },
  };
}

/**
 * Touches only the `## Changes` section; the rest stays byte-identical.
 *
 * @param {string} body
 * @param {(path: string) => boolean} existsAtBase
 * @returns {{ body: string, repairs: object[] }}
 */
function repairSerializedBody(body, existsAtBase) {
  const lines = body.split('\n');
  const repairs = [];
  let inChanges = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (CHANGES_HEADING_RE.test(line.trim())) {
      inChanges = true;
      continue;
    }
    if (!inChanges) continue;
    if (ANY_HEADING_RE.test(line) || line.trim().startsWith('---')) {
      inChanges = false;
      continue;
    }
    const repaired = repairSectionLine(line, existsAtBase);
    if (repaired === null) continue;
    lines[i] = repaired.line;
    repairs.push(repaired.repair);
  }
  return { body: lines.join('\n'), repairs };
}

/**
 * @param {object} ticket Mutated in place.
 * @param {(path: string) => boolean} existsAtBase
 * @returns {object[]}
 */
function repairTicket(ticket, existsAtBase) {
  const body = ticket.body;
  if (typeof body === 'string') {
    const { body: next, repairs } = repairSerializedBody(body, existsAtBase);
    if (repairs.length > 0) ticket.body = next;
    return repairs;
  }
  const changes =
    body && typeof body === 'object' && Array.isArray(body.changes)
      ? body.changes
      : Array.isArray(ticket.changes)
        ? ticket.changes
        : null;
  if (changes === null) return [];
  const repairs = [];
  for (let i = 0; i < changes.length; i += 1) {
    const repaired = repairStructuredItem(changes[i], existsAtBase);
    if (repaired === null) continue;
    changes[i] = repaired.entry;
    repairs.push(repaired.repair);
  }
  return repairs;
}

/**
 * @param {{ slug: string, from: string, path: string, assumption: string, reason: string }} repair
 * @returns {string}
 */
export function renderChangeRepair({ slug, from, path, assumption, reason }) {
  const why =
    reason === 'plain-string'
      ? 'plain-string bullet'
      : reason === 'trailing-parenthetical'
        ? 'trailing parenthetical'
        : 'missing assumption';
  return `Story "${slug}": changes[] entry "${from}" (${why}) repaired to {"path":"${path}","assumption":"${assumption}"} by probing base.`;
}

/**
 * Mutates `tickets` in place — persist threads this same array on to
 * assembly.
 *
 * @param {object[]} tickets
 * @param {{ existsAtBase: (path: string) => boolean }} args
 * @returns {Array<{ slug: string, from: string, path: string, assumption: string, reason: string }>}
 */
export function repairChangeEntries(tickets, { existsAtBase }) {
  const repairs = [];
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    if (!ticket || ticket.type !== 'story') continue;
    const slug = ticket.slug ?? ticket.title ?? '<unknown>';
    for (const repair of repairTicket(ticket, existsAtBase)) {
      repairs.push({ slug, ...repair });
    }
  }
  return repairs;
}
