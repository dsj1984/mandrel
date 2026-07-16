/**
 * CLI: ratchet-down dead-export gate built on knip.
 *
 * Story #1852 (Epic #1831) shipped the advisory form. Story #3627 (Epic #3599)
 * converts it to a **ratchet-down gate**: exit 1 when `added.length > 0`
 * (new dead exports are not allowed), exit 0 when the diff is clean or when
 * only removals are detected (the baseline is shrinking, which is the success
 * signal). Knip spawn failures remain advisory (exit 0 + stderr warning) so a
 * misconfigured knip installation cannot block CI when we have no current
 * snapshot to compare against.
 *
 * Story #4575 adds the **production pass** (`--production`), the test-only-
 * importer discount: default mode counts a test as an importer, so
 * production-dead code hides behind its own tests. See
 * `lib/dead-exports-mode.js` for why the two passes carry separate baselines.
 *
 * Contract:
 *   - Reads the committed baseline at `baselines/dead-exports.json` — or
 *     `baselines/dead-exports-production.json` under `--production`
 *     (override either with `--baseline <path>`). Envelope shape:
 *       { $schema, kernelVersion, generatedAt, rows: [{ file, symbol }] }
 *   - Spawns `npx knip --reporter json --no-progress` (plus `--production`),
 *     parses stdout, extracts `{ file, symbol }` rows from `issues[].exports[]`.
 *   - Diffs current vs. baseline by `(file, symbol)` identity.
 *   - Prints `+ <file>: <symbol>` for each added dead export and
 *     `- <file>: <symbol>` for each removed one, then a summary line.
 *   - With `--json`: writes the structured envelope to stdout and skips the
 *     human summary. The envelope still includes `added`, `removed`,
 *     `baselineRows`, `currentRows`, and `exitCode`.
 *   - Exit codes: 0 = clean or removals-only; 1 = added exports detected.
 *     Knip spawn/parse failure exits 0 (advisory) with a stderr warning.
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
 * Parse argv for `--baseline <path>`, `--json`, `--knip-output <path>`, and
 * `--production`. `--knip-output` is a test seam: pass a pre-captured knip JSON
 * file instead of spawning knip. Exported so unit tests can pin the parser.
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
 * Pure helper: read a baseline envelope from disk. Returns the parsed object
 * or `null` when the file is missing or unparseable. Exported for tests so
 * they can feed fixture paths.
 *
 * @param {string} baselinePath
 * @returns {{ kernelVersion?: string, generatedAt?: string, rows?: Array<{file: string, symbol: string}> } | null}
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
 * Pure helper: diff two `{ file, symbol }` row sets. Returns `added` (in
 * current but not baseline) and `removed` (in baseline but not current).
 * Identity is `<file>\0<symbol>`. Exported as the AC's "diff helper" — the
 * sibling test exercises both the added and removed branches against fixture
 * baselines without spawning knip.
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
  // Sort deterministically so output is stable across runs.
  const sortFn = (a, b) =>
    a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol);
  return {
    added: added.sort(sortFn),
    removed: removed.sort(sortFn),
  };
}

/**
 * Pure helper: render the human-readable diff. Lines:
 *   `+ <file>: <symbol>` for added rows
 *   `- <file>: <symbol>` for removed rows
 * Followed by a one-line summary even on a clean diff so operators see the
 * "no drift" signal. When added rows are present the summary includes a
 * "(gate fail)" marker so the ratchet violation is visible in CI output.
 *
 * `label` distinguishes the two passes in CI logs, which run back to back and
 * would otherwise emit two identical-looking summaries.
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
 * Top-level CLI entry. Exported so tests can drive the full pipeline through
 * injected hooks without spawning knip.
 *
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

  // Ratchet-down gate: fail when new dead exports are introduced. Removals are
  // the success signal (baseline shrinking). Knip spawn failures stay advisory
  // so a misconfigured knip installation cannot block CI without a snapshot.
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
});
