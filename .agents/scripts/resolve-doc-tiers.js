/**
 * CLI: print the documentation read-tier map
 * (`{ tiers: { alwaysLoaded, mandatoryRead, digestVisible, onDemand } }`,
 * entries `{ path, bytes }`) as JSON. A reporter, not a gate: exits 0.
 */

import process from 'node:process';
import { parseGateArgv } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { resolveDocTiers } from './lib/doc-tiers.js';

/**
 * @param {string[]} argv
 * @returns {{ rootPath: string | null, json: boolean }}
 */
export function parseArgv(argv = []) {
  const { root, json } = parseGateArgv(argv, {
    strings: ['root'],
    booleans: ['json'],
  });
  return { rootPath: root, json };
}

/**
 * @param {{
 *   argv?: string[],
 *   config?: object,
 *   root?: string,
 *   stdout?: { write: (s: string) => void },
 * }} [opts]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   resolveDocTiersImpl?: typeof resolveDocTiers,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runCli(
  { argv = process.argv.slice(2), config, root, stdout = process.stdout } = {},
  {
    resolveConfigImpl = resolveConfig,
    resolveDocTiersImpl = resolveDocTiers,
  } = {},
) {
  const { rootPath } = parseArgv(argv);
  const resolvedConfig = config ?? resolveConfigImpl();
  const resolvedRoot = root ?? rootPath ?? PROJECT_ROOT;
  const result = resolveDocTiersImpl(resolvedConfig, { root: resolvedRoot });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

runAsCli(import.meta.url, runCli, {
  source: 'resolve-doc-tiers',
  propagateExitCode: true,
  errorPrefix: '[resolve-doc-tiers] ❌ Fatal error',
  usage: {
    invocation:
      'node .agents/scripts/resolve-doc-tiers.js [--root <dir>] [--json]',
    summary:
      'Print the resolved documentation tiers (always-loaded vs on-demand) as JSON.',
    flags: [
      [
        '--root <dir>',
        'Repository root to resolve against (default: project root).',
      ],
      ['--json', 'Accepted for symmetry; output is always JSON.'],
    ],
  },
});
