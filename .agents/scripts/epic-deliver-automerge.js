#!/usr/bin/env node
/* node:coverage ignore file */
// Story #2336 / Task #2340 — pure emit shim. Sole auto-merge arm site
// is the AutomergeArmer listener (subscribes to `epic.merge.ready`).
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { Bus } from './lib/orchestration/lifecycle/bus.js';

const HELP = 'Usage: node .agents/scripts/epic-deliver-automerge.js --epic <id> --pr <prNumber>';
const intOrNull = (v) => { const n = Number.parseInt(v ?? '', 10); return Number.isNaN(n) || n <= 0 ? null : n; };

export function parseAutomergeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { epic: { type: 'string' }, pr: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: false,
  });
  return { epicId: intOrNull(values.epic), prNumber: intOrNull(values.pr), help: values.help === true };
}

export function classifyAutomergeInvocation(args) {
  if (args?.help) return { kind: 'help' };
  if (args?.epicId === null || args?.prNumber === null)
    return { kind: 'usage-error', messages: ['[epic-deliver-automerge] --epic and --pr required.', HELP] };
  return { kind: 'run', epicId: args.epicId, prNumber: args.prNumber };
}

export const buildPrUrl = (prNumber) => `https://github.com/local/pr/${prNumber}`;

export async function runEpicDeliverAutomerge({ epicId, prNumber, bus, loggerImpl } = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) throw new TypeError('runEpicDeliverAutomerge: epicId must be a positive integer');
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new TypeError('runEpicDeliverAutomerge: prNumber must be a positive integer');
  const prUrl = buildPrUrl(prNumber);
  (loggerImpl ?? Logger).info?.(`[epic-deliver-automerge] emit epic.automerge.start epic=${epicId} pr=${prNumber}`);
  const { seqId } = await (bus ?? new Bus()).emit('epic.automerge.start', { prUrl });
  return { epicId, prNumber, prUrl, seqId };
}

async function main() {
  const intent = classifyAutomergeInvocation(parseAutomergeArgs(process.argv.slice(2)));
  if (intent.kind === 'help') return Logger.info(HELP);
  if (intent.kind === 'usage-error') { for (const m of intent.messages) Logger.error(m); process.exit(2); }
  Logger.info(JSON.stringify(await runEpicDeliverAutomerge({ epicId: intent.epicId, prNumber: intent.prNumber }), null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-automerge' });
