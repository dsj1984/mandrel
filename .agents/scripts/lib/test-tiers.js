import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/** Slow suites (real git, binary spawns) excluded from `test:quick`. */
export const INTEGRATION_INCLUDE = [
  'tests/**/*.integration.test.js',
  'tests/hook-chain-reflog-invariant.test.js',
  'tests/contract/check-baselines-regression.test.js',
  'tests/contract/check-baselines-kernel-mismatch.test.js',
  'tests/integration-prime-after-sweep.test.js',
  'tests/scripts/git-cleanup.test.js',
  'tests/lib/checks/runner-integration.test.js',
  'tests/single-story-close-sync.test.js',
];

const matchesIntegration = picomatch(INTEGRATION_INCLUDE, { dot: true });

/**
 * Pack-and-install suites driving the shipped binary — too expensive for
 * every pre-push, so only `test:e2e` (its own CI job) runs them. Not exported:
 * `listTestFilesForTier('e2e', root)` is the one reader.
 */
const E2E_INCLUDE = ['tests/e2e/**/*.test.js'];

const matchesE2E = picomatch(E2E_INCLUDE, { dot: true });

const TIERS = ['full', 'quick', 'integration', 'e2e'];

/**
 * The only flags forwarded to `node --test`; any other `--flag` is rejected,
 * since `node --test` reads it as a file pattern and exits 0 having run nothing.
 */
const PASSTHROUGH_FLAGS = ['--test-name-pattern', '--test-only'];

/** Roots scanned for `*.test.js`, including colocated `__tests__` trees. */
const TEST_WALK_ROOTS = ['tests', 'lib', '.agents/scripts'];

/**
 * The measured surface for coverage/CRAP; consume it, never restate a glob.
 * A superset of the `full` tier: e2e children inherit `NODE_V8_COVERAGE` and
 * are the only coverage of the CLI entry files.
 */
export const FULL_TIER_GLOBS = [
  'tests/**/*.test.js',
  'lib/**/__tests__/**/*.test.js',
  '.agents/scripts/**/__tests__/**/*.test.js',
];

/**
 * @param {string} dir
 * @param {string} prefix
 * @param {typeof fs} fsLike
 * @returns {string[]}
 */
function walkTestFiles(dir, prefix, fsLike) {
  const out = [];
  if (!fsLike.existsSync(dir)) return out;
  for (const ent of fsLike.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...walkTestFiles(abs, rel, fsLike));
    } else if (ent.name.endsWith('.test.js')) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * @param {string[]} all
 * @returns {{ e2e: string[], rest: string[] }}
 */
function partitionE2E(all) {
  const e2e = all.filter((file) => matchesE2E(file));
  const e2eSet = new Set(e2e);
  return { e2e, rest: all.filter((file) => !e2eSet.has(file)) };
}

/**
 * @param {string[]} rest
 * @param {'quick' | 'integration'} tier
 * @returns {string[]}
 */
function splitBySpeed(rest, tier) {
  const integration = rest.filter((file) => matchesIntegration(file));
  if (tier === 'integration') {
    return integration;
  }
  const integrationSet = new Set(integration);
  return rest.filter((file) => !integrationSet.has(file));
}

/**
 * Repo-relative test files for a tier. Enumerated, not globbed: `node --test`
 * has no negative pattern to exclude `tests/e2e/**`.
 *
 * @param {'full' | 'quick' | 'integration' | 'e2e'} tier
 * @param {string} repoRoot
 * @param {typeof fs} [fsLike]
 * @returns {string[]}
 */
export function listTestFilesForTier(tier, repoRoot, fsLike = fs) {
  const all = TEST_WALK_ROOTS.flatMap((root) =>
    walkTestFiles(path.join(repoRoot, root), root, fsLike),
  ).sort();
  const { e2e, rest } = partitionE2E(all);
  if (tier === 'e2e') {
    return e2e;
  }
  if (tier === 'full') {
    return rest;
  }
  return splitBySpeed(rest, tier);
}

/**
 * @param {string[]} rest
 * @throws {Error} naming both the accepted tiers and the accepted flags.
 */
function assertKnownFlags(rest) {
  const unknown = rest.filter(
    (arg) =>
      arg.startsWith('--') &&
      !PASSTHROUGH_FLAGS.includes(arg) &&
      !PASSTHROUGH_FLAGS.some((flag) => arg.startsWith(`${flag}=`)),
  );
  if (unknown.length === 0) return;
  throw new Error(
    `[run-tests] unrecognized argument(s): ${unknown.join(', ')}. ` +
      `Accepted: --tier <${TIERS.join('|')}>, ${PASSTHROUGH_FLAGS.join(', ')}, --help. ` +
      'Unrecognized flags are not forwarded: `node --test` would read them as ' +
      'file patterns and exit 0 having run nothing.',
  );
}

/**
 * Parse `--tier <name>` from argv. Unknown tiers and unknown flags throw.
 *
 * @param {string[]} argv
 * @returns {{ tier: 'full' | 'quick' | 'integration' | 'e2e', rest: string[] }}
 */
export function parseTierArgv(argv) {
  const tierIdx = argv.indexOf('--tier');
  if (tierIdx === -1) {
    assertKnownFlags(argv);
    return { tier: 'full', rest: argv };
  }
  const tier = argv[tierIdx + 1];
  if (!tier || !TIERS.includes(tier)) {
    throw new Error(
      `[run-tests] --tier requires one of: ${TIERS.join(', ')} (got ${JSON.stringify(tier)})`,
    );
  }
  const rest = argv.filter((_, i) => i !== tierIdx && i !== tierIdx + 1);
  assertKnownFlags(rest);
  return { tier, rest };
}
