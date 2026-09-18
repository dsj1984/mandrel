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
 * **Content-merged branches are report-only (Story #4396).** The planner
 * also surfaces branches whose content already landed in the base branch
 * by another route (a squash-merged Epic PR, a renamed head, a manual
 * squash merge) via `detectedBy: 'content-merged'` (Story #4395's
 * `git merge-tree --write-tree` probe) — a weaker signal than a merged PR
 * or git ancestry, since no CI/GitHub merge check ever validated that
 * branch's exact diff. This sweep never reaps on that signal alone; it
 * surfaces the branches under `contentMerged` in the result envelope (and
 * a routing hint in the human summary) so the operator can send them to
 * `/git-cleanup` for a confirmed, eyeballed reap.
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
import { resolveSweepLockPath } from './lib/single-story-sweep/sweep-lock.js';
import { sweepMergedBranches } from './lib/single-story-sweep.js';
import { sweepTempRetention } from './lib/temp-retention.js';

/**
 * Recover the Story ids from the branch names a sweep reaped. Only the
 * canonical `story-<id>` shape yields an id — an operator's ad-hoc branch that
 * happened to match the include glob contributes nothing, so a purge can never
 * be triggered by a name this framework did not create.
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
 * Run the protected boot sweep. Best-effort: swallows any error and
 * returns the sweep envelope so no caller can be blocked by a failure.
 *
 * DI-friendly: `injectedConfig` / `injectedProvider` let a caller (e.g.
 * `single-story-init.js`) reuse an already-resolved config + provider,
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
 *   purgeFn?: Function,
 *   logger?: { info?: Function, warn?: Function },
 * }} [args]
 * @returns {Promise<object>} the {@link sweepMergedBranches} envelope, plus a
 *   `tempPurge` result from the Story #4794 temp-retention catch-up.
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
    // Config/provider resolution is inside the try so a malformed
    // `.agentrc.json` (or a provider-construction throw) degrades to the
    // swallowed `ok:false` envelope below rather than propagating and
    // exiting non-zero — the "host continues, exit 0" boot-sweep contract
    // must hold even when config resolution is the thing that fails.
    const config = injectedConfig ?? resolveConfig({ cwd: root });
    const provider = injectedProvider ?? createProvider(config);
    const baseBranch = base ?? config.project?.baseBranch ?? 'main';

    const includeGlobs =
      Array.isArray(include) && include.length > 0 ? include : ['story-*'];
    const excludeGlobs = Array.isArray(exclude) ? [...exclude] : [];
    if (typeof current === 'string' && current.length > 0) {
      excludeGlobs.push(current);
    }

    // Story #5112 — one critical section, one lock. `single-story-init.js`
    // reaps the same merged `story-*` branches through the same engine; when
    // the two surfaces held differently named lockfiles they could run
    // concurrently, each deleting branches the other had already planned.
    // Both now resolve the path through `resolveSweepLockPath`.
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

    // Story #4794 — the temp-retention catch-up. Two eligibility signals, both
    // already paid for: every branch this sweep reaped is a merge it CONFIRMED
    // (merged PR + matching headRefOid), so those Stories' artifacts are spent;
    // and the age floor collects everything else — the backlog from Stories
    // merged before this existed, merged through the GitHub UI, or whose branch
    // was already gone. Best-effort like the sweep itself: `runBootSweep`'s
    // catch swallows any throw into the `ok: false` envelope, and exit stays 0.
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
 * Build the human-readable one-line summary for a sweep result envelope.
 * Exported for unit tests (Story #4396). A zero `contentMerged` count keeps
 * the pre-Story #4396 line byte-identical (silent no-op summary); a nonzero
 * count appends a routing hint pointing the operator at `/git-cleanup`.
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
 * The CLI core: parse argv, run the sweep, render the report. Extracted from
 * the `main` shell so the argv → render decision table is reachable without
 * spawning a real sweep against a real git tree.
 *
 * Both seams on the optional final `deps` parameter default to the real
 * implementation (`docs/contributing/test-seams.md` rules 1-2), so `main` and any
 * production caller are unchanged.
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
