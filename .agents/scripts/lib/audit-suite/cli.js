/**
 * lib/audit-suite/cli.js — Argv parsing + help text for run-audit-suite.
 *
 * Extracted from `.agents/scripts/run-audit-suite.js` (Story #963, Epic #946).
 * No IO, no provider call. The entry-point composes these helpers with the
 * runner from `./runner.js`.
 */

import { parseArgs } from 'node:util';

export const HELP = `Usage: node .agents/scripts/run-audit-suite.js \\
  --audits <comma-list> [--ticket <id>] [--base-branch main] \\
  [--substitution key=value]... [--run-id <id>]

Flags:
  --audits         Comma-separated audit workflow names (required).
  --ticket         Ticket id used for the {{ticketId}} substitution (optional).
  --base-branch    Value used for the {{baseBranch}} substitution (default: main).
  --substitution   Repeatable key=value substitution (e.g. --substitution alphaKey=val).
                   Allowed keys are the built-ins (auditOutputDir, ticketId, baseBranch,
                   changedFiles) plus any substitutionKeys declared on the requested audits.
  --run-id         Optional artifact prefix. When set, full prompt bodies are written
                   to <auditOutputDir>/audit-<run-id>-<audit>.md (defaults to
                   temp/audits/) so downstream agents can read them.
  --help           Show this message.
`;

/**
 * Pure: split a comma-separated `--audits` value into a clean workflow list.
 * Empty/whitespace tokens are dropped; nullish input yields an empty array.
 *
 * @param {string|null|undefined} commaList
 * @returns {string[]}
 */
export function parseAuditList(commaList) {
  return String(commaList ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Parse the run-audit-suite CLI argv into a flat `values` object.
 * `strict: false` keeps the parser permissive so callers can pass extra
 * positional/unknown flags without aborting the run.
 *
 * @param {string[]} argv
 * @returns {Record<string, unknown>}
 */
export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      audits: { type: 'string' },
      ticket: { type: 'string' },
      'base-branch': { type: 'string' },
      substitution: { type: 'string', multiple: true },
      'run-id': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}
