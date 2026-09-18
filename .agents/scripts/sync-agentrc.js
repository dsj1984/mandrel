#!/usr/bin/env node

/**
 * Validate `.agentrc.json` and flag leaves that restate a framework default.
 * Never writes the file: defaults are layered at read time, so absent keys
 * need no filling. Flags and exit codes live in `USAGE`.
 */

import { fileURLToPath } from 'node:url';
import { respondToHelp } from './lib/cli-usage.js';
import { formatSyncReport, syncAgentrc } from './lib/config/sync-agentrc.js';
import { Logger } from './lib/Logger.js';

const USAGE = {
  invocation: 'node .agents/scripts/sync-agentrc.js [--cwd <path>] [--quiet]',
  summary:
    'Validate `.agentrc.json` against the framework schema and report every project leaf that merely restates a framework default. Never writes the config.',
  flags: [
    ['--cwd <path>', 'Project root (default: process cwd).'],
    ['--quiet', 'Suppress advisory rows; print only the status line.'],
  ],
  notes: [
    'Exit codes:\n  0  config is valid (advisories may still appear)\n  1  config is missing, malformed, or fails schema validation',
  ],
};

function parseArgs(argv) {
  const out = { cwd: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd' && i + 1 < argv.length) {
      out.cwd = argv[++i];
    } else if (a === '--quiet') {
      out.quiet = true;
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const { cwd, quiet } = parseArgs(argv);
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
