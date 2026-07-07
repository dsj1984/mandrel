#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * boot-sweep.js — protected boot-sweep CLI (Story #4373).
 *
 * A thin, non-interactive wrapper over the scope-agnostic
 * [`sweepMergedBranches`](./lib/single-story-sweep.js) engine, exposed so
 * workflow prose can invoke a *protected* boot sweep directly. Unlike the
 * plain `git-cleanup.js --branches` phase (which reaps every merged
 * candidate the planner surfaces), this surface always applies the
 * `evaluateProtection` partition — a merged branch with unpushed work, a
 * dirty worktree, or a still-open parent Story ticket is skipped, not
 * reaped.
 *
 * The sweep is best-effort: any failure (lock contention, git/gh error)
 * is swallowed and reported in the result envelope, never thrown, so a
 * caller can wire it into a boot path without risking the host run.
 *
 * Usage:
 *   node .agents/scripts/boot-sweep.js [--include <glob>...] \
 *     [--exclude <glob>...] [--current <branch>] [--base <branch>] \
 *     [--no-fast-forward] [--json]
 *
 * Defaults: `--include story-*`, fast-forward the base branch on.
 * Exit code is always 0 — a boot sweep never fails its host.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { buildProtectionCtx } from './lib/single-story-sweep/protection-ctx.js';
import { sweepMergedBranches } from './lib/single-story-sweep.js';

const HELP = `Usage: node .agents/scripts/boot-sweep.js [options]

Runs the protected merged-branch boot sweep non-interactively: reaps every
local branch whose PR is MERGED and whose HEAD matches the merged headRefOid,
skipping any candidate the protection partition flags (unpushed work, dirty
worktree, still-open parent Story), then fast-forwards the base branch.

Options:
  --include <glob>     Branch glob to sweep (repeatable). Default: story-*
  --exclude <glob>     Branch glob to exclude (repeatable).
  --current <branch>   A branch to always exclude (e.g. the active story).
  --base <branch>      Base branch to fast-forward. Default: project baseBranch.
  --no-fast-forward    Skip the base-branch fast-forward step.
  --json               Emit the result envelope as JSON.
`;

/**
 * Run the protected boot sweep. Best-effort: swallows any error and
 * returns the sweep envelope so no caller can be blocked by a failure.
 *
 * DI-friendly: `injectedConfig` / `injectedProvider` let a caller (e.g.
 * `epic-deliver-prepare.js`) reuse an already-resolved config + provider,
 * and `injectedSweep` swaps the engine for unit tests.
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
 *   logger?: { info?: Function, warn?: Function },
 * }} [args]
 * @returns {Promise<object>} the {@link sweepMergedBranches} envelope.
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
  logger = Logger,
} = {}) {
  const root = path.resolve(cwd ?? PROJECT_ROOT);
  const config = injectedConfig ?? resolveConfig({ cwd: root });
  const provider = injectedProvider ?? createProvider(config);
  const baseBranch = base ?? config.project?.baseBranch ?? 'main';

  const includeGlobs =
    Array.isArray(include) && include.length > 0 ? include : ['story-*'];
  const excludeGlobs = Array.isArray(exclude) ? [...exclude] : [];
  if (typeof current === 'string' && current.length > 0) {
    excludeGlobs.push(current);
  }

  const tempRoot = config?.project?.paths?.tempRoot ?? 'temp';
  const lockPath = path.resolve(root, tempRoot, 'boot-sweep.lock');
  const lockTimeoutMs =
    config.delivery?.worktreeIsolation?.sweepLockMs ?? 60_000;

  const sweepFn = injectedSweep ?? sweepMergedBranches;
  try {
    return await sweepFn({
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
      failures: [],
    };
  }
}

async function main() {
  const { values } = parseArgs({
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
    Logger.info(HELP);
    return;
  }

  const result = await runBootSweep({
    cwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    base: typeof values.base === 'string' ? values.base : undefined,
    include: Array.isArray(values.include) ? values.include : [],
    exclude: Array.isArray(values.exclude) ? values.exclude : [],
    current: typeof values.current === 'string' ? values.current : undefined,
    fastForward: values['no-fast-forward'] !== true,
  });

  if (values.json) {
    Logger.info(JSON.stringify(result, null, 2));
  } else {
    const protectedCount = result.protected?.length ?? 0;
    Logger.info(
      `[boot-sweep] reaped ${result.localDeleted} local + ${result.remoteDeleted} remote; protected ${protectedCount}.`,
    );
  }
}

runAsCli(import.meta.url, main, { source: 'boot-sweep' });
