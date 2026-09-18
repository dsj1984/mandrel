/**
 * update-duplication-baseline.js — manual refresh CLI for the
 * code-duplication (DRY) baseline (Story #3664).
 *
 * Story #4944: this CLI is now a thin wrapper around
 * `refreshBaseline({ kind: 'duplication' })` from
 * `.agents/scripts/lib/baselines/refresh-service.js`, completing the Epic
 * #2173 migration — duplication was the last kind still assembling its own
 * writer call via the legacy `buildWriterScopeArgs` path. Scope resolution,
 * prior-envelope reading, epsilon damping, envelope assembly, and
 * persistence all flow through the unified service.
 *
 * The migration is what makes this CLI's documented surface true. Before it,
 * `--full-scope` was advertised and parsed by nobody, and the no-flag default
 * was a full rewrite rather than the diff-scoped refresh the usage text
 * described.
 *
 * Surface:
 *
 *   - `--baseline <path>`: write somewhere other than the configured
 *     `delivery.quality.gates.duplication.baselinePath`.
 *   - `--diff-scope <ref>`: scope the refresh to files changed between
 *     `<ref>` and HEAD. Out-of-scope rows are preserved verbatim from the
 *     prior on-disk baseline.
 *   - `--full-scope`: regenerate every row (no out-of-scope merge).
 *   - With no scope flag: scope is derived from `git diff --name-only
 *     origin/main..HEAD` (the service's default `baseRef..headRef`), matching
 *     `update-crap-baseline.js` / `update-maintainability-baseline.js` /
 *     `update-coverage-baseline.js`.
 *
 * **Scope is a write-side filter here, not a scan-side one.** jscpd detects
 * clones pairwise, so the scan always covers the whole target tree even in
 * diff mode — see `buildDefaultDuplicationScorer` in the refresh service for
 * why narrowing the scan would drop clones between a changed file and an
 * unchanged one. What a scope flag narrows is which rows the refresh is
 * allowed to rewrite.
 *
 * Exits non-zero only when the scanner itself crashes. An empty result (no
 * detected clones) still writes an envelope with `rows: []` so downstream
 * `check-baselines` can tell "intentional empty baseline" apart from "no
 * baseline yet".
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import path from 'node:path';
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/**
 * Usage block for `--help`. This CLI *writes* on invocation, so the help
 * branch must short-circuit before `main` runs rather than inside it —
 * `runAsCli` answers help first, which makes "a usage probe never mutates a
 * baseline" structural instead of a check `main` has to remember.
 */
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
 * Parse `--baseline <path>` — the one flag this CLI does not share with its
 * siblings. The scope flags are parsed by the shared helpers so their
 * contract stays identical across the four update CLIs.
 *
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
 * Parse `--full-scope` (boolean opt-out flag).
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function parseFullScopeFlag(argv = []) {
  return argv.includes('--full-scope');
}

/**
 * Resolve the duplication gate block from the merged quality config. The
 * flattened legacy bag does not expose a `duplication` accessor (the kind
 * post-dates the bag), so read it off the resolved `gates` map directly.
 *
 * @param {object} config resolved config
 * @returns {object} the duplication gate block (possibly empty)
 */
function resolveDuplicationGate(config) {
  const gates = getQuality(config).gates ?? {};
  return gates.duplication ?? {};
}

/**
 * Resolve the mutually-exclusive scope selection from argv.
 *
 * Split out of `main` deliberately: nothing in this file is reachable from a
 * test (the CLI is only ever spawned with `--help`, which `runAsCli`
 * short-circuits), so every function here scores CRAP at zero coverage —
 * `c² + c`. A single `main` carrying all the branching lands at c=8 → 72,
 * well over the 30 ceiling. Small single-purpose helpers keep each row far
 * below it without hiding any logic.
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
 * Resolve the absolute path the refreshed envelope is written to:
 * `--baseline <path>` wins, then the configured gate path, then the
 * framework default.
 *
 * @param {string[]} argv
 * @param {object} gate resolved duplication gate block
 * @returns {string} absolute path
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
 * Announce which scope the refresh resolved to, so an operator reading the
 * log can tell a narrowed refresh from a full rewrite without re-deriving it.
 *
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
 * Assemble the `refreshBaseline` option bag for the resolved selection.
 *
 * No `scorer` is injected — the service resolves the canonical default
 * duplication scorer, which reads `gates.duplication.targetDirs` /
 * `ignoreGlobs` off the same resolved config this CLI reads.
 *
 * @param {{ fullScope: boolean, diffScopeRef: string | null, absBaselinePath: string, epsilon: number }} args
 * @returns {object} options for `refreshBaseline`
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
    // The CLI's documented `--diff-scope <ref>` semantics are `<ref>...HEAD`
    // (three-dot). The service derives via two-dot `baseRef..headRef`; pass
    // the ref as `baseRef` so the derivation runs through the same execFile
    // seam the sibling CLIs use.
    refreshOpts.baseRef = diffScopeRef;
  }
  // No flag → scopeFiles=null + fullScope=false → service derives the diff
  // via `origin/main..HEAD` (its default baseRef/headRef).
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
