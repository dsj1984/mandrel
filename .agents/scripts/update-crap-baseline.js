// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import {
  buildCrapUpdaterScorer,
  parseCrapUpdaterArgs,
  resolveCrapUpdaterOptions,
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
 * CLI: scan → score → save the CRAP baseline.
 *
 * Story #3658 (Epic #2173): this CLI is now a thin wrapper around
 * `refreshBaseline({ kind: 'crap' })` from
 * `.agents/scripts/lib/baselines/refresh-service.js`. All scoring, scope
 * resolution, envelope assembly, and persistence flows through the unified
 * service.
 *
 * Writes the canonical CRAP baseline at the path resolved from
 * `delivery.quality.baselines.crap.path` (default `baselines/crap.json`),
 * or the path supplied via `--baseline <path>`. Output is a deterministic,
 * kernel-stamped envelope. Files without coverage entries are skipped (not
 * scored as 0%) when `requireCoverage: true` — their count and names are
 * logged so the operator can tell the difference between "unscorable" and
 * "safe zero".
 *
 * Exits non-zero only when the scanner itself crashes. An empty result (no
 * coverage at all, no scored methods) still writes an envelope with `rows: []`
 * so downstream `check-crap` can tell "intentional empty baseline" apart from
 * "no baseline yet".
 */

/**
 * Usage block for `--help` (Story #4872). This CLI *writes* on invocation, so
 * the help branch must short-circuit before `main` runs rather than inside it —
 * `runAsCli` answers help first, which makes "a usage probe never mutates a
 * baseline" structural instead of a check `main` has to remember.
 */
const USAGE = {
  invocation:
    'node .agents/scripts/update-crap-baseline.js [--baseline <path>] [--coverage <path>] [--full-scope | --diff-scope <ref>]',
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
    epsilon: getBaselineEpsilon('crap', config),
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

runAsCli(import.meta.url, main, {
  source: 'crap-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(`[CRAP] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`);
    process.exitCode = 1;
  },
});
