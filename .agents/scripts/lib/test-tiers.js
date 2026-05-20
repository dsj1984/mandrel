import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Globs for slow / integration-style suites excluded from `test:quick`.
 *
 * Curated from the local performance review (Story #2740 context) and
 * `*.integration.test.js` naming. Refine when the profiling story (#2742)
 * publishes a machine-generated inventory.
 */
export const INTEGRATION_INCLUDE = [
  'tests/**/*.integration.test.js',
  'tests/epic-execute/epic-execute-record-wave.test.js',
  'tests/hook-chain-reflog-invariant.test.js',
  'tests/push-epic-retry.test.js',
  'tests/integration-prime-after-sweep.test.js',
  'tests/concurrency-wiring.test.js',
  'tests/scripts/git-cleanup.test.js',
  'tests/lib/checks/runner-integration.test.js',
  'tests/single-story-close-sync.test.js',
];

const matchesIntegration = picomatch(INTEGRATION_INCLUDE, { dot: true });

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
  const all = walkTestFiles(path.join(repoRoot, 'tests'), 'tests', fsLike).sort();
  if (tier === 'full') {
    return ['tests/**/*.test.js'];
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
