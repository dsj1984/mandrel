// lib/cli/sync-commands.js
/**
 * `mandrel sync-commands` subcommand.
 *
 * Thin wrapper that delegates to the canonical sync script
 * (.agents/scripts/sync-claude-commands.js). The sync script owns all sync
 * logic; this module exists only to expose that logic through the mandrel CLI
 * surface without reimplementing it.
 *
 * The sync script uses top-level await and has no exported `main()` function
 * (marked `cli-opt-out`), so delegation runs via a child process rather than
 * a direct import. Exit code and all output are forwarded verbatim to the
 * caller so `mandrel sync-commands` is transparent to scripts that check $?.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/cli/ → lib/ → project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(
  PROJECT_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);

/**
 * Run the sync-claude-commands script and forward its output + exit code.
 *
 * Injectable seam: `runner` replaces `spawnSync` so tests can drive every
 * branch without spawning a real child process.
 *
 * @param {string[]} _argv - Unused; reserved for future flags.
 * @param {{ runner?: typeof spawnSync }} [opts]
 * @returns {void}
 */
export default function run(_argv = [], { runner = spawnSync } = {}) {
  const result = runner(process.execPath, [SYNC_SCRIPT], {
    stdio: 'inherit',
    env: process.env,
  });

  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
