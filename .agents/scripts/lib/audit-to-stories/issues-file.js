/**
 * lib/audit-to-stories/issues-file.js — the issue corpus dedup checks against,
 * and the one normaliser every source of it goes through.
 *
 * Dedup needs exactly one thing from GitHub: the list of Issues carrying an
 * `audit::*` label. Until Story #5301 the only way to get it was the provider,
 * which spawns `gh`, so a host without a `gh` CLI — a Claude Code cloud
 * sandbox, where `gh` is absent and direct API access is disabled but the
 * GitHub MCP tools work fine — could not dedup at all. Every group classified
 * `create` and a scheduled sweep re-filed findings it had already filed.
 *
 * `--issues-file <path>` breaks that coupling: the host fetches the list by
 * whatever access path it has and hands over a JSON array. Nothing here knows
 * how it was fetched, so MCP, REST, and a cached dump are all equally valid.
 *
 * A file that cannot be read as an issue array is a **hard error**, never a
 * degrade. Falling back would mean "dedup did not run" on precisely the
 * invocation whose whole purpose is that it does — and a create-only plan the
 * operator reads as checked is how the duplicate-filing loop starts.
 */

import fs from 'node:fs';

/**
 * Flatten one raw issue onto the `{ number, state, title, body }` shape the
 * dedupe module reads, collapsing every closed-ish state spelling (`CLOSED`,
 * `state_reason: not_planned`, …) onto `'closed'`.
 *
 * Shared by both corpus sources — the provider's `searchIssues` hits and the
 * `--issues-file` array — so a host can hand over a raw `list_issues` result
 * verbatim without knowing which spelling this repo's dedup expects.
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
 * Read and normalise a host-supplied issue corpus.
 *
 * `state` is read from either `state` or `state_reason`, so a closed-as-
 * not-planned issue is recognised however the host's API spelled it. Only
 * `number` and `body` are load-bearing: the number identifies the match and
 * the body carries the provenance footers dedup confirms identity against.
 *
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
 * Whether one array entry can possibly identify an issue. An entry without a
 * numeric `number` can never confirm a match — exactly as it could not when it
 * came back from a search — so it is dropped rather than indexed under nothing.
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
 * Name what a non-array payload actually was, so the error points at the fix.
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a JSON ${typeof value}`;
}
