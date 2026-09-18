#!/usr/bin/env node

/**
 * CLI: the deterministic evidence half of `/audit-baselines` — ranked hotspot
 * clusters, gate health, trends and floor headroom from `baselines/`.
 * Read-only: writes only the `--out` envelope. Degraded inputs still exit 0;
 * only a missing or unwritable `--out` fails.
 */

// Must be the first import: fail fast before any third-party import evaluates.
import './lib/runtime-deps/ensure-installed.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_HOTSPOT_LIMIT,
  runEngine,
  summarize,
} from './lib/audit-baselines/engine.js';
import { DEFAULT_TOP_N } from './lib/audit-baselines/outliers.js';
import { buildBaselineSchemaAjv } from './lib/baseline-schema-registry.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';

const ENVELOPE_SCHEMA_FILE = 'audit-baselines-envelope.schema.json';

const FLAG_SPEC = {
  out: { type: 'string' },
  cwd: { type: 'string' },
  'top-n': { type: 'integer' },
  'hotspot-limit': { type: 'integer' },
  'trend-depth': { type: 'integer' },
};

/**
 * Throws on a schema mismatch — a malformed envelope is an engine bug.
 *
 * @param {object} envelope
 * @returns {void}
 */
export function assertEnvelope(envelope) {
  const validate = buildBaselineSchemaAjv().getSchema(ENVELOPE_SCHEMA_FILE);
  if (!validate) {
    throw new Error(
      `[audit-baselines] ${ENVELOPE_SCHEMA_FILE} is not registered in the baseline schema registry`,
    );
  }
  if (validate(envelope)) return;
  const detail = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
  throw new Error(
    `[audit-baselines] envelope failed schema validation: ${detail}`,
  );
}

/**
 * @param {{ argv?: string[], cwd?: string, stdout?: { write: (s: string) => void } }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const { values } = defineFlags(FLAG_SPEC, argv);
  if (!values.out) {
    throw new Error('[audit-baselines] --out <path> is required');
  }
  const repoRoot = path.resolve(values.cwd ?? cwd);
  const outPath = path.resolve(repoRoot, values.out);

  const envelope = runEngine({
    cwd: repoRoot,
    topN: values.topN ?? DEFAULT_TOP_N,
    hotspotLimit: values.hotspotLimit ?? DEFAULT_HOTSPOT_LIMIT,
    trendDepth: values.trendDepth ?? 5,
  });
  assertEnvelope(envelope);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  stdout.write(`${JSON.stringify(summarize(envelope, outPath), null, 2)}\n`);
  return 0;
}

runAsCli(import.meta.url, async () => runCli(), {
  source: 'audit-baselines',
  propagateExitCode: true,
  errorPrefix: '[audit-baselines] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/audit-baselines.js --out <path> [--cwd <dir>] [--top-n <n>] [--hotspot-limit <n>] [--trend-depth <n>]',
    summary:
      'Read-only baseline hotspot engine: extract bounded per-gate outliers, cluster them per file, rank by severity x churn x import in-degree x friction, and report gate-surface health, trend deltas, and floor headroom.',
    flags: [
      ['--out <path>', 'Write the JSON envelope here (required).'],
      ['--cwd <dir>', 'Repository root to analyse (default: cwd).'],
      [
        '--top-n <n>',
        `Outlier rows extracted per gate (default: ${DEFAULT_TOP_N}).`,
      ],
      [
        '--hotspot-limit <n>',
        `Hotspot clusters emitted (default: ${DEFAULT_HOTSPOT_LIMIT}).`,
      ],
      ['--trend-depth <n>', 'Baseline commits sampled per kind (default: 5).'],
    ],
    notes: [
      'Never writes under baselines/ and never runs a test, coverage, or mutation suite.',
      'Exit codes:\n  0  evidence assembled (including every degraded input)\n  1  the envelope could not be built or written',
    ],
  },
});
