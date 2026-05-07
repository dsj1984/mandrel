#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * select-audits.js — Thin CLI wrapper around the audit-suite `selectAudits`
 * SDK in `lib/audit-suite/`.
 *
 * Successor to the retired agent-protocols MCP tools. See ADR 20260424-702a
 * in docs/decisions.md for the migration table.
 *
 * Story #1083 (Epic #1072) moved the rule-matching logic
 * (`matchesFilePattern`, `matchesAnyFilePattern`, `selectAudits`) into
 * `lib/audit-suite/selector.js` so the orchestration barrel can re-export
 * the SDK without importing upward from a top-level CLI. This file now
 * contains only argv parsing, provider construction, JSON stdout, and
 * degraded-mode exit-code mapping.
 *
 * The named exports below are preserved as back-compat shims for existing
 * call sites (`audit-orchestrator.js`, the test suite). New callers should
 * import from `lib/audit-suite/index.js`.
 *
 * Usage:
 *   node .agents/scripts/select-audits.js \
 *     --ticket <id> --gate <gate> [--base-branch main]
 *
 * Output: a single JSON object on stdout matching the MCP envelope:
 *   { selectedAudits, ticketId, gate, context: { changedFilesCount, ticketTitle } }
 *
 * Exit codes:
 *   0 — selection succeeded
 *   non-zero — validation or provider failure (error on stderr)
 */

import { parseArgs } from 'node:util';
import {
  matchesAnyFilePattern,
  matchesFilePattern,
  selectAudits,
} from './lib/audit-suite/index.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { isDegraded } from './lib/degraded-mode.js';
import { createProvider } from './lib/provider-factory.js';

// --- Back-compat re-exports for existing import sites -----------------------
// `audit-orchestrator.js`, `tests/select-audits-cli.test.js`, and other
// callers still import these names from this module path. Keep the shims
// pointing at `lib/audit-suite/` so the relocation stays internal.
export {
  matchesAnyFilePattern,
  matchesFilePattern,
  selectAudits,
} from './lib/audit-suite/index.js';

const HELP = `Usage: node .agents/scripts/select-audits.js \\
  --ticket <id> --gate <gate> [--base-branch main]

Flags:
  --ticket       GitHub issue number to evaluate (required).
  --gate         Audit gate (e.g. gate1, gate2, gate3, gate4) (required).
  --base-branch  Branch to diff against for changed-file matching (default: main).
  --help         Show this message.
`;

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      gate: { type: 'string' },
      'base-branch': { type: 'string' },
      'gate-mode': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseCliArgs(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const ticketId = Number.parseInt(values.ticket ?? '', 10);
  const gate = values.gate;

  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    process.stderr.write(`[select-audits] --ticket <id> is required.\n${HELP}`);
    process.exit(2);
  }
  if (!gate) {
    process.stderr.write(`[select-audits] --gate <gate> is required.\n${HELP}`);
    process.exit(2);
  }

  const baseBranch = values['base-branch'] ?? 'main';
  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);

  const gateModeOpts = {
    argv: values['gate-mode'] ? ['--gate-mode'] : [],
    env: process.env,
  };
  const result = await selectAudits({
    ticketId,
    gate,
    provider,
    baseBranch,
    gateModeOpts,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (isDegraded(result)) {
    // Structured-degraded contract: print the envelope to stdout (above) so
    // callers can parse `degraded: true`, then exit non-zero so shell-level
    // pipelines also see the soft-fail. Gate-mode never reaches here — it
    // throws instead, and runAsCli's default handler exits 1.
    process.exit(1);
  }
}

runAsCli(import.meta.url, main, { source: 'select-audits' });
