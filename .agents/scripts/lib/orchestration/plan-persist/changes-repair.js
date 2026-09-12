/**
 * changes-repair.js — repair-before-judging for `changes[]` entries
 * (Story #5312).
 *
 * The `{ path, assumption }` object shape is a deterministic, mechanically
 * derivable formality. The validator already knew how to salvage a path from
 * a plain-string bullet (`suggestPathEntryFix`) — then rejected the plan
 * anyway and charged the author a full re-drafting round to paste that exact
 * object back. Story #5005 made the same call for the verify-tier suffix and
 * repaired it instead; the suffix is gone now, and the repair moves to the
 * one formality left: this module applies the inference the validator
 * trusts, so the dry-run rewrites and **reports** each repair rather than
 * refusing on it.
 *
 * Two shapes are repaired, on both authoring surfaces (a structured object
 * body's `changes[]` array and a serialized string body's `## Changes`
 * section):
 *
 *   - a **plain-string bullet** (`src/app.js`, `` `src/app.js` ``,
 *     `src/app.js — adds the route`) becomes `{ path, assumption }`, the
 *     assumption resolved by probing the base branch — a path present at
 *     base is a `refactors-existing`, an absent one a `creates`;
 *   - a **trailing parenthetical** on a path (`src/app.js (new)`,
 *     `` `src/app.js (creates)` — refactors-existing ``) is stripped; an
 *     authored assumption is kept, an absent one probed as above.
 *
 * A string nothing path-shaped can be salvaged from is left untouched and
 * still fails the body-shape validator — that is the one `changes[]` failure
 * only the author can resolve.
 *
 * It lives beside the validator rather than inside it because the validator's
 * job is to *judge*: mixing a mutating repair pass into a module of pure
 * collectors muddies both. `persist-helpers.js#validateTickets` calls this
 * first, then the validators.
 *
 * @module lib/orchestration/plan-persist/changes-repair
 */

import { FILE_ASSUMPTION_VALUES } from '../file-assumption-enum.js';

/** The `## Changes` heading (either level the parser accepts). */
const CHANGES_HEADING_RE = /^#{2,3}\s+Changes\s*$/i;

/** Any heading — the end of the `## Changes` section. */
const ANY_HEADING_RE = /^#{1,6}\s+\S/;

/** A trailing `(…)` on a path token. */
const TRAILING_PARENTHETICAL_RE = /\s*\([^)]*\)\s*$/;

/** The humanized canonical bullet: `` `path` — assumption ``. */
const HUMANIZED_RE = /^`([^`]+)`\s+—\s+(\S+)$/;

// A token that looks like a file path / glob / module id: it carries a `/` or a
// `.`-separated segment. Deliberately loose — a false positive only produces a
// `{ path, assumption }` entry the base-branch probes then judge.
const PATH_LIKE_RE = /^[\w@*-]*[/.][\w@./*-]+$/;

/**
 * Strip a trailing parenthetical from a path token, reporting whether one
 * was present.
 *
 * @param {string} raw
 * @returns {{ path: string, stripped: boolean }}
 */
function stripParenthetical(raw) {
  const path = raw.replace(TRAILING_PARENTHETICAL_RE, '').trim();
  return { path, stripped: path !== raw.trim() };
}

/**
 * Salvage the path token from a plain-string bullet: drop a leading list
 * marker, take the segment before any humanized ` — ` tail, peel quotes and
 * backticks, strip a trailing parenthetical. Returns `null` when nothing
 * path-shaped survives.
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
  return s !== '' && PATH_LIKE_RE.test(s) ? s : null;
}

/**
 * Resolve the assumption for a path with none authored: present at base →
 * `refactors-existing`, absent → `creates`.
 *
 * @param {string} path
 * @param {(path: string) => boolean} existsAtBase
 * @returns {'refactors-existing'|'creates'}
 */
function probeAssumption(path, existsAtBase) {
  return existsAtBase(path) ? 'refactors-existing' : 'creates';
}

/**
 * Repair one structured `changes[]` item. Returns the corrected entry and a
 * repair record, or `null` when the item needs no repair (or cannot be
 * repaired).
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
 * Repair one line of a serialized `## Changes` section. Returns the rewritten
 * line and a repair record, or `null` when the line is already canonical or
 * cannot be repaired.
 *
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
 * Repair the `## Changes` section of a serialized body in place. Only lines
 * between the heading and the next heading are touched; the rest of the
 * body is byte-identical.
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
 * Repair the `changes[]` of one ticket, on whichever surface carries it.
 *
 * @param {object} ticket Mutated in place.
 * @param {(path: string) => boolean} existsAtBase
 * @returns {object[]} The repairs applied to this ticket.
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
 * Render one repair as the dry-run line the operator reads.
 *
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
 * Rewrite every repairable `changes[]` entry across the draft, probing the
 * base branch for the assumption where none was authored. Mutates `tickets`
 * in place (the persist pipeline threads this same array on to assembly)
 * and returns the repairs, each tagged with the Story's slug. Total — a
 * non-array argument and non-Story tickets are no-ops.
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
