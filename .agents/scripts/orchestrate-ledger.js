#!/usr/bin/env node

/**
 * orchestrate-ledger.js — the `/mandrel-orchestrate` run ledger: record the
 * operator's authority once, record each action before it is taken (refusing
 * an ungranted one), and print the hand-back summary.
 *
 * Exit codes: 0 recorded / printed, 2 refused (nothing written), 1 usage.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import {
  ACTION_DEFAULTS,
  ledgerPath,
  readLedger,
  recordAction,
  recordAuthority,
  renderSummary,
  summarize,
} from './lib/orchestrate/ledger.js';

const USAGE = {
  invocation:
    'node .agents/scripts/orchestrate-ledger.js <authority|record|summary> --run-id <id> [options]',
  summary:
    'Authority, action records and the hand-back summary for one /mandrel-orchestrate run.',
  flags: [
    ['--run-id <id>', 'The orchestrate run (required).'],
    [
      '--grant <a[,b…]>',
      `authority: the actions granted (${Object.keys(ACTION_DEFAULTS).join(', ')}).`,
    ],
    [
      '--action <name>',
      'record: a granted action, or raise / follow-up (always allowed).',
    ],
    ['--pr <n>', 'record: the PR the action concerns.'],
    ['--story <id>', 'record: the Story the action concerns.'],
    ['--text <line>', 'record: one line saying what is being done.'],
    ['--json', 'summary: print JSON.'],
    ['--cwd <path>', 'Main-repo checkout (default: project root).'],
  ],
  notes: [
    'Exit 0 recorded, 2 refused (not-granted, already-raised, no-authority) with nothing written, 1 usage error.',
  ],
};

const intOrNull = (v, flag) => {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${flag} must be a positive integer (got "${v}")`);
  return n;
};

export function parseLedgerArgv(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'run-id': { type: 'string' },
      grant: { type: 'string' },
      action: { type: 'string' },
      pr: { type: 'string' },
      story: { type: 'string' },
      text: { type: 'string' },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: true,
  });
  const [command] = positionals;
  if (!['authority', 'record', 'summary'].includes(command)) {
    throw new Error('first argument must be authority, record or summary');
  }
  if (!values['run-id']) throw new Error('--run-id is required');
  if (command === 'record' && !values.action)
    throw new Error('record needs --action');
  return {
    command,
    runId: values['run-id'],
    grants: (values.grant ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
    action: values.action ?? null,
    pr: intOrNull(values.pr, '--pr'),
    story: intOrNull(values.story, '--story'),
    text: values.text ?? '',
    json: values.json,
    cwd: path.resolve(values.cwd ?? PROJECT_ROOT),
  };
}

/** @returns {number} the exit code */
export function runLedgerCommand(
  args,
  { file, now = Date.now(), out = process.stdout, err = process.stderr },
) {
  if (args.command === 'summary') {
    const summary = summarize(readLedger(file));
    out.write(
      args.json ? `${JSON.stringify(summary)}\n` : renderSummary(summary),
    );
    return 0;
  }
  const result =
    args.command === 'authority'
      ? recordAuthority({ file, grants: args.grants, now })
      : recordAction({
          file,
          action: args.action,
          pr: args.pr,
          story: args.story,
          text: args.text,
          now,
        });
  if (!result.ok) {
    err.write(`[orchestrate-ledger] refused: ${result.reason}\n`);
    return 2;
  }
  out.write(`${JSON.stringify(result.record)}\n`);
  return 0;
}

/* node:coverage ignore next -- CLI wiring over the tested lib */
async function main() {
  const args = parseLedgerArgv(process.argv.slice(2));
  const config = resolveConfig({ cwd: args.cwd });
  return runLedgerCommand(args, { file: ledgerPath(args.runId, config) });
}

runAsCli(import.meta.url, main, {
  source: 'orchestrate-ledger',
  propagateExitCode: true,
  usage: USAGE,
});
