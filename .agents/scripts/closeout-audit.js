#!/usr/bin/env node

/**
 * closeout-audit.js — report every landed Story whose close-out did not
 * finish; `--execute` repairs each drifted check through its existing seam.
 *
 * Exit codes: 0 nothing drifted (or all repaired), 2 drift remains, 1 the
 * audit itself could not run.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import {
  buildProbes,
  buildRepairs,
  buildWithLock,
  DEFAULT_SINCE_HOURS,
  exitCodeFor,
  listMergedStoryIds,
  renderAudit,
  runCloseoutAudit,
} from './lib/orchestration/closeout-audit.js';
import { createProvider } from './lib/provider-factory.js';

const USAGE = {
  invocation:
    'node .agents/scripts/closeout-audit.js [--story <id[,id…]>] [--since-hours <n>] [--execute] [--json] [--cwd <main-repo>]',
  summary:
    'Audit landed Stories for an unfinished close-out (state, board, branches, worktree, scratch). Dry-run unless --execute.',
  flags: [
    ['--story <ids>', 'Audit exactly these Story ids (comma-separated).'],
    [
      '--since-hours <n>',
      `Without --story: Stories whose story-<id> PR merged in the last n hours (default ${DEFAULT_SINCE_HOURS}).`,
    ],
    [
      '--execute',
      'Repair each drifted check through its existing seam, then re-audit.',
    ],
    ['--json', 'Print one closeout-audit envelope on stdout.'],
    ['--cwd <path>', 'Main-repo checkout (default: project root).'],
  ],
  notes: [
    'Exit 0 nothing drifted, 2 drift remains, 1 the audit could not run.',
    'An unknown check (probe could not run) is reported, never repaired.',
  ],
};

export function parseCloseoutArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      'since-hours': { type: 'string' },
      execute: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: true,
  });
  const storyIds = values.story
    ? values.story.split(',').map((s) => Number.parseInt(s.trim(), 10))
    : null;
  if (storyIds?.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(
      `--story must be positive integer ids (got "${values.story}")`,
    );
  }
  const sinceHours =
    values['since-hours'] === undefined
      ? DEFAULT_SINCE_HOURS
      : Number(values['since-hours']);
  if (!(sinceHours > 0))
    throw new Error('--since-hours must be a positive number');
  return {
    storyIds,
    sinceHours,
    execute: values.execute,
    json: values.json,
    cwd: path.resolve(values.cwd ?? PROJECT_ROOT),
  };
}

const stderrLogger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
};

/* node:coverage ignore next -- CLI wiring over the tested lib */
async function main() {
  const args = parseCloseoutArgv(process.argv.slice(2));
  const config = resolveConfig({ cwd: args.cwd });
  const provider = createProvider(config);
  const deps = { cwd: args.cwd, config, provider, logger: stderrLogger };
  const storyIds =
    args.storyIds ??
    (await listMergedStoryIds({
      baseBranch: config.project?.baseBranch ?? 'main',
      sinceHours: args.sinceHours,
    }));
  const envelope = await runCloseoutAudit({
    storyIds,
    scope: args.storyIds
      ? { mode: 'explicit', storyIds, execute: args.execute }
      : {
          mode: 'window',
          sinceHours: args.sinceHours,
          storyIds,
          execute: args.execute,
        },
    probes: buildProbes(deps),
    repairs: buildRepairs(deps),
    execute: args.execute,
    withLock: buildWithLock(deps),
  });
  process.stdout.write(
    args.json
      ? `${JSON.stringify(envelope, null, 2)}\n`
      : renderAudit(envelope),
  );
  return exitCodeFor(envelope);
}

runAsCli(import.meta.url, main, {
  source: 'closeout-audit',
  propagateExitCode: true,
  usage: USAGE,
});
