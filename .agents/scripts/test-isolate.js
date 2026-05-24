#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * test-isolate — diagnose test-pollution cascades.
 *
 * Runs the matching test files individually (`--test-concurrency=1`,
 * one process per file), then again as a single suite under default
 * concurrency. Files that pass alone but fail in the suite are
 * **flippers**. For each flipper the script binary-bisects the
 * remaining files to surface the smallest reproducing subset (the
 * polluter suspect set).
 *
 * Files whose process exited with leftover `process.env` mutations are
 * called out so an operator can spot global-state leaks at a glance —
 * even when the failure cascade hasn't yet manifested. See
 * `lib/test-isolate/env-snapshot-loader.js`.
 *
 * Usage:
 *
 *   node .agents/scripts/test-isolate.js                   # all tests
 *   node .agents/scripts/test-isolate.js 'tests/lib/**'    # glob subset
 *   node .agents/scripts/test-isolate.js tests/foo.test.js # single file
 *
 * Output: human-readable text by default; pass `--json` for the raw
 * report envelope.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { resolveTestFiles } from './lib/test-isolate/list-files.js';
import { diagnoseIsolation } from './lib/test-isolate/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {string[]} argv
 */
export function parseIsolateArgv(argv) {
  const options = {
    pattern: undefined,
    workers: undefined,
    maxBisectDepth: 8,
    maxBisectTargets: 5,
    suiteConcurrency: 8,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workers' && argv[i + 1]) {
      options.workers = Number(argv[++i]);
    } else if (arg === '--max-bisect-depth' && argv[i + 1]) {
      options.maxBisectDepth = Number(argv[++i]);
    } else if (arg === '--max-bisect-targets' && argv[i + 1]) {
      options.maxBisectTargets = Number(argv[++i]);
    } else if (arg === '--suite-concurrency' && argv[i + 1]) {
      options.suiteConcurrency = Number(argv[++i]);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (!arg.startsWith('--') && !options.pattern) {
      options.pattern = arg;
    }
  }
  return options;
}

/**
 * @param {import('./lib/test-isolate/runner.js').IsolateReport} report
 */
export function renderReport(report) {
  const lines = [];
  lines.push('');
  lines.push('=== test-isolate diagnostic report ===');
  lines.push(`Files scanned:  ${report.files.length}`);
  lines.push(`Wall duration:  ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  if (report.flippers.length === 0) {
    lines.push('✓ No flippers detected — every file that passed alone');
    lines.push('  also passed in the full suite run.');
  } else {
    lines.push(`✗ ${report.flippers.length} flipper(s) detected:`);
    for (const f of report.flippers) {
      lines.push(`  - ${f}`);
    }
    lines.push('');
    if (report.bisections.length > 0) {
      lines.push('Likely polluters (bisection suspects):');
      for (const b of report.bisections) {
        const tag = b.inconclusive ? ' [inconclusive]' : '';
        lines.push(`  ${b.file}${tag}`);
        for (const s of b.suspects) {
          lines.push(`    ← ${s}`);
        }
      }
    }
  }

  lines.push('');
  if (report.envMutators.length === 0) {
    lines.push('✓ No env-var leaks detected across isolated runs.');
  } else {
    lines.push(
      `⚠ ${report.envMutators.length} file(s) left process.env mutated:`,
    );
    for (const m of report.envMutators) {
      const parts = [];
      if (m.envDiff.added.length > 0) {
        parts.push(`added=[${m.envDiff.added.join(', ')}]`);
      }
      if (m.envDiff.removed.length > 0) {
        parts.push(`removed=[${m.envDiff.removed.join(', ')}]`);
      }
      if (m.envDiff.changed.length > 0) {
        parts.push(`changed=[${m.envDiff.changed.join(', ')}]`);
      }
      lines.push(`  ${m.file}`);
      lines.push(`    ${parts.join(' ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Programmatic entry — wired up by the CLI and exported for tests.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.repoRoot]
 * @param {(line: string) => void} [opts.onLog]
 * @returns {Promise<{ exitCode: number, report: import('./lib/test-isolate/runner.js').IsolateReport }>}
 */
export async function runTestIsolate({
  argv = process.argv.slice(2),
  repoRoot = ROOT,
  onLog = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const options = parseIsolateArgv(argv);
  const files = resolveTestFiles({
    pattern: options.pattern,
    repoRoot,
  });
  if (files.length === 0) {
    onLog(
      `[test-isolate] no test files matched pattern: ${options.pattern ?? '<default>'}`,
    );
    return { exitCode: 0, report: emptyReport() };
  }

  if (!options.quiet) {
    onLog(`[test-isolate] scanning ${files.length} file(s)...`);
  }
  const report = await diagnoseIsolation({
    repoRoot,
    files,
    workers: options.workers,
    suiteConcurrency: options.suiteConcurrency,
    maxBisectDepth: options.maxBisectDepth,
    maxBisectTargets: options.maxBisectTargets,
    onProgress: options.quiet
      ? undefined
      : (stage, payload) => {
          if (stage === 'isolated:start') {
            onLog(`[test-isolate] isolated phase: ${payload.count} file(s)`);
          } else if (stage === 'isolated:done') {
            onLog('[test-isolate] isolated phase: done');
          } else if (stage === 'suite:start') {
            onLog(`[test-isolate] suite phase: ${payload.count} file(s)`);
          } else if (stage === 'suite:done') {
            onLog('[test-isolate] suite phase: done');
          } else if (stage === 'bisect:start') {
            onLog(`[test-isolate] bisecting flipper: ${payload.target}`);
          } else if (stage === 'bisect:done') {
            const list = payload.suspects.slice(0, 3).join(', ');
            const more =
              payload.suspects.length > 3
                ? ` (+${payload.suspects.length - 3} more)`
                : '';
            onLog(`[test-isolate]   suspects: ${list}${more}`);
          }
        },
  });

  if (options.json) {
    onLog(JSON.stringify(report, null, 2));
  } else {
    onLog(renderReport(report));
  }

  const exitCode =
    report.flippers.length === 0 && report.envMutators.length === 0 ? 0 : 1;
  return { exitCode, report };
}

function emptyReport() {
  return {
    pattern: null,
    files: [],
    isolated: [],
    suite: [],
    flippers: [],
    bisections: [],
    envMutators: [],
    durationMs: 0,
  };
}

runAsCli(
  import.meta.url,
  async () => {
    const { exitCode } = await runTestIsolate();
    if (exitCode !== 0) process.exit(exitCode);
  },
  { source: 'test-isolate' },
);
