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
 * Story #4293: the CLI no longer injects a bespoke maintainability scorer.
 * It now lets `refreshBaseline` resolve the canonical default scorer
 * (`buildDefaultMaintainabilityScorer`) the same way `update-crap-baseline.js`
 * and `update-coverage-baseline.js` route through their canonical defaults.
 * The previously-injected `buildMaintainabilityScorer` was a stale copy of the
 * canonical scorer that never received the `ignoreGlobs` fix on its diff-scope
 * branch, so an ignored-but-changed file (e.g. one matched by
 * `config-settings-schema*.js` or a consumer's `seed.mjs`) leaked into `rows`
 * and dragged `rollup["*"].min` below the maintainability floor. The canonical
 * default scorer applies the ignore filter on BOTH the full-scope walk and the
 * diff-scope branch, eliminating the divergence at the source.
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
 * Full-scope refreshes (`scope.mode === 'full'`) walk every configured
 * target directory; diff/explicit refreshes score only the files the
 * service hands in. Both paths drop `ignoreGlobs`-listed files via the
 * canonical default scorer.
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getBaselines, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/**
 * Parse `--full-scope` (boolean opt-out flag).
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function parseFullScopeFlag(argv = []) {
  return argv.includes('--full-scope');
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

  // Task #2214 (Epic #2173, AC-2): flag-omission now defaults to
  // diff-scope. The pre-migration default was a full regenerate; operators
  // wanting that behaviour must now pass `--full-scope` explicitly. This is
  // a deliberate breaking CLI behaviour change — see docs/CHANGELOG.md.
  //
  // Story #4293: no `scorer` is injected — the service resolves the canonical
  // default maintainability scorer, which applies `ignoreGlobs` on both the
  // full-scope walk and the diff-scope branch.
  const refreshOpts = {
    kind: 'maintainability',
    writePath: absBaselinePath,
    epsilon,
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
