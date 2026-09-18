/**
 * `--issues-file`: a host-fetched `audit::*` issue corpus (MCP, REST, a dump),
 * so dedup runs without `gh`. An unreadable file is a hard error, never a
 * degrade — a silently create-only plan starts the duplicate-filing loop.
 */

import fs from 'node:fs';

/**
 * The one normaliser for every corpus source; any closed-ish `state` or
 * `state_reason` spelling becomes `'closed'`.
 *
 * @param {object} hit
 * @returns {{ number: number, state: 'open'|'closed', title: string, body: string }}
 */
export function normaliseIssueHit(hit) {
  return {
    number: hit.number,
    state: (hit.state ?? hit.state_reason ?? 'open')
      .toString()
      .toLowerCase()
      .includes('closed')
      ? 'closed'
      : 'open',
    title: hit.title ?? '',
    body: hit.body ?? '',
  };
}

/**
 * @param {string} filePath — path to a JSON array of issues.
 * @param {{ readFileSyncImpl?: typeof fs.readFileSync }} [seams]
 * @returns {Array<{ number: number, state: string, title: string, body: string }>}
 * @throws {Error} when the file is missing, unreadable, not JSON, or not an array.
 */
export function loadIssuesFile(
  filePath,
  { readFileSyncImpl = fs.readFileSync } = {},
) {
  let raw;
  try {
    raw = readFileSyncImpl(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `--issues-file: cannot read "${filePath}" (${err.message}). Dedup needs ` +
        'the issue corpus to check against; running without it would classify ' +
        'every group "create" and re-file findings already tracked.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--issues-file: "${filePath}" is not valid JSON (${err.message}). ` +
        'Expected a JSON array of issues, e.g. the result of listing every ' +
        'issue labelled audit::* with state "all".',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `--issues-file: "${filePath}" holds ${describeShape(parsed)}, not a JSON ` +
        'array of issues. Pass the issue list itself, not the envelope wrapping it.',
    );
  }
  return parsed.filter(isIssueLike).map(normaliseIssueHit);
}

/**
 * Without a numeric `number` an entry can never confirm a match, so it drops.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
function isIssueLike(entry) {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    typeof entry.number === 'number'
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a JSON ${typeof value}`;
}
