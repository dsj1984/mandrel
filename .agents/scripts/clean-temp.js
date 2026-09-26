#!/usr/bin/env node
/* node:coverage ignore file -- thin CLI shell; the engine is lib/clean-temp.js */

/**
 * `/clean-temp` — preview (default) or delete spent entries under the
 * project's tempRoot. Thin shell over `lib/clean-temp.js`.
 *
 * Exit codes: 0 clean or dry-run, 1 refused (tempRoot outside the project
 * root) or a deletion failed.
 */

import { runCleanTemp } from './lib/clean-temp.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { promptYesNo } from './lib/orchestration/git-cleanup/phases/prompts.js';
import { createProvider } from './lib/provider-factory.js';

/* node:coverage ignore next */
async function main() {
  const { exitCode } = await runCleanTemp({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    loadConfig: (projectRoot) => resolveConfig({ cwd: projectRoot }),
    getProvider: createProvider,
    confirm: promptYesNo,
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  return exitCode;
}

runAsCli(import.meta.url, main, {
  source: 'clean-temp',
  propagateExitCode: true,
  usage: {
    invocation:
      'node .agents/scripts/clean-temp.js [--execute] [--yes] [--json] [--cwd <path>]',
    summary:
      "Sort every top-level entry under the project's tempRoot into framework / closed-issue / aged / kept buckets. Dry-run unless --execute.",
    flags: [
      ['--execute', 'Delete the confirmed buckets (default is a dry run).'],
      [
        '--yes',
        'Skip the per-bucket prompts; deletes framework and closed-issue only — aged is never deleted unattended.',
      ],
      ['--json', 'Emit the result envelope as JSON.'],
      ['--cwd <path>', 'Project directory (default: process cwd).'],
    ],
    notes: [
      'Refuses (exit 1) when the resolved tempRoot is not inside the project root.',
      'qa/, cache/, *.lock and signals.ndjson (at any depth) are never deleted.',
    ],
  },
});
