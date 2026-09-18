/**
 * CLI: ratchet-down dead-export gate built on knip. Diffs knip's unused
 * exports — plus a `{ file, symbol: '*' }` row per module nothing imports —
 * against `baselines/dead-exports.json` by `(file, symbol)`. Exit 1 only on an
 * added row; a knip spawn/parse failure is advisory (exit 0 + warning) so a
 * broken knip cannot block CI.
 *
 * `--production` discounts test-only importers (production-dead code hides
 * behind its own tests) and uses its own baseline — see
 * `lib/dead-exports-mode.js`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import {
  extractRowsFromKnip,
  readKnipOutput,
  runKnip,
} from './lib/dead-exports-knip.js';
import { resolveDeadExportsMode } from './lib/dead-exports-mode.js';

/**
 * `--knip-output` is a test seam: a pre-captured knip JSON instead of a spawn.
 *
 * @param {string[]} argv
 * @returns {{ baselinePath: string | null, json: boolean, knipOutputPath: string | null, production: boolean }}
 */
export function parseArgv(argv = []) {
  let baselinePath = null;
  let json = false;
  let knipOutputPath = null;
  let production = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--baseline') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        baselinePath = next;
        i += 1;
      }
    } else if (a === '--json') {
      json = true;
    } else if (a === '--production') {
      production = true;
    } else if (a === '--knip-output') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        knipOutputPath = next;
        i += 1;
      }
    }
  }
  return { baselinePath, json, knipOutputPath, production };
}

/**
 * `null` when missing or unparseable.
 *
 * @param {string} baselinePath
 * @returns {{ kernelVersion?: string, rows?: Array<{file: string, symbol: string}> } | null}
 */
export function loadBaseline(baselinePath) {
  try {
    if (!fs.existsSync(baselinePath)) return null;
    const raw = fs.readFileSync(baselinePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Diff two row sets by `(file, symbol)`, sorted for stable output.
 *
 * @param {Array<{ file: string, symbol: string }>} baselineRows
 * @param {Array<{ file: string, symbol: string }>} currentRows
 * @returns {{
 *   added: Array<{ file: string, symbol: string }>,
 *   removed: Array<{ file: string, symbol: string }>,
 * }}
 */
export function diffRows(baselineRows, currentRows) {
  const key = (r) => `${r.file}\0${r.symbol}`;
  const baselineSet = new Set((baselineRows ?? []).map(key));
  const currentSet = new Set((currentRows ?? []).map(key));
  const added = (currentRows ?? []).filter((r) => !baselineSet.has(key(r)));
  const removed = (baselineRows ?? []).filter((r) => !currentSet.has(key(r)));
  const sortFn = (a, b) =>
    a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol);
  return {
    added: added.sort(sortFn),
    removed: removed.sort(sortFn),
  };
}

/**
 * `+`/`-` rows then a summary line. `label` tells the two back-to-back passes
 * apart in CI logs.
 *
 * @param {{ added: Array, removed: Array }} diff
 * @param {string} [label='dead-exports']
 * @returns {string}
 */
export function renderDiff(diff, label = 'dead-exports') {
  const lines = [];
  for (const r of diff.added) lines.push(`+ ${r.file}: ${r.symbol}`);
  for (const r of diff.removed) lines.push(`- ${r.file}: ${r.symbol}`);
  const tag = diff.added.length > 0 ? '(gate fail)' : '(ok)';
  lines.push(
    `[${label}] added=${diff.added.length} removed=${diff.removed.length} ${tag}`,
  );
  return lines.join('\n');
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   runKnipImpl?: typeof runKnip,
 *   loadBaselineImpl?: typeof loadBaseline,
 * }} [opts]
 * @returns {Promise<number>} exit code: 0 = clean or removals-only; 1 = added exports detected
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  runKnipImpl = runKnip,
  loadBaselineImpl = loadBaseline,
} = {}) {
  const { baselinePath, json, knipOutputPath, production } = parseArgv(argv);
  const {
    mode,
    label,
    baseline: defaultBaseline,
  } = resolveDeadExportsMode(production);
  const resolvedBaselinePath = path.resolve(
    cwd,
    baselinePath ?? defaultBaseline,
  );
  const baseline = loadBaselineImpl(resolvedBaselinePath);
  const baselineRows = Array.isArray(baseline?.rows) ? baseline.rows : [];

  let knipEnvelope = null;
  let knipError = null;
  if (knipOutputPath) {
    knipEnvelope = readKnipOutput(path.resolve(cwd, knipOutputPath));
    if (!knipEnvelope) knipError = `failed to read ${knipOutputPath}`;
  } else {
    const result = runKnipImpl({ cwd, production });
    if (result.ok) {
      knipEnvelope = result.envelope;
    } else {
      knipError = result.error;
    }
  }

  const currentRows = extractRowsFromKnip(knipEnvelope);
  const diff = diffRows(baselineRows, currentRows);

  const exitCode = knipError === null && diff.added.length > 0 ? 1 : 0;

  if (json) {
    const envelope = {
      kind: 'dead-exports-report',
      mode,
      baselinePath: resolvedBaselinePath,
      baselineRows,
      currentRows,
      added: diff.added,
      removed: diff.removed,
      knipError,
      exitCode,
    };
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    if (!baseline) {
      stderr.write(
        `[${label}] ⚠ baseline not found at ${resolvedBaselinePath} — treating as empty\n`,
      );
    }
    if (knipError) {
      stderr.write(`[${label}] ⚠ knip run failed: ${knipError}\n`);
    }
    stdout.write(`\n--- ${label} preview ---\n`);
    stdout.write(`${renderDiff(diff, label)}\n`);
  }

  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'dead-exports',
  propagateExitCode: true,
  errorPrefix: '[dead-exports] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/check-dead-exports.js [--production] [--baseline <path>] [--knip-output <path>] [--json]',
    summary:
      'Ratchet on unused exports reported by knip: fail when an export is added above the recorded baseline.',
    flags: [
      [
        '--production',
        'Score the production-only surface (separate baseline).',
      ],
      ['--baseline <path>', 'Baseline file (default: mode-specific).'],
      [
        '--knip-output <path>',
        'Read a saved knip JSON envelope instead of running knip.',
      ],
      ['--json', 'Emit the comparison envelope as JSON.'],
    ],
    notes: [
      'Exit codes:\n  0  clean, or removals only\n  1  newly added unused exports',
    ],
  },
});
