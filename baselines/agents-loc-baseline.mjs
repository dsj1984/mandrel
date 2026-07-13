#!/usr/bin/env node
// Tracks lines-of-code and byte size of the `.agents/` payload over Mandrel
// releases, so the framework's context-diet work (e.g. #4474 /plan collapse,
// #4479 skills diet, #4482 dead-surface retirement, #4475 single-delivery) is
// measurable over time. Bytes tell the prose-diet story that LOC understates:
// markdown cuts drop many bytes per line, JS cuts drop many lines per byte.
//
//   Backfill the last N released tags:
//     node baselines/agents-loc-baseline.mjs --backfill 10
//   Add / refresh the current version at release (upsert, keeps history):
//     node baselines/agents-loc-baseline.mjs            (or: npm run baseline:agents-loc)
//
// Output: baselines/agents-loc.csv — one row per version, with `(loc)` (all
// lines, the `wc -l` proxy, via `git grep -c ^`) and `(bytes)` (blob sizes via
// `git ls-tree --long`) for `.agents` overall plus the key sub-trees. Both read
// each ref directly, so backfill needs no checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CSV = fileURLToPath(new URL('./agents-loc.csv', import.meta.url));
const PATHS = [
  '.agents',
  '.agents/personas',
  '.agents/rules',
  '.agents/scripts',
  '.agents/skills',
  '.agents/workflows',
];
const HEADER = [
  'version',
  ...PATHS.flatMap((p) => [`${p} (loc)`, `${p} (bytes)`]),
];

const git = (args) =>
  execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });

// LOC of `pathspec` at `ref` = sum of `git grep -c ^` per-file line counts
// (`^` matches every line; `-I` skips binary). Exit 1 = no matches → 0.
function locAt(ref, pathspec) {
  let out;
  try {
    out = git(['grep', '-I', '-c', '^', ref, '--', pathspec]);
  } catch (err) {
    if (err.status === 1) return 0;
    throw err;
  }
  let sum = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const n = Number(line.slice(line.lastIndexOf(':') + 1));
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

// Byte size of `pathspec` at `ref` = sum of `git ls-tree --long` blob sizes.
// A missing path in that tree yields empty output (exit 0) → 0.
function bytesAt(ref, pathspec) {
  const out = git(['ls-tree', '-r', '--long', ref, '--', pathspec]);
  let sum = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    // "<mode> <type> <sha> <size>\t<path>"
    const size = Number(line.replace('\t', ' ').split(/\s+/)[3]);
    if (Number.isFinite(size)) sum += size;
  }
  return sum;
}

const rowFor = (version, ref) => [
  version,
  ...PATHS.flatMap((p) => [String(locAt(ref, p)), String(bytesAt(ref, p))]),
];

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function readCsv() {
  const rows = new Map();
  if (!existsSync(CSV)) return rows;
  const lines = readFileSync(CSV, 'utf8').trim().split('\n');
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells[0]) rows.set(cells[0], cells);
  }
  return rows;
}

function writeCsv(rows) {
  const sorted = [...rows.values()].sort((a, b) => cmpVersion(a[0], b[0]));
  const body = `${[HEADER.join(','), ...sorted.map((r) => r.join(','))].join('\n')}\n`;
  writeFileSync(CSV, body);
}

function main() {
  const args = process.argv.slice(2);
  const rows = readCsv();
  const bi = args.indexOf('--backfill');

  if (bi !== -1) {
    const n = Number(args[bi + 1] ?? 10);
    const tags = git(['tag', '-l', 'mandrel-v*'])
      .trim()
      .split('\n')
      .map((t) => t.replace('mandrel-v', ''))
      .filter(Boolean)
      .sort(cmpVersion)
      .slice(-n);
    for (const v of tags) rows.set(v, rowFor(v, `mandrel-v${v}`));
    console.log(`backfilled ${tags.length} version(s): ${tags.join(', ')}`);
  } else {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url))),
    );
    rows.set(pkg.version, rowFor(pkg.version, 'HEAD'));
    console.log(`upserted current version ${pkg.version} at HEAD`);
  }

  writeCsv(rows);
  console.log(`wrote ${CSV}`);
}

main();
