#!/usr/bin/env node
/* node:coverage ignore file */
// Story #2336 / Task #2340 — pure emit shim. Sole auto-merge arm site
// is the AutomergeArmer listener (subscribes to `epic.merge.ready`).
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { Bus } from './lib/orchestration/lifecycle/bus.js';

const HELP =
  'Usage: node .agents/scripts/epic-deliver-automerge.js --epic <id> --pr <prNumber>';

export async function runEpicDeliverAutomerge({ epicId, prNumber, bus } = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0)
    throw new TypeError('epicId must be a positive integer');
  if (!Number.isInteger(prNumber) || prNumber <= 0)
    throw new TypeError('prNumber must be a positive integer');
  const prUrl = `https://github.com/local/pr/${prNumber}`;
  const { seqId } = await (bus ?? new Bus()).emit('epic.automerge.start', {
    prUrl,
  });
  return { epicId, prNumber, prUrl, seqId };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      epic: { type: 'string' },
      pr: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  if (values.help) return Logger.info(HELP);
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const prNumber = Number.parseInt(values.pr ?? '', 10);
  if (!epicId || epicId <= 0 || !prNumber || prNumber <= 0) {
    Logger.error(`[epic-deliver-automerge] --epic and --pr required.\n${HELP}`);
    process.exit(2);
  }
  const out = await runEpicDeliverAutomerge({ epicId, prNumber });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-automerge' });
