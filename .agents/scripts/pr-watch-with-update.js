#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * pr-watch-with-update.js — close-tail shim (Story #2327 / Task #2332).
 *
 * Collapsed the legacy 371-line watch-and-recover CLI to a pure emit
 * shim. The Watcher listener (subscribed to `pr.created`) now owns the
 * required-check poll loop AND the `mergeStateStatus: BEHIND`
 * auto-recovery; this shim re-enters the close-tail chain at the
 * canonical entry event (`pr.created`). Per Epic #2306 acceptance:
 * <50 lines, exactly one `bus.emit`, emits `pr.created`. Full deletion
 * remains D-2's job.
 *
 * Usage: node .agents/scripts/pr-watch-with-update.js --pr <n> [--repo owner/repo]
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';

export async function runPrWatchShim({ prNumber, repo = null, bus } = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1)
    throw new TypeError('runPrWatchShim: --pr requires positive int');
  const args = ['pr', 'view', String(prNumber)];
  if (repo) args.push('--repo', repo);
  args.push('--json', 'url,headRefName,baseRefName');
  const res = spawnSync('gh', args, { encoding: 'utf-8', shell: false });
  if (res.status !== 0)
    throw new Error(`gh pr view exit ${res.status}: ${res.stderr ?? ''}`);
  const { url, headRefName, baseRefName } = JSON.parse(res.stdout);
  await (bus ?? createBus()).emit('pr.created', {
    prUrl: url,
    head: headRefName,
    base: baseRefName,
  });
  return { prNumber, emitted: 'pr.created' };
}
async function main() {
  const { values } = parseArgs({
    options: { pr: { type: 'string' }, repo: { type: 'string' } },
    strict: false,
  });
  return runPrWatchShim({
    prNumber: Number.parseInt(values.pr ?? '', 10),
    repo: values.repo ?? null,
  });
}
runAsCli(import.meta.url, main, { source: 'pr-watch-with-update' });
