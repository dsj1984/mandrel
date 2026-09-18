/**
 * Refresh the maintainability baseline via `refreshBaseline({ kind:
 * 'maintainability' })`. No scorer is injected: the service's default applies
 * `ignoreGlobs` on both the full walk and the diff-scope branch.
 */

// Must be the first import: fails fast before any third-party import loads.
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getBaselines, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
const USAGE = {
  invocation:
    'node .agents/scripts/update-maintainability-baseline.js [--full-scope | --diff-scope <ref>]',
  summary:
    'Score → write the maintainability baseline. With no scope flag the refresh is scoped to the files changed in `origin/main..HEAD`; out-of-scope rows are preserved verbatim.',
  flags: [
    [
      '--full-scope',
      'Rescore every file in every target dir (no out-of-scope merge).',
    ],
    [
      '--diff-scope <ref>',
      'Scope the refresh to files changed between <ref> and HEAD. Incompatible with --full-scope.',
    ],
  ],
};

/**
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
  const epsilon = getBaselineEpsilon('maintainability');

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

  const refreshOpts = {
    kind: 'maintainability',
    writePath: absBaselinePath,
    epsilon,
  };
  if (fullScope) {
    refreshOpts.fullScope = true;
  } else if (diffScopeRef) {
    // The service derives two-dot `baseRef..headRef`, like auto-refresh.
    refreshOpts.baseRef = diffScopeRef;
  }
  // No flag: the service derives the diff from `origin/main..HEAD`.

  const result = await refreshBaseline(refreshOpts);

  Logger.info(
    `[Maintainability] ✅ Baseline updated successfully at ${absBaselinePath} (kernelVersion=${result.envelope.kernelVersion}, wrote=${result.wrote}, scope=${result.scope.mode}).`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'maintainability-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(`[Maintainability] ❌ Fatal error: ${err.message}`);
    process.exitCode = 1;
  },
});
