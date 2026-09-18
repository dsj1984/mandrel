/**
 * Refresh the duplication baseline via `refreshBaseline({ kind:
 * 'duplication' })`. Scope is a write-side filter only: clone detection is
 * pairwise, so the scan always covers the whole tree. No clones still writes
 * `rows: []`, so an intentional empty baseline differs from a missing one.
 */

// Must be the first import: fails fast before any third-party import loads.
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
const USAGE = {
  invocation:
    'node .agents/scripts/update-duplication-baseline.js [--baseline <path>] [--full-scope | --diff-scope <ref>]',
  summary:
    'Scan → score → write the code-duplication (DRY) baseline. With no scope flag the refresh is scoped to the files changed in `origin/main..HEAD`; out-of-scope rows are preserved verbatim.',
  flags: [
    [
      '--baseline <path>',
      'Write to this path instead of `delivery.quality.gates.duplication.baselinePath`.',
    ],
    [
      '--full-scope',
      'Rescan every file in every target dir (no out-of-scope merge).',
    ],
    [
      '--diff-scope <ref>',
      'Scope the refresh to files changed between <ref> and HEAD. Incompatible with --full-scope.',
    ],
  ],
  notes: [
    'Backed by jscpd; the scan reads the working tree and runs no test suite.',
    'Clone detection is pairwise, so the scan always covers the whole target tree — a scope flag narrows which rows are rewritten, not what is scanned.',
  ],
};

/**
 * @param {string[]} argv
 * @returns {{ baselinePath: string | undefined }}
 */
function parseCliArgs(argv = process.argv.slice(2)) {
  const out = { baselinePath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      out.baselinePath = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
function parseFullScopeFlag(argv = []) {
  return argv.includes('--full-scope');
}

/**
 * @param {object} config
 * @returns {object}
 */
function resolveDuplicationGate(config) {
  const gates = getQuality(config).gates ?? {};
  return gates.duplication ?? {};
}

/**
 * Split out of `main` because nothing here is covered by tests, so CRAP is
 * `c² + c`; small helpers keep each row under the ceiling.
 *
 * @param {string[]} argv
 * @returns {{ fullScope: boolean, diffScopeRef: string | null }}
 * @throws {Error} when both scope flags are supplied.
 */
function resolveScopeSelection(argv) {
  const diffScopeRef = parseDiffScopeFlag(argv);
  const fullScope = parseFullScopeFlag(argv);
  if (fullScope && diffScopeRef !== null) {
    throw new Error(
      '[Duplication] --full-scope is incompatible with --diff-scope; pick one',
    );
  }
  return { fullScope, diffScopeRef };
}

/**
 * @param {string[]} argv
 * @param {object} gate
 * @returns {string}
 */
function resolveAbsBaselinePath(argv, gate) {
  const baselinePath =
    parseCliArgs(argv).baselinePath ??
    gate.baselinePath ??
    'baselines/duplication.json';
  return path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
}

/**
 * @param {{ fullScope: boolean, diffScopeRef: string | null }} selection
 */
function logScopeDecision({ fullScope, diffScopeRef }) {
  if (fullScope) {
    Logger.info(
      '[Duplication] --full-scope: regenerating every row (out-of-scope merge disabled).',
    );
  } else if (diffScopeRef) {
    Logger.info(
      `[Duplication] --diff-scope ${diffScopeRef}: narrowing to changed files; out-of-scope rows preserved verbatim.`,
    );
  }
}

/**
 * @param {{ fullScope: boolean, diffScopeRef: string | null, absBaselinePath: string, epsilon: number }} args
 * @returns {object}
 */
function buildRefreshOpts({
  fullScope,
  diffScopeRef,
  absBaselinePath,
  epsilon,
}) {
  const refreshOpts = {
    kind: 'duplication',
    writePath: absBaselinePath,
    epsilon,
  };
  if (fullScope) {
    refreshOpts.fullScope = true;
  } else if (diffScopeRef) {
    // The service derives two-dot `baseRef..headRef`, like the sibling CLIs.
    refreshOpts.baseRef = diffScopeRef;
  }
  // No flag: the service derives the diff from `origin/main..HEAD`.
  return refreshOpts;
}

async function main() {
  const argv = process.argv.slice(2);
  const selection = resolveScopeSelection(argv);
  const config = resolveConfig();
  const absBaselinePath = resolveAbsBaselinePath(
    argv,
    resolveDuplicationGate(config),
  );

  Logger.info('[Duplication] Updating baseline...');
  logScopeDecision(selection);

  const result = await refreshBaseline(
    buildRefreshOpts({
      ...selection,
      absBaselinePath,
      epsilon: getBaselineEpsilon('duplication'),
    }),
  );

  Logger.info(
    `[Duplication] ✅ Baseline updated (kernelVersion=${result.envelope.kernelVersion}, wrote=${result.wrote}, scope=${result.scope.mode}, rows=${result.envelope.rows.length}). Wrote to ${absBaselinePath}.`,
  );
}

runAsCli(import.meta.url, main, {
  source: 'duplication-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(
      `[Duplication] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`,
    );
    process.exitCode = 1;
  },
});
