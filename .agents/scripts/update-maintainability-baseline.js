/**
 * update-maintainability-baseline.js — manual refresh CLI for the
 * maintainability baseline.
 *
 * Story #2202 / Task #2215 (Epic #2173): this CLI is now a thin wrapper
 * around `refreshBaseline({ kind: 'maintainability' })` from
 * `.agents/scripts/lib/baselines/refresh-service.js`. All scoring, scope
 * resolution, envelope assembly, and persistence flows through the unified
 * service.
 *
 * Surface:
 *
 *   - `--diff-scope <ref>` (or `--diff-scope=<ref>`): explicitly scope the
 *     refresh to files changed between `<ref>` and HEAD. Out-of-scope rows
 *     are preserved byte-for-byte from the prior on-disk baseline.
 *   - With no flag: scope is derived from `git diff --name-only
 *     origin/main..HEAD` (the service's default `baseRef..headRef`).
 *     Operators wanting a full rewrite must pass `--full-scope` (added by
 *     Task #2214; see that Task's notes for the cut-over).
 *
 * The scoring step (escomplex / typhonjs maintainability index) is
 * injected as a scorer function via the service's `opts.scorer` seam.
 * Full-scope refreshes (`scope.mode === 'full'`) walk every configured
 * target directory; diff/explicit refreshes score only the files the
 * service hands in. This keeps the manual CLI byte-identical (per
 * AC-3 — see Task #2212's byte-identity test) to whatever code path
 * story-close would have produced for the same scope.
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { filterExcludedRows } from './lib/baselines/kinds/maintainability.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  getBaselines,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { calculateAll, scanDirectory } from './lib/maintainability-utils.js';

/**
 * Parse `--full-scope` (boolean opt-out flag).
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function parseFullScopeFlag(argv = []) {
  return argv.includes('--full-scope');
}

/**
 * Build the per-kind scorer the service will invoke. The scorer receives
 * `(files, { fullScope })`:
 *
 *   - `fullScope === true`: ignore `files`, walk every configured target
 *     directory, score every supported source file, return rows.
 *   - `fullScope === false`: `files` is the resolved (diff or explicit)
 *     scope. Score only those that fall under a configured target
 *     directory; rows outside that set are dropped (the service / writer
 *     preserves their prior-on-disk entries verbatim).
 *
 * The scorer is `cwd`-aware: the service passes its `cwd` through so all
 * path normalisation stays consistent with diff-scope derivation.
 */
function buildMaintainabilityScorer({ targetDirs, ignoreGlobs = [], logger }) {
  return async function maintainabilityScorer(files, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    let absPaths;
    if (opts?.fullScope) {
      absPaths = [];
      for (const dir of targetDirs) {
        const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
        logger.info(`[Maintainability] Scanning ${dir}...`);
        scanDirectory(abs, absPaths, { cwd, ignoreGlobs });
      }
    } else {
      // Files come in as canonical POSIX repo-relative paths from the
      // service. Resolve to absolute paths for the scorer, but only keep
      // the ones that fall under a configured target dir — rows outside
      // those roots are the gate's responsibility, not the baseline's.
      const targetAbsDirs = targetDirs.map((dir) =>
        path.isAbsolute(dir) ? dir : path.resolve(cwd, dir),
      );
      absPaths = [];
      for (const rel of files ?? []) {
        const abs = path.resolve(cwd, rel);
        const underTarget = targetAbsDirs.some(
          (root) => abs === root || abs.startsWith(`${root}${path.sep}`),
        );
        if (underTarget) absPaths.push(abs);
      }
    }

    logger.info(
      `[Maintainability] Calculating scores for ${absPaths.length} files...`,
    );
    const scores = await calculateAll(absPaths);
    const rows = Object.entries(scores).map(([p, mi]) => ({ path: p, mi }));
    // Story #2467 / Task #2494: drop files the escomplex kernel can't parse
    // so they stop landing as `mi: 0` phantom entries in the baseline.
    return filterExcludedRows(rows);
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const diffScopeRef = parseDiffScopeFlag(argv);
  const fullScope = parseFullScopeFlag(argv);

  if (fullScope && diffScopeRef !== null) {
    throw new Error(
      '[Maintainability] --full-scope is incompatible with --diff-scope; pick one',
    );
  }

  const config = resolveConfig();
  const miQuality = getQuality(config).maintainability;
  const targetDirs = miQuality.targetDirs;
  const ignoreGlobs = miQuality.ignoreGlobs ?? [];
  const baselinePath = getBaselines(config).maintainability.path;
  const absBaselinePath = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
  const epsilon = getBaselineEpsilon('maintainability', config);

  Logger.info('[Maintainability] Updating baseline...');
  if (fullScope) {
    Logger.info(
      '[Maintainability] --full-scope: regenerating every row (out-of-scope merge disabled).',
    );
  } else if (diffScopeRef) {
    Logger.info(
      `[Maintainability] --diff-scope ${diffScopeRef}: narrowing to changed files; out-of-scope rows preserved verbatim.`,
    );
  }

  const scorer = buildMaintainabilityScorer({
    targetDirs,
    ignoreGlobs,
    logger: Logger,
  });

  // Task #2214 (Epic #2173, AC-2): flag-omission now defaults to
  // diff-scope. The pre-migration default was a full regenerate; operators
  // wanting that behaviour must now pass `--full-scope` explicitly. This is
  // a deliberate breaking CLI behaviour change — see docs/CHANGELOG.md.
  const refreshOpts = {
    kind: 'maintainability',
    writePath: absBaselinePath,
    epsilon,
    scorer,
  };
  if (fullScope) {
    refreshOpts.fullScope = true;
  } else if (diffScopeRef) {
    // The CLI's documented `--diff-scope <ref>` semantics are
    // `<ref>...HEAD` (three-dot). The service derives via two-dot
    // `baseRef..headRef`; pass the ref as `baseRef` so the service's
    // diff-derivation does the heavy lifting through the same execFile
    // seam that auto-refresh uses.
    refreshOpts.baseRef = diffScopeRef;
  }
  // No flag → scopeFiles=null + fullScope=false → service derives the
  // diff via `origin/main..HEAD` (its default baseRef/headRef).

  const result = await refreshBaseline(refreshOpts);

  Logger.info(
    `[Maintainability] ✅ Baseline updated successfully at ${absBaselinePath} (kernelVersion=${result.envelope.kernelVersion}, wrote=${result.wrote}, scope=${result.scope.mode}).`,
  );
}

// cli-opt-out: top-level main().catch predates runAsCli; never imported elsewhere so the auto-run risk is moot.
main().catch((err) => {
  Logger.error(`[Maintainability] ❌ Fatal error: ${err.message}`);
  process.exit(1);
});
