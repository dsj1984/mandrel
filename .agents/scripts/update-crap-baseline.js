// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
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
  checkResolutionFloor,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
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

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    baselinePath: undefined,
    coveragePath: undefined,
    fullScope: false,
    diffScopeRef: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--coverage' && argv[i + 1]) {
      out.coveragePath = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--full-scope') {
      out.fullScope = true;
    }
  }
  out.diffScopeRef = parseDiffScopeFlag(argv);
  return out;
}

async function main() {
  const args = parseCliArgs();
  const config = resolveConfig();
  const crap = getQuality(config).crap;
  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const requireCoverage = crap.requireCoverage !== false;
  const minMethodResolutionRate = crap.minMethodResolutionRate ?? 0.75;
  const coveragePath =
    args.coveragePath ?? crap.coveragePath ?? 'coverage/coverage-final.json';
  const baselinePath = args.baselinePath ?? getBaselines(config).crap.path;
  const ignoreGlobs = Array.isArray(crap.ignoreGlobs) ? crap.ignoreGlobs : [];

  Logger.info('[CRAP] Updating baseline...');
  Logger.info(`[CRAP] Target dirs: ${targetDirs.join(', ')}`);
  Logger.info(
    `[CRAP] Coverage source: ${coveragePath}${requireCoverage ? ' (required)' : ' (optional)'}`,
  );

  const absBaselinePath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);

  if (args.fullScope && args.diffScopeRef !== null) {
    throw new Error(
      '[CRAP] --full-scope is incompatible with --diff-scope; pick one',
    );
  }

  // Build the per-kind scorer the service will invoke. The scorer receives
  // `(files, { fullScope, cwd })`:
  //   - fullScope === true:  walk all target dirs; scopeFiles=null passed to scanAndScore.
  //   - fullScope === false: score only the diff-derived in-scope files.
  const scorer = async (files, opts) => {
    const effectiveCwd = opts?.cwd ?? process.cwd();
    const coverageAbs = path.isAbsolute(coveragePath)
      ? coveragePath
      : path.resolve(effectiveCwd, coveragePath);
    const coverage = loadCoverage(coverageAbs);
    if (!coverage && requireCoverage) {
      Logger.warn(
        `[CRAP] ⚠ No coverage artifact at ${coveragePath}. All files will be skipped under requireCoverage=true.`,
      );
      Logger.warn(
        "[CRAP] ⚠ Run 'npm run test:coverage' before 'npm run crap:update'.",
      );
      return [];
    }
    const scopeFiles = opts?.fullScope ? null : (files ?? null);
    const {
      rows,
      scannedFiles,
      skippedFilesNoCoverage,
      skippedMethodsNoCoverage,
      unscorableFiles,
      resolution,
    } = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage,
      cwd: effectiveCwd,
      ignoreGlobs,
      scopeFiles,
    });

    Logger.info(`[CRAP] Scanned ${scannedFiles} file(s).`);
    // Each drop counter earns a line only when it moved, so a clean scan stays
    // one line. Story #5311 added `unscorableFiles`: a file the scan could not
    // read, transpile or parse contributes no rows, so without a line of its
    // own the run reads as a clean scan of a tree with fewer methods than it
    // has — which is exactly how the worker path's losses stayed invisible.
    const dropCounters = [
      [skippedFilesNoCoverage, 'file(s) skipped without coverage entries.'],
      [
        skippedMethodsNoCoverage,
        'method(s) skipped — per-method coverage unresolved.',
      ],
      [
        unscorableFiles,
        'file(s) unscorable (read/transpile/parse failure) — no rows contributed.',
      ],
    ];
    for (const [count, what] of dropCounters) {
      if (count > 0) Logger.info(`[CRAP] ${count} ${what}`);
    }
    if (resolution) {
      Logger.info(
        `[CRAP] Method resolution: ${resolution.resolvedMethods}/${resolution.joinableMethods} ` +
          `(${(resolution.rate * 100).toFixed(1)}%) in files with coverage.`,
      );
    }
    // Fail closed BEFORE the service persists anything — a thin baseline is
    // never written and then apologised for.
    const refusal = checkResolutionFloor(resolution, minMethodResolutionRate);
    if (refusal) throw new Error(refusal);

    return (rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };

  const epsilon = getBaselineEpsilon('crap', config);
  const refreshOpts = {
    kind: 'crap',
    writePath: absBaselinePath,
    epsilon,
    scorer,
  };
  if (args.fullScope) {
    refreshOpts.fullScope = true;
  } else if (args.diffScopeRef) {
    refreshOpts.baseRef = args.diffScopeRef;
  }
  // No flag → scopeFiles=null + fullScope=false → service derives the diff
  // via `origin/main..HEAD` (its default baseRef/headRef).

  const result = await refreshBaseline(refreshOpts);

  const escomplexVersion = resolveEscomplexVersion();
  const tsTranspilerVersion = resolveTsTranspilerVersion();
  Logger.info(
    `[CRAP] ✅ Baseline updated (kernelVersion=${result.envelope.kernelVersion}, escomplexVersion=${escomplexVersion}, tsTranspilerVersion=${tsTranspilerVersion}). Wrote to ${absBaselinePath}.`,
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
