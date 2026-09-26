// Must be the first import: fails fast before any third-party import loads.
import './lib/runtime-deps/ensure-installed.js';
import {
  buildCrapUpdaterScorer,
  parseCrapUpdaterArgs,
  resolveCrapUpdaterOptions,
  seatCrapBaseline,
} from './lib/baselines/crap-updater-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { loadCoverage } from './lib/coverage-utils.js';
import {
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
} from './lib/crap-utils.js';

import { Logger } from './lib/Logger.js';

/**
 * Refresh the CRAP baseline via `refreshBaseline({ kind: 'crap' })`. Under
 * `requireCoverage` an uncovered file is skipped and logged, never scored as
 * 0%. An empty result still writes `rows: []`, so an intentional empty
 * baseline differs from a missing one.
 */

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
const USAGE = {
  invocation:
    'node .agents/scripts/update-crap-baseline.js [--baseline <path>] [--coverage <path>] [--full-scope | --diff-scope <ref>] [--seat-missing]',
  summary:
    'Scan → score → write the CRAP baseline. With no scope flag the refresh is scoped to the files changed in `origin/main..HEAD`; out-of-scope rows are preserved verbatim.',
  flags: [
    [
      '--baseline <path>',
      'Write to this path instead of `delivery.quality.baselines.crap.path`.',
    ],
    [
      '--coverage <path>',
      'Read coverage from this path (default `coverage/coverage-final.json`).',
    ],
    [
      '--full-scope',
      'Rescore every file in every target dir (no out-of-scope merge).',
    ],
    [
      '--diff-scope <ref>',
      'Scope the refresh to files changed between <ref> and HEAD. Incompatible with --full-scope.',
    ],
    [
      '--seat-missing',
      'Insert-only: write rows ONLY for methods of changed files (merge-base of `--diff-scope <ref>`, default `origin/<baseBranch>`) that have no baseline row; every existing row stays byte-identical. Refuses unless the coverage capture stamp is fresh and method resolution is 100%. Prints `seated: N`. Incompatible with --full-scope.',
    ],
  ],
  notes: [
    'Run `npm run test:coverage` first — without a coverage artifact every file is skipped.',
  ],
};

async function main() {
  const config = resolveConfig();
  const options = resolveCrapUpdaterOptions(
    parseCrapUpdaterArgs(process.argv.slice(2)),
    { crap: getQuality(config).crap, baselines: getBaselines(config) },
  );

  Logger.info('[CRAP] Updating baseline...');
  Logger.info(`[CRAP] Target dirs: ${options.targetDirs.join(', ')}`);
  Logger.info(
    `[CRAP] Coverage source: ${options.coveragePath}${options.requireCoverage ? ' (required)' : ' (optional)'}`,
  );

  const refreshOpts = {
    kind: 'crap',
    writePath: options.absBaselinePath,
    epsilon: getBaselineEpsilon('crap'),
    scorer: buildCrapUpdaterScorer(options, { loadCoverage }),
  };
  // No flag -> scopeFiles=null + fullScope=false -> the service derives the
  // diff via `origin/main..HEAD` (its default baseRef/headRef).
  if (options.fullScope) refreshOpts.fullScope = true;
  else if (options.diffScopeRef) refreshOpts.baseRef = options.diffScopeRef;

  const result = await refreshBaseline(refreshOpts);

  Logger.info(
    `[CRAP] ✅ Baseline updated (kernelVersion=${result.envelope.kernelVersion}, escomplexVersion=${resolveEscomplexVersion()}, tsTranspilerVersion=${resolveTsTranspilerVersion()}). Wrote to ${options.absBaselinePath}.`,
  );
  Logger.info(
    `[CRAP] Wrote ${result.envelope.rows.length} row(s). scope=${result.scope.mode}, wrote=${result.wrote}.`,
  );
}

async function seat() {
  process.exitCode = await seatCrapBaseline(process.argv.slice(2));
}

const seating = process.argv.includes('--seat-missing');
runAsCli(import.meta.url, seating ? seat : main, {
  source: 'crap-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(`[CRAP] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`);
    process.exitCode = 1;
  },
});
