#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * loc-delta.js — Epic-level LOC accounting (Epic #1181 / Story #1441 /
 * Task #1457).
 *
 * Verifies the Skills-migration acceptance criterion: across the four
 * SSOT directories
 *   - .agents/scripts/
 *   - .agents/skills/
 *   - .agents/workflows/
 *   - .agents/README.md
 * the signed line delta between `main` and `HEAD` must be < 0 (the
 * migration is meant to *retire* code, not add it). Smoke-test files
 * under `tests/skills/` are intentionally excluded — they exist to pin
 * the migration, not to be counted against the LOC budget.
 *
 * Output: a Markdown-flavoured per-directory breakdown on stdout plus a
 * single signed total line. Exit 0 iff total < 0; exit 1 otherwise.
 *
 * Usage:
 *   node .agents/scripts/loc-delta.js                 # main...HEAD
 *   node .agents/scripts/loc-delta.js --base main     # explicit base
 *   node .agents/scripts/loc-delta.js --json          # machine output
 */

import { spawnSync } from 'node:child_process';

import { runAsCli } from './lib/cli-utils.js';

const SCOPE_PATHS = [
  '.agents/scripts/',
  '.agents/skills/',
  '.agents/workflows/',
  '.agents/README.md',
];

const EXCLUDES = ['tests/skills/'];

function parseArgs(argv) {
  const out = { base: 'main', head: 'HEAD', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      out.base = argv[++i];
    } else if (arg === '--head') {
      out.head = argv[++i];
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

/**
 * Compute the (added, removed) line counts between `base` and `head`
 * restricted to the given path. Uses `git diff --numstat` so the parse
 * is unambiguous (tab-separated, additions in column 1, removals in
 * column 2, path in column 3). Binary files surface as `-` and are
 * skipped.
 */
export function computeDeltaForPath({ base, head, path: scopePath }) {
  const range = `${base}...${head}`;
  const result = spawnSync(
    'git',
    ['diff', '--numstat', range, '--', scopePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git diff failed for ${scopePath}: ${result.stderr || result.stdout}`,
    );
  }
  let added = 0;
  let removed = 0;
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, r, file] = parts;
    if (a === '-' || r === '-') continue;
    if (EXCLUDES.some((ex) => file.startsWith(ex))) continue;
    added += Number.parseInt(a, 10) || 0;
    removed += Number.parseInt(r, 10) || 0;
  }
  return { added, removed, delta: added - removed };
}

/**
 * Compute the per-directory deltas + signed total. Returns a shape that
 * is friendly both for human rendering and for `--json` consumers.
 */
export function computeLocDelta({ base, head } = {}) {
  const effectiveBase = base ?? 'main';
  const effectiveHead = head ?? 'HEAD';
  const perPath = SCOPE_PATHS.map((scopePath) => ({
    path: scopePath,
    ...computeDeltaForPath({
      base: effectiveBase,
      head: effectiveHead,
      path: scopePath,
    }),
  }));
  const total = perPath.reduce(
    (acc, row) => ({
      added: acc.added + row.added,
      removed: acc.removed + row.removed,
      delta: acc.delta + row.delta,
    }),
    { added: 0, removed: 0, delta: 0 },
  );
  return {
    base: effectiveBase,
    head: effectiveHead,
    excludes: EXCLUDES,
    perPath,
    total,
    pass: total.delta < 0,
  };
}

function renderHuman(report) {
  const lines = [];
  lines.push('--- loc-delta ---');
  lines.push(`base=${report.base} head=${report.head}`);
  lines.push(`excluded prefixes: ${report.excludes.join(', ')}`);
  lines.push('');
  lines.push('| Directory | Added | Removed | Net delta |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of report.perPath) {
    const sign = row.delta > 0 ? '+' : '';
    lines.push(
      `| ${row.path} | ${row.added} | ${row.removed} | ${sign}${row.delta} |`,
    );
  }
  lines.push('');
  const sign = report.total.delta > 0 ? '+' : '';
  lines.push(
    `Totals: added=${report.total.added} · removed=${report.total.removed} · net=${sign}${report.total.delta}`,
  );
  lines.push(
    report.pass
      ? 'Result: PASS (net LOC delta is negative)'
      : 'Result: FAIL (net LOC delta is not negative — Epic acceptance not met)',
  );
  return lines.join('\n');
}

function help() {
  return `Usage: node .agents/scripts/loc-delta.js [--base <ref>] [--head <ref>] [--json]

Verifies that the signed line delta across the four SSOT directories
(.agents/scripts/, .agents/skills/, .agents/workflows/, .agents/README.md)
is negative between <base> (default: main) and <head> (default: HEAD).
Smoke-test files under tests/skills/ are excluded from the count.

Exit code: 0 iff net delta < 0; 1 otherwise.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(help());
    return 0;
  }
  let report;
  try {
    report = computeLocDelta({ base: args.base, head: args.head });
  } catch (err) {
    process.stderr.write(`loc-delta: ${err.message}\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(report)}\n`);
  }
  return report.pass ? 0 : 1;
}

// Direct-CLI guard: drives `main()` through the framework's `runAsCli`
// helper so the canonical main-guard shape (enforced by
// `tests/enforcement/cli-wrapper.test.js`) stays intact. When imported
// by a test, runAsCli is a no-op and the named exports remain reachable.
runAsCli(
  import.meta.url,
  async () => {
    const code = await main();
    if (code !== 0) process.exit(code);
  },
  {
    source: 'loc-delta',
    onError(err) {
      process.stderr.write(
        `loc-delta: unexpected error: ${err?.message ?? err}\n`,
      );
      process.exit(1);
    },
  },
);
