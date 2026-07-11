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
 * @param {{
 *   argv?: string[],
 *   config?: object,
 *   root?: string,
 *   stdout?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} always 0
 */
export async function runCli({
  argv = process.argv.slice(2),
  config,
  root,
  stdout = process.stdout,
} = {}) {
  const { rootPath } = parseArgv(argv);
  const resolvedConfig = config ?? resolveConfig();
  const resolvedRoot = root ?? rootPath ?? PROJECT_ROOT;
  const result = resolveDocTiers(resolvedConfig, { root: resolvedRoot });
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
});
