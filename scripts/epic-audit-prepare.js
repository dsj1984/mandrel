#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-audit-prepare.js — Phase 4 prepare CLI for `/epic-deliver`.
 *
 * Thin glue around the audit-suite `selectAudits` SDK. Reads the Epic
 * ticket, runs the change-set selector against the Epic branch diff
 * (`main..epic/<id>`), and emits a JSON envelope on stdout that the
 * inline `helpers/epic-audit.md` consumes.
 *
 * The CLI carries no business logic beyond:
 *   1. validating `--epic <id>`,
 *   2. resolving the Epic branch name (`epic/<id>`),
 *   3. running `selectAudits` at the close-gate (`gate3`),
 *   4. shaping the result into the helper-consumable envelope.
 *
 * Envelope shape (Tech Spec #2588 — API Changes § New CLI):
 *
 *   {
 *     "epicId": 2586,
 *     "epicBranch": "epic/2586",
 *     "selectedAudits": ["audit-security", "audit-privacy"],
 *     "changedFiles": ["src/api/admin/users.ts", "..."],
 *     "changedFilesCount": 47,
 *     "substitutionsPayload": "src/api/admin/users.ts\n..."
 *   }
 *
 * Usage:
 *   node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]
 *
 * Exit codes:
 *   0 — envelope written to stdout
 *   2 — validation error (missing/invalid --epic)
 *   1 — provider / git failure
 */

import { selectAudits } from './lib/audit-suite/index.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]

Flags:
  --epic         Epic ticket ID to prepare audit selection for (required).
  --base-branch  Branch to diff against for the selector's change-set
                 input (default: main).
  --gate         Audit gate label (default: gate3 — Epic close gate).
  --help         Show this message.
`;

const DEFAULT_GATE = 'gate3';

/**
 * Parse argv into the values bag this CLI understands.
 *
 * @param {string[]} argv
 * @returns {{ epic: number|null, 'base-branch': string, gate: string, help: boolean }}
 */
export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      epic: { type: 'ticket', alias: 'epicId' },
      'base-branch': { type: 'string', default: 'main', alias: 'baseBranch' },
      gate: { type: 'string', default: DEFAULT_GATE },
      help: { type: 'boolean' },
    },
    argv,
  );
  return values;
}

/**
 * Orchestration body. Exported as a sibling so tests can drive it
 * without spawning a child process. CLI surface unchanged.
 *
 * @param {{ epicId: number, baseBranch?: string, gate?: string, help?: boolean }} values
 * @param {{
 *   resolveConfig?: () => { orchestration: object },
 *   createProvider?: (orchestration: object) => object,
 *   selectAudits?: typeof selectAudits,
 *   help?: string,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of `'help'`, `'validation-error'`, `'envelope'`.
 */
export async function runEpicAuditPrepare(values, deps = {}) {
  const helpText = deps.help ?? HELP;
  if (values.help) {
    return { exitCode: 0, result: { kind: 'help', text: helpText } };
  }

  const { epicId, baseBranch, gate } = values;

  if (!Number.isFinite(epicId) || epicId <= 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: '[epic-audit-prepare] --epic <id> is required.',
        help: helpText,
      },
    };
  }

  const cfg = deps.resolveConfig ? deps.resolveConfig() : resolveConfig();
  const provider = deps.createProvider
    ? deps.createProvider(cfg.orchestration)
    : createProvider(cfg.orchestration);
  const runner = deps.selectAudits ?? selectAudits;

  const envelope = await runner({
    ticketId: epicId,
    gate: gate ?? DEFAULT_GATE,
    provider,
    baseBranch,
  });

  // Degraded envelopes from selectAudits short-circuit through the
  // same surface so callers can branch on `degraded: true`. The
  // helper treats a degraded envelope as a Phase 4 abort — propagate
  // it verbatim with a non-zero exit code so shell pipelines see the
  // failure.
  if (envelope?.degraded) {
    return {
      exitCode: 1,
      result: {
        kind: 'envelope',
        envelope: {
          epicId,
          epicBranch: `epic/${epicId}`,
          ...envelope,
        },
      },
    };
  }

  const changedFiles = envelope?.context?.changedFiles ?? [];
  const selectedAudits = envelope?.selectedAudits ?? [];

  return {
    exitCode: 0,
    result: {
      kind: 'envelope',
      envelope: {
        epicId,
        epicBranch: `epic/${epicId}`,
        selectedAudits,
        changedFiles,
        changedFilesCount: changedFiles.length,
        substitutionsPayload: changedFiles.join('\n'),
      },
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  const { exitCode, result } = await runEpicAuditPrepare(values);

  if (result.kind === 'help') {
    process.stdout.write(result.text);
    return;
  }
  if (result.kind === 'validation-error') {
    process.stderr.write(`${result.message}\n${result.help}`);
    process.exit(exitCode);
  }
  process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'epic-audit-prepare' });
