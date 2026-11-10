#!/usr/bin/env node

/**
 * orchestrate-inventory.js — read-only: every open PR in exactly one state,
 * plus overlaps, inherited failures, landed Stories and runner backlog.
 * With `--run-id` it appends the sweep to the run ledger and fills `changes[]`.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { renderInventory, runInventory } from './lib/orchestrate/inventory.js';
import { ledgerPath } from './lib/orchestrate/ledger.js';

const USAGE = {
  invocation:
    'node .agents/scripts/orchestrate-inventory.js [--run-id <id>] [--json] [--cwd <main-repo>]',
  summary:
    'Classify every open PR for /mandrel-orchestrate. Reads GitHub and git only; never a job log.',
  flags: [
    [
      '--run-id <id>',
      'Append this sweep to the run ledger and report the PRs whose state changed.',
    ],
    ['--json', 'Print the orchestrate-inventory envelope as JSON.'],
    ['--cwd <path>', 'Main-repo checkout (default: project root).'],
  ],
  notes: [
    'Over repo-scoped REST the merge queue is unreadable: `merge-queue` is listed in degraded[].',
  ],
};

export function parseInventoryArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'run-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: true,
  });
  return {
    runId: values['run-id'] ?? null,
    json: values.json,
    cwd: path.resolve(values.cwd ?? PROJECT_ROOT),
  };
}

/* node:coverage ignore next -- CLI wiring over the tested lib */
async function main() {
  const args = parseInventoryArgv(process.argv.slice(2));
  const config = resolveConfig({ cwd: args.cwd });
  const envelope = await runInventory({
    config,
    cwd: args.cwd,
    runId: args.runId,
    ledgerFile: args.runId ? ledgerPath(args.runId, config) : null,
  });
  process.stdout.write(
    args.json ? `${JSON.stringify(envelope)}\n` : renderInventory(envelope),
  );
}

runAsCli(import.meta.url, main, {
  source: 'orchestrate-inventory',
  usage: USAGE,
});
