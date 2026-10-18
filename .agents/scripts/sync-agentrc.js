#!/usr/bin/env node

/**
 * Validate `.agentrc.json` (with any `.agentrc.local.json` overlay merged in,
 * as the runtime resolver does) and flag leaves that restate a framework
 * default.
 * Never writes the file: defaults are layered at read time, so absent keys
 * need no filling. Flags and exit codes live in `USAGE`.
 */

import { fileURLToPath } from 'node:url';
import { parseGateArgv } from './lib/cli-args.js';
import { respondToHelp } from './lib/cli-usage.js';
import { formatSyncReport, syncAgentrc } from './lib/config/sync-agentrc.js';
import { Logger } from './lib/Logger.js';

const USAGE = {
  invocation: 'node .agents/scripts/sync-agentrc.js [--cwd <path>] [--quiet]',
  summary:
    'Validate `.agentrc.json` — with any gitignored `.agentrc.local.json` deep-merged over it, as the runtime resolver does — against the framework schema, and report every committed leaf that merely restates a framework default. Never writes the config.',
  flags: [
    ['--cwd <path>', 'Project root (default: process cwd).'],
    ['--quiet', 'Suppress advisory rows; print only the status line.'],
  ],
  notes: [
    'Exit codes:\n  0  config is valid (advisories may still appear)\n  1  `.agentrc.json` is missing, either file is malformed, or the merged config fails schema validation',
  ],
};

export function main(argv = process.argv.slice(2)) {
  const { cwd, quiet } = parseGateArgv(argv, {
    strings: ['cwd'],
    booleans: ['quiet'],
  });
  const projectRoot = cwd || process.cwd();
  const result = syncAgentrc({ projectRoot });
  const report = quiet
    ? trimAdvisories(formatSyncReport(result))
    : formatSyncReport(result);
  Logger.info(report);
  if (result.status === 'invalid' || result.status === 'missing-config') {
    return 1;
  }
  return 0;
}

function trimAdvisories(report) {
  return report
    .split('\n')
    .filter((line) => !line.startsWith('  [REDUNDANT]'))
    .join('\n');
}

// cli-opt-out: synchronous CLI with explicit exit-code return.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(respondToHelp(process.argv.slice(2), USAGE) ? 0 : main());
}
