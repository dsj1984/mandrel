/**
 * cli-args.js — argv parsing + validation for the `epic-plan-spec` CLI.
 *
 * Extracted from `epic-plan-spec.js` (refs #3685) so the top-level entry
 * stays a thin wire-up that scores at or above the maintainability floor;
 * the option schema and the epic-id guards live here.
 */

import { parseArgs } from 'node:util';

/**
 * Parse and validate the `epic-plan-spec` CLI arguments.
 *
 * @param {string[]} [argv] Defaults to `process.argv.slice(2)`.
 * @returns {{ values: Record<string, unknown>, epicId: number }}
 * @throws {Error} when `--epic` is missing or not a number.
 */
export function parseEpicPlanSpecArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      prd: { type: 'string' },
      techspec: { type: 'string' },
      'acceptance-spec': { type: 'string' },
      'risk-verdict': { type: 'string' },
      force: { type: 'boolean', default: false },
      'force-review': { type: 'boolean', default: false },
      steal: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    throw new Error(
      'Usage: epic-plan-spec.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --prd <file> --techspec <file> --risk-verdict <file> [--acceptance-spec <file>]) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  return { values, epicId };
}
