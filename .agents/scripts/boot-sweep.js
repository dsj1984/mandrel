#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * boot-sweep.js — non-interactive *protected* merged-branch sweep over
 * `sweepMergedBranches` (flags: see HELP). Unlike `git-cleanup --branches` it
 * always skips a branch with unpushed work, a dirty worktree or an open
 * parent Story. Best-effort: failures land in the envelope, exit is always 0.
 *
 * `content-merged` branches (merge-tree equivalence — no merge check ever
 * validated their exact diff) are never reaped here, only reported for
 * `/git-cleanup`.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { buildProtectionCtx } from './lib/single-story-sweep/protection-ctx.js';
import { resolveSweepLockPath } from './lib/single-story-sweep/sweep-lock.js';
import { sweepMergedBranches } from './lib/single-story-sweep.js';
import { sweepTempRetention } from './lib/temp-retention.js';

/**
 * Story ids from reaped branch names — only exact `story-<id>`, so a purge is
 * never triggered by a name this framework did not create.
 *
 * @param {string[]|undefined} branches
 * @returns {number[]}
 */
export function storyIdsFromBranches(branches) {
  const ids = [];
  for (const branch of Array.isArray(branches) ? branches : []) {
    const match = /^story-(\d+)$/.exec(String(branch));
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

const HELP = `Usage: node .agents/scripts/boot-sweep.js [options]

Runs the protected merged-branch boot sweep non-interactively: reaps every
local branch whose PR is MERGED and whose HEAD matches the merged headRefOid,
skipping any candidate the protection partition flags (unpushed work, dirty
worktree, still-open parent Story), then fast-forwards the base branch.
Branches detected only via the weaker content-equivalence signal
(detectedBy: 'content-merged') are never reaped here — they are reported
under "contentMerged" (and a routing hint in the summary line) for the
operator to send to /git-cleanup.

Options:
  --include <glob>     Branch glob to sweep (repeatable). Default: story-*
  --exclude <glob>     Branch glob to exclude (repeatable).
  --current <branch>   A branch to always exclude (e.g. the active story).
  --base <branch>      Base branch to fast-forward. Default: project baseBranch.
  --no-fast-forward    Skip the base-branch fast-forward step.
  --json               Emit the result envelope as JSON.
`;

/**
 * Run the protected boot sweep; never throws.
 *
 * @param {{
 *   cwd?: string,
 *   base?: string,
 *   include?: string[],
 *   exclude?: string[],
 *   current?: string,
 *   fastForward?: boolean,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   injectedSweep?: Function,
 *   purgeFn?: Function,
 *   logger?: { info?: Function, warn?: Function },
 * }} [args]
 * @returns {Promise<object>} the {@link sweepMergedBranches} envelope plus
 *   `tempPurge`.
 */
export async function runBootSweep({
  cwd,
  base,
  include,
  exclude,
  current,
  fastForward = true,
  injectedConfig,
  injectedProvider,
  injectedSweep,
  purgeFn = sweepTempRetention,
  logger = Logger,
} = {}) {
  const root = path.resolve(cwd ?? PROJECT_ROOT);
  try {
    // Inside the try: a bad config must also degrade to `ok:false`, exit 0.
    const config = injectedConfig ?? resolveConfig({ cwd: root });
    const provider = injectedProvider ?? createProvider(config);
    const baseBranch = base ?? config.project?.baseBranch ?? 'main';

    const includeGlobs =
      Array.isArray(include) && include.length > 0 ? include : ['story-*'];
    const excludeGlobs = Array.isArray(exclude) ? [...exclude] : [];
    if (typeof current === 'string' && current.length > 0) {
      excludeGlobs.push(current);
    }

    // Shared with `single-story-init.js`, which reaps the same branches: one
    // lock path, or the two sweeps race to delete each other's plans.
    const tempRoot = config?.project?.paths?.tempRoot ?? 'temp';
    const lockPath = resolveSweepLockPath({ cwd: root, tempRoot });
    const lockTimeoutMs =
      config.delivery?.worktreeIsolation?.sweepLockMs ?? 60_000;

    const sweepFn = injectedSweep ?? sweepMergedBranches;
    const result = await sweepFn({
      cwd: root,
      baseBranch,
      include: includeGlobs,
      exclude: excludeGlobs,
      fastForward,
      logTag: '[boot-sweep]',
      logger: {
        info: (m) => logger.info?.(m),
        warn: (m) => logger.warn?.(m),
      },
      protectionCtx: buildProtectionCtx({ cwd: root, provider }),
      lockPath,
      lockTimeoutMs,
    });

    // Temp-retention catch-up: reaped branches are confirmed merges, so their
    // artifacts are spent; the age floor collects the rest.
    const purge = await purgeFn({
      config,
      mergedStoryIds: storyIdsFromBranches(result?.reaped),
      label: 'boot-sweep',
      logger,
    });
    return { ...result, tempPurge: purge };
  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.warn?.(`[boot-sweep] sweep threw (host continues): ${msg}`);
    return {
      ok: false,
      skipped: true,
      error: msg,
      candidates: 0,
      localDeleted: 0,
      remoteDeleted: 0,
      protected: [],
      contentMerged: [],
      failures: [],
    };
  }
}

/**
 * One-line summary; a nonzero `contentMerged` count adds a `/git-cleanup` hint.
 *
 * @param {{ localDeleted: number, remoteDeleted: number, protected?: Array, contentMerged?: Array }} result
 * @returns {string}
 */
export function buildSummaryLine(result) {
  const protectedCount = result.protected?.length ?? 0;
  const contentMergedCount = result.contentMerged?.length ?? 0;
  const contentMergedSuffix =
    contentMergedCount > 0
      ? `; ${contentMergedCount} content-merged branch(es) left for /git-cleanup`
      : '';
  return `[boot-sweep] reaped ${result.localDeleted} local + ${result.remoteDeleted} remote; protected ${protectedCount}${contentMergedSuffix}.`;
}

/**
 * CLI core: parse argv, run the sweep, render the report.
 *
 * @param {string[]} [argv]
 * @param {{ runBootSweepImpl?: typeof runBootSweep, logger?: { info: Function } }} [deps]
 * @returns {Promise<object>} the sweep envelope that was rendered.
 */
export async function runBootSweepCli(
  argv = process.argv.slice(2),
  { runBootSweepImpl = runBootSweep, logger = Logger } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      cwd: { type: 'string' },
      include: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      current: { type: 'string' },
      'no-fast-forward': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    logger.info(HELP);
    return undefined;
  }

  const result = await runBootSweepImpl({
    cwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    base: typeof values.base === 'string' ? values.base : undefined,
    include: Array.isArray(values.include) ? values.include : [],
    exclude: Array.isArray(values.exclude) ? values.exclude : [],
    current: typeof values.current === 'string' ? values.current : undefined,
    fastForward: values['no-fast-forward'] !== true,
  });

  if (values.json) {
    logger.info(JSON.stringify(result, null, 2));
  } else {
    logger.info(buildSummaryLine(result));
  }
  return result;
}

async function main() {
  await runBootSweepCli();
}

runAsCli(import.meta.url, main, {
  source: 'boot-sweep',
  usage: HELP,
});
