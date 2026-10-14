#!/usr/bin/env node
/**
 * Refresh the bundle-size baseline via `refreshBaseline({ kind:
 * 'bundle-size' })`: weigh every `gates['bundle-size'].bundles[]` artifact
 * already on disk. Scope is always full — bundle names are not paths, so no
 * diff can narrow it. Never builds the project.
 */

// Must be the first import: fails fast before any third-party import loads.
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

const DEFAULT_BASELINE_PATH = 'baselines/bundle-size.json';

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
const USAGE = {
  invocation: 'node .agents/scripts/update-bundle-size-baseline.js',
  summary:
    'Weigh → write the bundle-size baseline: one row per `delivery.quality.gates.bundle-size.bundles[]` entry, with the raw and gzipped KB of every file its `path` glob matches. Always a full refresh.',
  notes: [
    'Build the project first — this script never builds, and a declared bundle that matches no file fails the refresh rather than recording 0 KB.',
  ],
};

async function main() {
  const cwd = process.cwd();
  const gate = getQuality(resolveConfig({ cwd })).gates?.['bundle-size'] ?? {};
  const baselinePath = gate.baselinePath ?? DEFAULT_BASELINE_PATH;
  const writePath = path.resolve(cwd, baselinePath);

  Logger.info('[BundleSize] Updating baseline...');
  const result = await refreshBaseline({
    kind: 'bundle-size',
    cwd,
    fullScope: true,
    writePath,
    epsilon: getBaselineEpsilon('bundle-size'),
  });
  Logger.info(
    `[BundleSize] ✅ Baseline updated: ${result.envelope.rows.length} bundle(s) recorded at ${baselinePath}, wrote=${result.wrote}.`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'bundle-size-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(`[BundleSize] ❌ Fatal error: ${err?.message ?? err}`);
    process.exitCode = 1;
  },
});
