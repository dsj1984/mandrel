#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * Capture TAP timing from the full test suite and write a human summary under
 * `temp/` (gitignored). Skips npm-test preflight so timings reflect the
 * runner only — set SKIP_PREFLIGHT=0 to include preflight if desired.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { buildWebhookSafeTestEnv } from './lib/test-env.js';
import { parseTapOutput } from './lib/test-profile/parse-tap.js';
import { renderProfileReport } from './lib/test-profile/render-report.js';
import { buildNodeTestArgs } from './run-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'temp');
const TAP_FILE = 'test-profile.tap';
const SUMMARY_FILE = 'test-profile.summary.txt';

/**
 * @param {string[]} argv
 * @returns {{ outDir: string, topN: number, testArgv: string[] }}
 */
export function parseProfileArgv(argv) {
  let outDir = DEFAULT_OUT_DIR;
  let topN = 20;
  const testArgv = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--top' && argv[i + 1]) {
      topN = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    testArgv.push(arg);
  }
  if (!Number.isFinite(topN) || topN < 1) {
    throw new Error('[test-profile] --top must be a positive number');
  }
  return { outDir, topN, testArgv };
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.cwd]
 * @param {typeof spawnSync} [opts.spawn]
 * @param {typeof fs} [opts.fs]
 */
export function runTestProfile({
  argv = process.argv.slice(2),
  cwd = ROOT,
  spawn = spawnSync,
  fs: fsLike = fs,
} = {}) {
  const { outDir, topN, testArgv } = parseProfileArgv(argv);
  fsLike.mkdirSync(outDir, { recursive: true });

  const nodeArgs = [
    ...buildNodeTestArgs({ extraArgs: testArgv }),
    '--test-reporter',
    'tap',
  ];

  const started = Date.now();
  const result = spawn(process.execPath, nodeArgs, {
    cwd,
    encoding: 'utf8',
    env: {
      ...buildWebhookSafeTestEnv(process.env),
      SKIP_PREFLIGHT: process.env.SKIP_PREFLIGHT ?? '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  const wallDurationMs = Date.now() - started;

  if (result.error) {
    throw result.error;
  }

  const tapText = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tapPath = path.join(outDir, TAP_FILE);
  const summaryPath = path.join(outDir, SUMMARY_FILE);
  fsLike.writeFileSync(tapPath, tapText, { encoding: 'utf8' });

  const profile = parseTapOutput(tapText);
  const summary = renderProfileReport(profile, { topN, wallDurationMs });
  fsLike.writeFileSync(summaryPath, summary, { encoding: 'utf8' });

  process.stdout.write(summary);
  process.stdout.write(`\nWrote ${tapPath}\nWrote ${summaryPath}\n`);

  return {
    exitCode: result.status ?? 1,
    tapPath,
    summaryPath,
    profile,
    wallDurationMs,
  };
}

runAsCli(
  import.meta.url,
  async () => {
    const outcome = runTestProfile();
    if (outcome.exitCode !== 0) {
      process.exit(outcome.exitCode);
    }
  },
  { source: 'run-test-profile' },
);
