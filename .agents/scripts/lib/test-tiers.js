import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Globs for slow / integration-style suites excluded from `test:quick`.
 *
 * Curated from `npm run test:profile` (Stories #2742 / #2744). Real-git
 * harnesses, binary-spawn CLI contracts, and other suites whose setup
 * dominates quick-tier feedback stay here; unit-guard / mock paths remain
 * in quick.
 */
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
 * Repo-relative roots the tier walker scans for test files (names ending in
 * `.test.js`).
 *
 * `tests` holds the framework's suite tree; `lib` holds the published CLI
 * (under `lib/cli` and `lib/migrations`) whose tests are colocated in
 * `__tests__` directories per the unit-tier convention in
 * `rules/testing-standards.md`. `.agents/scripts` holds the orchestration
 * engine; some of its modules colocate tests in `__tests__` directories the
 * same way (Story #4195). Without each root here, both the quick /
 * integration walk and the full-tier glob set miss the colocated tests,
 * leaving that coverage dark in `npm test`. The matching full-tier globs
 * live in `FULL_TIER_GLOBS`.
 */
const TEST_WALK_ROOTS = ['tests', 'lib', '.agents/scripts'];

/**
 * Glob targets for the `full` tier — one per walk root in `TEST_WALK_ROOTS`.
 * The `tests` glob is a flat recursive sweep; the `lib` and `.agents/scripts`
 * globs are scoped to `__tests__` subtrees so they only match colocated
 * tests, never the shipped source modules themselves.
 */
const FULL_TIER_GLOBS = [
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
 * List repo-relative test file paths for a tier.
 *
 * @param {'full' | 'quick' | 'integration'} tier
 * @param {string} repoRoot
 * @param {typeof fs} [fsLike]
 * @returns {string[]}
 */
export function listTestFilesForTier(tier, repoRoot, fsLike = fs) {
  const all = TEST_WALK_ROOTS.flatMap((root) =>
    walkTestFiles(path.join(repoRoot, root), root, fsLike),
  ).sort();
  if (tier === 'full') {
    return [...FULL_TIER_GLOBS];
  }
  const integration = all.filter((file) => matchesIntegration(file));
  if (tier === 'integration') {
    return integration;
  }
  const integrationSet = new Set(integration);
  return all.filter((file) => !integrationSet.has(file));
}

/**
 * Parse `--tier <name>` from argv. Unknown tiers throw.
 *
 * @param {string[]} argv
 * @returns {{ tier: 'full' | 'quick' | 'integration', rest: string[] }}
 */
export function parseTierArgv(argv) {
  const tierIdx = argv.indexOf('--tier');
  if (tierIdx === -1) {
    return { tier: 'full', rest: argv };
  }
  const tier = argv[tierIdx + 1];
  if (!tier || !['full', 'quick', 'integration'].includes(tier)) {
    throw new Error(
      `[run-tests] --tier requires one of: full, quick, integration (got ${JSON.stringify(tier)})`,
    );
  }
  const rest = argv.filter((_, i) => i !== tierIdx && i !== tierIdx + 1);
  return { tier, rest };
}
