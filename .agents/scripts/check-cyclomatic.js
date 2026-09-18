/**
 * CLI: ratchet on the fixed cyclomatic ceiling of 12 against
 * `baselines/cyclomatic.json`. Scores every function in the maintainability
 * gate's `targetDirs` with the in-repo escomplex kernel — no coverage artifact,
 * so it works on a cold checkout. Exit 1 when a file gains an over-ceiling
 * function or its worst function worsens.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import {
  buildCyclomaticEnvelope,
  DEFAULT_CYCLOMATIC_BASELINE,
  diffCyclomaticRows,
  renderCyclomaticDiff,
  resolveCyclomaticPolicy,
  scanCyclomatic,
} from './lib/cyclomatic-ceiling.js';
import { resolveScanScope } from './lib/cyclomatic-scope.js';

/**
 * @param {string[]} argv
 * @returns {{ baselinePath: string | null, json: boolean, update: boolean }}
 */
function parseArgv(argv = []) {
  let baselinePath = null;
  let json = false;
  let update = false;
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
    } else if (a === '--update') {
      update = true;
    }
  }
  return { baselinePath, json, update };
}

/**
 * `null` when missing or unparseable — treated as empty, so a first run
 * reports every breach rather than silently passing.
 *
 * @param {string} baselinePath
 * @returns {{ ceiling?: number, rows?: Array<object> } | null}
 */
function loadCyclomaticBaseline(baselinePath) {
  try {
    if (!fs.existsSync(baselinePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `--update`: the only way the recorded breach count may rise.
 *
 * @param {{ scan: object, ceiling: number, baselinePath: string, writeFileImpl: Function, stdout: { write: (s: string) => void } }} args
 * @returns {number} Always 0 — writing a baseline cannot fail the ratchet.
 */
function writeUpdatedBaseline({
  scan,
  ceiling,
  baselinePath,
  writeFileImpl,
  stdout,
}) {
  const envelope = buildCyclomaticEnvelope({ rows: scan.rows, ceiling });
  writeFileImpl(baselinePath, `${JSON.stringify(envelope, null, 2)}\n`);
  stdout.write(
    `[cyclomatic] wrote ${scan.rows.length} breach row(s) at ceiling c=${ceiling} to ${baselinePath}\n`,
  );
  return 0;
}

/**
 * @param {{ policy: object, baseline: object|null, baselineRows: Array<object>, baselinePath: string, scan: object, diff: object, exitCode: number }} args
 * @returns {string}
 */
function renderJsonReport({
  policy,
  baseline,
  baselineRows,
  baselinePath,
  scan,
  diff,
  exitCode,
}) {
  return `${JSON.stringify(
    {
      kind: 'cyclomatic-report',
      ceiling: policy.mustFix,
      flag: policy.flag,
      baselinePath,
      baselineCeiling: baseline?.ceiling ?? null,
      scannedFiles: scan.scannedFiles,
      parseErrors: scan.parseErrors,
      baselineRows,
      currentRows: scan.rows,
      ...diff,
      exitCode,
    },
    null,
    2,
  )}\n`;
}

/**
 * Warn (not fail) on an absent baseline or one recorded at another ceiling,
 * so a meaningless verdict is never read as clean.
 *
 * @param {{ baseline: object|null, mustFix: number, baselinePath: string, stderr: { write: (s: string) => void } }} args
 * @returns {void}
 */
function warnAboutBaseline({ baseline, mustFix, baselinePath, stderr }) {
  if (!baseline) {
    stderr.write(
      `[cyclomatic] ⚠ baseline not found at ${baselinePath} — treating as empty\n`,
    );
    return;
  }
  if (typeof baseline.ceiling === 'number' && baseline.ceiling !== mustFix) {
    stderr.write(
      `[cyclomatic] ⚠ baseline was recorded at ceiling c=${baseline.ceiling} but the enforced ceiling is c=${mustFix} — re-run with --update\n`,
    );
  }
}

/**
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   resolveConfigImpl?: typeof resolveConfig,
 *   scanImpl?: typeof scanCyclomatic,
 *   loadBaselineImpl?: typeof loadCyclomaticBaseline,
 *   writeFileImpl?: (p: string, data: string) => void,
 * }} [opts]
 * @returns {Promise<number>} 0 = clean / improved; 1 = ratchet breached
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  resolveConfigImpl = resolveConfig,
  scanImpl = scanCyclomatic,
  loadBaselineImpl = loadCyclomaticBaseline,
  writeFileImpl = (p, data) => fs.writeFileSync(p, data),
} = {}) {
  const { baselinePath, json, update } = parseArgv(argv);
  const config = resolveConfigImpl({ cwd });
  const quality = getQuality(config);
  const policy = resolveCyclomaticPolicy(quality);
  const resolvedBaselinePath = path.resolve(
    cwd,
    baselinePath ?? DEFAULT_CYCLOMATIC_BASELINE,
  );

  // Before scanning: baseline rows are half the scan scope. `--update` and
  // `BASELINE_SCOPE=full` scan the whole tree.
  const baseline = loadBaselineImpl(resolvedBaselinePath);
  const baselineRows = Array.isArray(baseline?.rows) ? baseline.rows : [];
  const scopeFiles = resolveScanScope({ cwd, config, update, baselineRows });

  const scan = scanImpl({
    targetDirs: policy.targetDirs,
    ignoreGlobs: policy.ignoreGlobs,
    ceiling: policy.mustFix,
    cwd,
    scopeFiles,
  });

  if (update) {
    return writeUpdatedBaseline({
      scan,
      ceiling: policy.mustFix,
      baselinePath: resolvedBaselinePath,
      writeFileImpl,
      stdout,
    });
  }

  const diff = diffCyclomaticRows(baselineRows, scan.rows);
  const exitCode = diff.added.length + diff.worsened.length > 0 ? 1 : 0;

  if (json) {
    stdout.write(
      renderJsonReport({
        policy,
        baseline,
        baselineRows,
        baselinePath: resolvedBaselinePath,
        scan,
        diff,
        exitCode,
      }),
    );
    return exitCode;
  }

  warnAboutBaseline({
    baseline,
    mustFix: policy.mustFix,
    baselinePath: resolvedBaselinePath,
    stderr,
  });
  stdout.write('\n--- cyclomatic preview ---\n');
  stdout.write(`${renderCyclomaticDiff(diff, policy.mustFix)}\n`);
  return exitCode;
}

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
  source: 'cyclomatic',
  propagateExitCode: true,
  errorPrefix: '[cyclomatic] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/check-cyclomatic.js [--baseline <path>] [--update] [--json]',
    summary:
      'Ratchet on cyclomatic complexity: fail when a file gains a function above the fixed ceiling of 12, or when its worst function gets worse than the recorded baseline.',
    flags: [
      [
        '--baseline <path>',
        'Baseline file (default: baselines/cyclomatic.json).',
      ],
      [
        '--update',
        'Rewrite the baseline from the current tree (the post-refactor motion).',
      ],
      ['--json', 'Emit the comparison envelope as JSON.'],
    ],
    notes: [
      'Exit codes:\n  0  clean, improved, or shrinking\n  1  a new or worsened over-ceiling function',
    ],
  },
});
