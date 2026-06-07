#!/usr/bin/env node

/**
 * sync-agentrc.js — default-aware `.agentrc.json` reconciliation (Story #1995).
 *
 * Replaces the manual procedure formerly described in
 * `.agents/workflows/helpers/agents-sync-config.md`. Invoked by
 * `/agents-update` Step 3 after the package upgrade re-materializes `.agents/`.
 *
 * Contract:
 *   - Validates the project config against the framework schema. On
 *     failure, prints diagnostics and exits 1.
 *   - Never auto-fills optional keys from `.agents/docs/agentrc-reference.json`.
 *     The runtime layers framework defaults at read time, so an absent
 *     key resolves to the framework default without being written.
 *   - For every project leaf whose value equals the framework default,
 *     prints an informational `[REDUNDANT]` advisory. The project file
 *     is never modified.
 *
 * Exit codes:
 *   0 — Config is valid (advisories may still appear).
 *   1 — Config is missing, malformed, or fails schema validation.
 *
 * Flags:
 *   --cwd <path>   Project root (defaults to process.cwd()).
 *   --quiet        Suppress advisory rows (only print the status line).
 */

import { fileURLToPath } from 'node:url';
import { formatSyncReport, syncAgentrc } from './lib/config/sync-agentrc.js';
import { Logger } from './lib/Logger.js';

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
  process.exit(main());
}
