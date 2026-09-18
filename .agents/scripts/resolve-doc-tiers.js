/**
 * CLI: resolve the repository's documentation read-tiers (Story #4438).
 *
 * Thin wrapper over `lib/doc-tiers.js#resolveDocTiers` that prints the tier
 * map — `{ tiers: { alwaysLoaded, mandatoryRead, digestVisible, onDemand } }`,
 * every entry `{ path, bytes }` — as JSON. Consumed by the `audit-documentation`
 * lens (read-tier severity weighting), the `check-context-budget.js` ratchet,
 * and operators inspecting the always-loaded closure.
 *
 * Flags:
 *   --json   emit the tier map as JSON to stdout (default rendering is also
 *            JSON; the flag is accepted for parity with the sibling ratchets
 *            and future non-JSON renderings).
 *   --root <path>  resolve tiers against an explicit repo root (default: the
 *                  resolved PROJECT_ROOT).
 *
 * Exit code is always 0 on success — this is a reporter, not a gate.
 */

import process from 'node:process';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { resolveDocTiers } from './lib/doc-tiers.js';

/**
 * Parse argv for `--root <path>` and `--json`.
 *
 * @param {string[]} argv
 * @returns {{ rootPath: string | null, json: boolean }}
 */
export function parseArgv(argv = []) {
  let rootPath = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        rootPath = next;
        i += 1;
      }
    } else if (a === '--json') {
      json = true;
    }
  }
  return { rootPath, json };
}

/**
 * Top-level CLI entry. Exported so tests can drive it against a fixture root
 * with an injected sink and config.
 *
 * The optional final `deps` parameter is the module's injectable seam
 * (`docs/contributing/test-seams.md` rules 1-2): every entry defaults to the real
 * implementation, so the CLI path below — and any production caller — needs no
 * configuration change.
 *
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

async function main() {
  return runCli();
}

runAsCli(import.meta.url, main, {
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
