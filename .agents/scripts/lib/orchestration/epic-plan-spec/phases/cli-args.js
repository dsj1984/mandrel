/**
 * cli-args.js — argv parsing + validation for the `epic-plan-spec` CLI.
 *
 * Extracted from `epic-plan-spec.js` (refs #3685) so the top-level entry
 * stays a thin wire-up that scores at or above the maintainability floor;
 * the option schema and the epic-id guards live here.
 *
 * Story #4324: the separate-ticket persist flags `--techspec` /
 * `--acceptance-spec` are retired with the context-ticket classes. The
 * authored content now lands as sections of the Epic body; pass it via
 * `--tech-spec <file>` and `--acceptance-table <file>`. The old flags fail
 * with a usage error naming the removal.
 */

import { parseArgs } from 'node:util';

/** Retired flags → the replacement guidance surfaced in the usage error. */
const RETIRED_FLAGS = Object.freeze({
  '--techspec':
    '--techspec was retired by the context-ticket fold (Story #4324): the Tech Spec is no longer a separate context::tech-spec ticket. Pass --tech-spec <file> — the content lands as a managed section of the Epic body.',
  '--acceptance-spec':
    '--acceptance-spec was retired by the context-ticket fold (Story #4324): the Acceptance Spec is no longer a separate context::acceptance-spec ticket. Pass --acceptance-table <file> — the AC-ID table lands as the ## Acceptance Table section of the Epic body.',
});

/**
 * Parse and validate the `epic-plan-spec` CLI arguments.
 *
 * @param {string[]} [argv] Defaults to `process.argv.slice(2)`.
 * @returns {{ values: Record<string, unknown>, epicId: number }}
 * @throws {Error} when `--epic` is missing or not a number, or when a
 *   retired separate-ticket persist flag is supplied.
 */
export function parseEpicPlanSpecArgs(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    const flag = arg.split('=')[0];
    if (RETIRED_FLAGS[flag]) {
      throw new Error(`[epic-plan-spec] ${RETIRED_FLAGS[flag]}`);
    }
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'tech-spec': { type: 'string' },
      'acceptance-table': { type: 'string' },
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
      'Usage: epic-plan-spec.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tech-spec <file> --risk-verdict <file> [--acceptance-table <file>]) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  return { values, epicId };
}
