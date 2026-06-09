#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * select-audits.js — Thin CLI wrapper around the audit-suite `selectAudits`
 * SDK in `lib/audit-suite/`.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a
 * in docs/decisions.md for the migration table.
 *
 * Story #1083 (Epic #1072) moved the rule-matching logic
 * (`matchesFilePattern`, `matchesAnyFilePattern`, `selectAudits`) into
 * `lib/audit-suite/selector.js` so the pipeline barrel can re-export
 * the SDK without importing upward from a top-level CLI. This file now
 * contains only argv parsing, provider construction, JSON stdout, and
 * degraded-mode exit-code mapping. Callers that need the rule-matching
 * SDK import it directly from `lib/audit-suite/index.js`.
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

import { selectAudits } from './lib/audit-suite/index.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { isDegraded } from './lib/degraded-mode.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/select-audits.js \\
  --ticket <id> --gate <gate> [--base-branch main]

Flags:
  --ticket       GitHub issue number to evaluate (required).
  --gate         Audit gate (e.g. gate1, gate2, gate3, gate4) (required).
  --base-branch  Branch to diff against for changed-file matching (default: main).
  --help         Show this message.
`;

export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      ticket: { type: 'integer', alias: 'ticketId' },
      gate: { type: 'string' },
      'base-branch': { type: 'string', default: 'main' },
      'gate-mode': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    argv,
  );
  return values;
}

/**
 * Orchestration body of `main` extracted as a sibling exported function so
 * the parse / validate / dispatch / classify-degraded ladder is unit-testable
 * without spawning a process. `main` becomes a thin shell: parse → call this
 * → render → exit. CLI surface unchanged (same flags, same exit codes, same
 * stdout JSON schema).
 *
 * @param {ReturnType<typeof parseArgv>} values
 * @param {{
 *   resolveConfig?: () => object,
 *   createProvider?: (config: object) => object,
 *   selectAudits?: typeof selectAudits,
 *   env?: Record<string, string|undefined>,
 *   help?: string,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of: `'help'`, `'validation-error'`, `'envelope'`.
 *   `'envelope'` carries the `selectAudits` JSON the CLI prints verbatim to
 *   stdout. Validation errors and help requests do not print to stdout.
 */
export async function runSelectAuditsCli(values, deps = {}) {
  const helpText = deps.help ?? HELP;
  if (values.help) {
    return { exitCode: 0, result: { kind: 'help', text: helpText } };
  }

  const { ticketId, gate, baseBranch, gateMode } = values;

  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: '[select-audits] --ticket <id> is required.',
        help: helpText,
      },
    };
  }
  if (!gate) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: '[select-audits] --gate <gate> is required.',
        help: helpText,
      },
    };
  }

  const cfg = deps.resolveConfig ? deps.resolveConfig() : resolveConfig();
  const provider = deps.createProvider
    ? deps.createProvider(cfg)
    : createProvider(cfg);
  const env = deps.env ?? process.env;
  const runner = deps.selectAudits ?? selectAudits;

  const gateModeOpts = {
    argv: gateMode ? ['--gate-mode'] : [],
    env,
  };
  const envelope = await runner({
    ticketId,
    gate,
    provider,
    baseBranch,
    gateModeOpts,
  });
  return {
    exitCode: isDegraded(envelope) ? 1 : 0,
    result: { kind: 'envelope', envelope },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  const { exitCode, result } = await runSelectAuditsCli(values);

  if (result.kind === 'help') {
    process.stdout.write(result.text);
    return;
  }
  if (result.kind === 'validation-error') {
    process.stderr.write(`${result.message}\n${result.help}`);
    process.exit(exitCode);
  }
  // kind === 'envelope' — degraded envelopes still print to stdout so
  // callers can parse `degraded: true`, then exit non-zero so shell
  // pipelines see the soft-fail. Gate-mode throws upstream and runAsCli's
  // default handler exits 1.
  process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'select-audits' });
