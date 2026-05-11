#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-cleanup.js — Phase 8 of `/epic-deliver`.
 *
 * Post-merge local-branch + worktree reap. Reads the `epic-run-state`
 * checkpoint to enumerate the Epic's branches, removes any still-registered
 * worktrees with the Windows-lock fallback recipe, and drops the local
 * refs.
 *
 * Remote branches are out of scope — `gh pr merge --delete-branch` already
 * handles `origin/epic/<id>` and story branches are deleted at story-close
 * time. For the "scrap and reset" flow, use `/delete-epic-branches`
 * instead.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-cleanup.js --epic <epicId> [--dry-run] [--json]
 *
 * Output (default): a human-readable summary on stderr-style log lines.
 * Output (--json): a single JSON envelope on stdout.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  listEpicBranchesFromState,
  reapEpicBranches,
} from './lib/orchestration/epic-cleanup.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-cleanup.js --epic <epicId> [--dry-run] [--json]

Reaps local worktrees + branches for an Epic after its PR has merged.
Reads the Epic's run-state checkpoint to enumerate Story branches.
`;

/**
 * Pure: parse argv into the option bag. Exported for tests.
 */
export function parseCleanupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const parsed = Number.parseInt(values.epic ?? '', 10);
  return {
    epicId: Number.isNaN(parsed) || parsed <= 0 ? null : parsed,
    dryRun: values['dry-run'] === true,
    json: values.json === true,
    help: values.help === true,
  };
}

/**
 * Runner-shaped entry. DI-friendly.
 *
 * @param {{
 *   epicId: number,
 *   dryRun?: boolean,
 *   cwd?: string,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   checkpointerFactory?: (deps: { provider: object, epicId: number }) => { read: () => Promise<object|null> },
 *   gitSpawnFn?: typeof gitSpawn,
 *   rmSyncFn?: typeof fs.rmSync,
 *   loggerImpl?: { info?: Function, warn?: Function },
 * }} args
 */
export async function runEpicDeliverCleanup({
  epicId,
  dryRun = false,
  cwd,
  injectedConfig,
  injectedProvider,
  checkpointerFactory,
  gitSpawnFn = gitSpawn,
  rmSyncFn = fs.rmSync,
  loggerImpl,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverCleanup: --epic must be a positive integer',
    );
  }
  const logger = loggerImpl ?? Logger;
  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const factory = checkpointerFactory ?? ((deps) => new Checkpointer(deps));
  const checkpointer = factory({ provider, epicId });
  const state = await checkpointer.read();
  const repoCwd = cwd ?? PROJECT_ROOT;

  if (!state) {
    logger.warn?.(
      `[epic-deliver-cleanup] No epic-run-state checkpoint found on Epic #${epicId}; nothing to enumerate.`,
    );
    return {
      epicId,
      dryRun,
      branches: { epicBranch: null, storyBranches: [] },
      reaped: [],
      failures: [],
      ok: true,
      stateFound: false,
    };
  }

  const branches = listEpicBranchesFromState(state);
  logger.info?.(
    `[epic-deliver-cleanup] Epic #${epicId}: ${branches.storyBranches.length} story branch(es) + ${branches.epicBranch}.`,
  );

  if (dryRun) {
    return {
      epicId,
      dryRun: true,
      branches,
      reaped: [],
      failures: [],
      ok: true,
      stateFound: true,
    };
  }

  const baseBranch = config?.baseBranch ?? 'main';
  const result = reapEpicBranches({
    state,
    cwd: repoCwd,
    gitSpawn: gitSpawnFn,
    rmSyncFn,
    baseBranch,
    logger,
  });

  return {
    epicId,
    dryRun: false,
    branches,
    reaped: result.reaped,
    failures: result.failures,
    switched: result.switched,
    pruned: result.pruned,
    wtBranch: result.wtBranch,
    ok: result.ok,
    stateFound: true,
  };
}

/**
 * Pure: render the non-JSON summary lines. Exported for tests.
 * @param {object} out — runEpicDeliverCleanup envelope.
 * @returns {string[]}
 */
export function renderSummaryLines(out) {
  const lines = [
    `[epic-deliver-cleanup] ${out.dryRun ? '(dry-run) ' : ''}reaped=${out.reaped.length} failures=${out.failures.length}`,
  ];
  for (const r of out.reaped) {
    const tail = r.stderr ? ` stderr=${r.stderr}` : '';
    lines.push(
      `  ${r.branch} → wt=${r.method} branch=${r.branchDeleted ? 'deleted' : 'kept'}${tail}`,
    );
  }
  if (out.switched?.switched) {
    lines.push(
      `  switched main checkout ${out.switched.from} → ${out.switched.to}`,
    );
  }
  if (out.pruned?.pruned?.length > 0) {
    lines.push(`  pruned tracking refs: ${out.pruned.pruned.join(', ')}`);
  }
  if (out.wtBranch?.deleted) {
    lines.push('  deleted stale wt-branch ref');
  }
  return lines;
}

async function main() {
  const args = parseCleanupArgs(process.argv.slice(2));
  if (args.help) {
    Logger.info(HELP);
    return;
  }
  if (args.epicId === null) {
    Logger.error('[epic-deliver-cleanup] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }
  const out = await runEpicDeliverCleanup({
    epicId: args.epicId,
    dryRun: args.dryRun,
  });
  const rendered = args.json
    ? [JSON.stringify(out, null, 2)]
    : renderSummaryLines(out);
  for (const line of rendered) Logger.info(line);
  if (!out.ok) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-cleanup' });
