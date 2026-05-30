/**
 * bootstrap/gh-list — `gh`-backed list providers for live pickers.
 *
 * Provides the selection substrate for interactive pickers: thin wrappers
 * over `gh repo list` / `gh project list` that shell out via the same
 * `spawnSync('gh', …)` convention used elsewhere in the bootstrap libs
 * (see `gh-preflight.js`). Both providers return a plain array of string
 * values and degrade to an **empty array on any non-zero exit** (or spawn
 * error), so a missing scope, an unauthenticated host, or a `gh` that is
 * too old never throws here — the caller (the `resolveFromPicker` resolver
 * in `prompt.js`) treats an empty list as "no picker available" and falls
 * through to manual entry.
 *
 * The `runner` seam mirrors `gh-preflight.js`: it defaults to a real
 * `spawnSync('gh', …)` but lets tests inject a stub returning the canonical
 * `{ status, stdout, stderr, error }` shape without spawning a child.
 */

import { spawnSync } from 'node:child_process';

/**
 * Default runner: synchronously execs `gh <args>` and returns the canonical
 * `{ status, stdout, stderr, error }` shape. Extracted so tests can inject a
 * stub without spawning a real child process.
 *
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string,
 *             error?: NodeJS.ErrnoException }}
 */
function defaultGhRunner(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/**
 * Parse newline-delimited JSON-array stdout into a flat list of strings via
 * the supplied `mapItem`. Returns `[]` for empty/whitespace stdout or any
 * shape that does not parse to an array. Non-string mapped values are
 * dropped so the picker only ever renders selectable strings.
 *
 * @param {string} stdout
 * @param {(item: unknown) => unknown} mapItem
 * @returns {string[]}
 */
function parseJsonList(stdout, mapItem) {
  const trimmed = (stdout || '').trim();
  if (trimmed.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(mapItem)
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * List repositories for an owner via `gh repo list <owner>`. Returns the
 * `owner/name` slug for each repo, or `[]` on any non-zero exit / spawn
 * error / missing owner.
 *
 * @param {{ owner?: string, runner?: (args: string[]) => {
 *   status: number|null, stdout: string, stderr: string,
 *   error?: NodeJS.ErrnoException
 * } }} [opts]
 * @returns {string[]}
 */
export function listRepos(opts = {}) {
  const { owner, runner = defaultGhRunner } = opts;
  if (typeof owner !== 'string' || owner.length === 0) return [];
  const result = runner([
    'repo',
    'list',
    owner,
    '--json',
    'nameWithOwner',
    '--limit',
    '100',
  ]);
  if (result.error || result.status !== 0) return [];
  return parseJsonList(result.stdout, (item) =>
    item && typeof item === 'object' ? item.nameWithOwner : undefined,
  );
}

/**
 * List projects (Projects v2) for an owner via `gh project list --owner
 * <owner>`. Returns one `{ label, value }` choice per project — `label` is
 * the human-readable title (with the number appended) and `value` is the
 * numeric Projects V2 number as a string — or `[]` on any non-zero exit /
 * spawn error / missing owner.
 *
 * @param {{ owner?: string, runner?: (args: string[]) => {
 *   status: number|null, stdout: string, stderr: string,
 *   error?: NodeJS.ErrnoException
 * } }} [opts]
 * @returns {{ label: string, value: string }[]}
 */
export function listProjects(opts = {}) {
  const { owner, runner = defaultGhRunner } = opts;
  if (typeof owner !== 'string' || owner.length === 0) return [];
  const result = runner([
    'project',
    'list',
    '--owner',
    owner,
    '--format',
    'json',
  ]);
  if (result.error || result.status !== 0) return [];
  // `gh project list --format json` emits `{ "projects": [...] }`, not a
  // bare array. Unwrap the envelope before mapping titles.
  const trimmed = (result.stdout || '').trim();
  if (trimmed.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const projects = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.projects)
      ? parsed.projects
      : [];
  // Return `{ label, value }` choices: the menu shows the human-readable
  // title, but the resolved value is the numeric Projects V2 number that
  // the `projectNumber` question's validator (and the downstream GitHub
  // provider) require. Mapping the title into the numeric field would store
  // a non-numeric string and break project resolution.
  return projects
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const number = item.number;
      if (typeof number !== 'number' || !Number.isInteger(number)) {
        return undefined;
      }
      const title =
        typeof item.title === 'string' && item.title.length > 0
          ? item.title
          : String(number);
      return { label: `${title} (#${number})`, value: String(number) };
    })
    .filter((choice) => choice !== undefined);
}
