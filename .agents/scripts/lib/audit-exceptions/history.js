/**
 * Git-history facts about records: when each exception line was added
 * (`addedAt`, from `git blame`, capped because blame is the slowest read on a
 * large repo or on Windows) and whether it was added since a ref
 * (`introduced`, from `git diff -U0`).
 *
 * @module lib/audit-exceptions/history
 */

import { gitSpawn } from '../git-utils.js';

export const DEFAULT_BLAME_LIMIT = 200;

const UNCOMMITTED_SHA = /^0{40}$/;

/**
 * @param {string} porcelain - `git blame --porcelain` output.
 * @returns {Map<number, string>} final line → ISO date.
 */
function parseBlame(porcelain) {
  const timeBySha = new Map();
  const shaByLine = new Map();
  let current = null;
  for (const line of porcelain.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      current = header[1];
      shaByLine.set(Number(header[2]), current);
      continue;
    }
    const time = /^author-time (\d+)$/.exec(line);
    if (time && current) timeBySha.set(current, Number(time[1]));
  }
  const out = new Map();
  for (const [n, sha] of shaByLine) {
    const t = timeBySha.get(sha);
    if (t !== undefined && !UNCOMMITTED_SHA.test(sha))
      out.set(n, new Date(t * 1000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Sets `addedAt` on up to `limit` records, one `git blame` per file.
 *
 * @param {object[]} records
 * @param {{ root: string, limit?: number }} opts
 * @returns {object[]} degradations
 */
export function addBlame(records, { root, limit = DEFAULT_BLAME_LIMIT }) {
  const byFile = new Map();
  for (const r of records.slice(0, limit)) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, group] of byFile) {
    const ranges = group.flatMap((r) => ['-L', `${r.line},${r.line}`]);
    const res = gitSpawn(root, 'blame', '--porcelain', ...ranges, '--', file);
    if (res.status !== 0) continue;
    const dates = parseBlame(res.stdout);
    for (const r of group) r.addedAt = dates.get(r.line) ?? null;
  }
  if (records.length <= limit) return [];
  return [
    {
      input: 'blame-limit',
      reason: `addedAt resolved for the first ${limit} of ${records.length} records`,
      detail: '',
    },
  ];
}

/**
 * @param {string} diff - `git diff -U0` output.
 * @returns {Map<string, Set<number>>}
 */
function parseAddedLines(diff) {
  const added = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    const target = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
    if (target) {
      file = target[1] === '/dev/null' ? null : target[1];
      if (file && !added.has(file)) added.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n += 1) added.get(file).add(n);
  }
  return added;
}

/**
 * Marks `introduced: true` on records whose line was added relative to `ref`.
 *
 * @param {object[]} records
 * @param {{ root: string, ref: string }} opts
 * @returns {object[]} degradations
 */
export function markIntroduced(records, { root, ref }) {
  const res = gitSpawn(
    root,
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    ref,
    '--',
  );
  if (res.status !== 0) {
    return [
      {
        input: 'changed-since',
        reason: `could not diff against ${ref}`,
        detail: res.stderr,
      },
    ];
  }
  const added = parseAddedLines(res.stdout);
  for (const r of records)
    r.introduced = added.get(r.file)?.has(r.line) ?? false;
  return [];
}
