#!/usr/bin/env node

/**
 * git-cleanup-branches.js — General-purpose merged-branch sweeper.
 *
 * Standalone counterpart to `delete-epic-branches.js`. Where the Epic
 * reaper targets `epic/<id>` + its hierarchy, this script sweeps every
 * local branch whose PR is merged to `agentSettings.baseBranch` (any
 * merge style — `gh pr list --state merged` covers squash-merged PRs
 * that `git branch --merged` misses) and reaps them safely:
 *
 *   1. Detach any attached worktree via `git worktree remove --force`.
 *   2. Delete the local branch via `git branch -D` (shared lib).
 *   3. Optionally delete the `origin/` remote ref (only when --remote).
 *
 * Dry-run is the default. `--execute` is required to mutate anything;
 * `--remote` is required on top of `--execute` to touch `origin/`.
 *
 * Flags:
 *   --dry-run            (default) enumerate candidates, mutate nothing.
 *   --execute            perform local reap.
 *   --remote             also reap `origin/<branch>` (requires --execute).
 *   --json               emit a structured JSON envelope on stdout.
 *   --include <glob>     allow-list pattern (repeatable). When provided,
 *                        only branches matching ≥1 include glob are
 *                        considered.
 *   --exclude <glob>     deny-list pattern (repeatable). Always wins
 *                        against --include.
 *   --base <branch>      override `agentSettings.baseBranch`.
 *   --cwd <path>         operate against a different checkout.
 *
 * Exit codes:
 *   0 — clean (dry-run preview, or all reaps succeeded).
 *   1 — at least one reap failed.
 *   2 — no candidates matched (informational).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import picomatch from 'picomatch';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import {
  deleteBranchLocal,
  deleteBranchRemote,
} from './lib/git-branch-cleanup.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { parseWorktreePorcelain } from './lib/worktree-manager.js';

/**
 * Pure: parse argv into the normalized CLI option bag. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   execute: boolean,
 *   remote: boolean,
 *   json: boolean,
 *   include: string[],
 *   exclude: string[],
 *   base: string|null,
 *   cwd: string|null,
 * }}
 */
export function parseCleanupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      include: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      base: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  // Dry-run is the default. The only way to flip into execute mode is
  // --execute. Passing --dry-run explicitly is also honoured (and wins
  // over --execute when both are passed — the safer choice).
  const execute = values.execute === true && values['dry-run'] !== true;
  return {
    dryRun: !execute,
    execute,
    remote: values.remote === true,
    json: values.json === true,
    include: Array.isArray(values.include) ? values.include : [],
    exclude: Array.isArray(values.exclude) ? values.exclude : [],
    base: typeof values.base === 'string' ? values.base : null,
    cwd: typeof values.cwd === 'string' ? values.cwd : null,
  };
}

/**
 * Pure: build a `(branch) => boolean` filter from include/exclude globs.
 * An empty include list means "everything is allowed". Exclude always
 * wins.
 *
 * @param {{ include?: string[], exclude?: string[] }} opts
 * @returns {(branch: string) => boolean}
 */
export function buildGlobFilter({ include = [], exclude = [] } = {}) {
  const includeMatch = include.length > 0 ? picomatch(include) : () => true;
  const excludeMatch = exclude.length > 0 ? picomatch(exclude) : () => false;
  return (branch) => includeMatch(branch) && !excludeMatch(branch);
}

/**
 * Pure: compute the protected-branch skip set. Always includes `main`,
 * the current HEAD branch, and any name from `branch.protectedBranches`.
 *
 * @param {{ baseBranch: string, currentBranch: string|null, configured: string[] }} opts
 * @returns {Set<string>}
 */
export function computeProtectedSet({ baseBranch, currentBranch, configured }) {
  const set = new Set();
  if (baseBranch) set.add(baseBranch);
  if (currentBranch) set.add(currentBranch);
  for (const name of configured ?? []) {
    if (name) set.add(name);
  }
  return set;
}

/**
 * List every local branch via `git for-each-ref refs/heads/`.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
/* node:coverage ignore next */
function listLocalBranches(cwd) {
  const res = gitSpawn(
    cwd,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/',
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * List branches that `git branch --merged <base>` reports as already
 * merged (covers non-squash merges that wouldn't show up via `gh`).
 *
 * @param {string} cwd
 * @param {string} base
 * @returns {string[]}
 */
/* node:coverage ignore next */
function listMergedBranches(cwd, base) {
  const res = gitSpawn(
    cwd,
    'branch',
    '--merged',
    base,
    '--format=%(refname:short)',
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Return the current HEAD branch name, or `null` for detached HEAD.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
/* node:coverage ignore next */
function currentBranch(cwd) {
  const res = gitSpawn(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Read `git config branch.protectedBranches` and return the
 * whitespace-separated list, or `[]` if unset.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
/* node:coverage ignore next */
function readProtectedConfig(cwd) {
  const res = gitSpawn(cwd, 'config', '--get', 'branch.protectedBranches');
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Map of `branch -> worktree record` for every checked-out worktree.
 *
 * @param {string} cwd
 * @returns {Map<string, { path: string, branch: string }>}
 */
/* node:coverage ignore next */
function worktreesByBranch(cwd) {
  const res = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  if (res.status !== 0) return new Map();
  const records = parseWorktreePorcelain(res.stdout);
  const map = new Map();
  for (const r of records) {
    if (r.branch && r.path)
      map.set(r.branch, { path: r.path, branch: r.branch });
  }
  return map;
}

/**
 * Check whether a branch has a merged PR via `gh`. Returns the PR
 * metadata or `null` if no merged PR exists.
 *
 * Implemented as a thin wrapper around an injected runner so tests can
 * stub `gh` without touching the CLI.
 *
 * @param {string} branch
 * @param {string} cwd
 * @param {(args: string[], opts: { cwd: string }) => string} runGh
 * @returns {{ number: number, mergedAt: string|null } | null}
 */
export function probeMergedPr(branch, cwd, runGh = defaultGhRunner) {
  const out = runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number,mergedAt',
      '--limit',
      '1',
    ],
    { cwd },
  );
  const trimmed = (out ?? '').trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const row = parsed[0];
  return {
    number: Number(row.number) || 0,
    mergedAt: row.mergedAt ?? null,
  };
}

/* node:coverage ignore next */
function defaultGhRunner(args, { cwd }) {
  return execFileSync('gh', args, { cwd, encoding: 'utf8' });
}

/**
 * Pure-ish: enumerate merged-branch candidates given the injected
 * accessors. Returns the candidate list + the set of names that were
 * skipped (protected, filtered, or non-merged) so callers can surface
 * an accurate summary in `--json` mode.
 *
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   localLister?: (cwd: string) => string[],
 *   mergedLister?: (cwd: string, base: string) => string[],
 *   currentBranchFn?: (cwd: string) => string|null,
 *   protectedConfigFn?: (cwd: string) => string[],
 *   worktreesFn?: (cwd: string) => Map<string, { path: string, branch: string }>,
 *   prProbe?: (branch: string, cwd: string) => ({ number: number, mergedAt: string|null } | null),
 *   filter?: (branch: string) => boolean,
 * }} ctx
 * @returns {{
 *   candidates: Array<{
 *     branch: string,
 *     prNumber: number|null,
 *     mergedAt: string|null,
 *     hasWorktree: boolean,
 *     worktreePath: string|null,
 *     detectedBy: 'gh'|'git-merged',
 *   }>,
 *   skipped: Array<{ branch: string, reason: string }>,
 * }}
 */
export function planCleanup(ctx) {
  const {
    cwd,
    baseBranch,
    localLister = listLocalBranches,
    mergedLister = listMergedBranches,
    currentBranchFn = currentBranch,
    protectedConfigFn = readProtectedConfig,
    worktreesFn = worktreesByBranch,
    prProbe = (b, c) => probeMergedPr(b, c),
    filter = () => true,
  } = ctx;

  const protectedSet = computeProtectedSet({
    baseBranch,
    currentBranch: currentBranchFn(cwd),
    configured: protectedConfigFn(cwd),
  });
  const wtMap = worktreesFn(cwd);
  const mergedByGit = new Set(mergedLister(cwd, baseBranch));
  const localBranches = localLister(cwd);

  const candidates = [];
  const skipped = [];

  for (const branch of localBranches) {
    if (protectedSet.has(branch)) {
      skipped.push({ branch, reason: 'protected' });
      continue;
    }
    if (!filter(branch)) {
      skipped.push({ branch, reason: 'filtered' });
      continue;
    }

    let prInfo = null;
    let detectedBy = null;
    // `gh pr list` is the authoritative path — it catches squash merges
    // that `git branch --merged` misses. We still consult the git-side
    // listing as a fallback for the rare merge-commit / fast-forward
    // case where no PR exists.
    prInfo = prProbe(branch, cwd);
    if (prInfo) {
      detectedBy = 'gh';
    } else if (mergedByGit.has(branch)) {
      detectedBy = 'git-merged';
    } else {
      skipped.push({ branch, reason: 'not-merged' });
      continue;
    }

    const wt = wtMap.get(branch);
    candidates.push({
      branch,
      prNumber: prInfo?.number ?? null,
      mergedAt: prInfo?.mergedAt ?? null,
      hasWorktree: !!wt,
      worktreePath: wt?.path ?? null,
      detectedBy,
    });
  }

  return { candidates, skipped };
}

/**
 * Pure-ish: execute the reap plan. Always removes attached worktrees
 * first, then the local branch, then (optionally) the remote ref.
 *
 * @param {{
 *   candidates: ReturnType<typeof planCleanup>['candidates'],
 *   cwd: string,
 *   remote: boolean,
 *   removeWorktreeFn?: (worktreePath: string, cwd: string) => { ok: boolean, dirty: boolean, stderr?: string },
 *   deleteLocalFn?: (branch: string, cwd: string) => ReturnType<typeof deleteBranchLocal>,
 *   deleteRemoteFn?: (branch: string, cwd: string) => ReturnType<typeof deleteBranchRemote>,
 *   logger?: { info: (m: string) => void, warn: (m: string) => void, error: (m: string) => void },
 * }} ctx
 */
export function executeCleanup(ctx) {
  const {
    candidates,
    cwd,
    remote,
    removeWorktreeFn = removeWorktree,
    deleteLocalFn = (b, c) => deleteBranchLocal(b, { cwd: c, force: true }),
    deleteRemoteFn = (b, c) => deleteBranchRemote(b, { cwd: c }),
    logger = Logger,
  } = ctx;

  const worktrees = [];
  const local = [];
  const remoteResults = [];
  const failures = [];

  for (const cand of candidates) {
    if (cand.hasWorktree && cand.worktreePath) {
      const wtRes = removeWorktreeFn(cand.worktreePath, cwd);
      worktrees.push({
        path: cand.worktreePath,
        ok: wtRes.ok,
        dirty: wtRes.dirty,
        stderr: wtRes.stderr,
      });
      if (wtRes.dirty) {
        logger.warn?.(
          `[git-cleanup-branches] ⚠️ dirty worktree force-removed: ${cand.worktreePath}`,
        );
      }
      if (!wtRes.ok) {
        failures.push({
          branch: cand.branch,
          scope: 'worktree',
          stderr: wtRes.stderr,
        });
        // Skip the local-branch delete when the worktree removal failed —
        // `git branch -D` refuses to delete a branch that's checked out
        // somewhere, so retrying would just compound the error.
        continue;
      }
    }

    const localRes = deleteLocalFn(cand.branch, cwd);
    local.push({
      branch: cand.branch,
      ok: localRes.deleted,
      reason: localRes.reason,
      alreadyGone: localRes.reason === 'not-found',
      stderr: localRes.stderr,
    });
    if (!localRes.deleted) {
      failures.push({
        branch: cand.branch,
        scope: 'local',
        reason: localRes.reason,
        stderr: localRes.stderr,
      });
      continue;
    }

    if (remote) {
      const remoteRes = deleteRemoteFn(cand.branch, cwd);
      remoteResults.push({
        branch: cand.branch,
        ok: remoteRes.deleted,
        reason: remoteRes.reason,
        alreadyGone: remoteRes.reason === 'not-found',
        stderr: remoteRes.stderr,
      });
      if (!remoteRes.deleted) {
        failures.push({
          branch: cand.branch,
          scope: 'remote',
          reason: remoteRes.reason,
          stderr: remoteRes.stderr,
        });
      }
    }
  }

  return {
    worktrees,
    local,
    remote: remoteResults,
    failures,
    ok: failures.length === 0,
  };
}

/**
 * Force-remove a worktree. Captures whether the working tree was dirty
 * (git's "contains modified or untracked files" failure on a plain
 * `worktree remove`) so the operator can audit it after the fact.
 *
 * @param {string} worktreePath
 * @param {string} cwd
 * @returns {{ ok: boolean, dirty: boolean, stderr?: string }}
 */
/* node:coverage ignore next */
function removeWorktree(worktreePath, cwd) {
  // Try without --force first so we can distinguish "clean reap" from
  // "had to force". The story interface contract requires force-on-dirty
  // (operator already confirmed) but the audit signal matters.
  const plain = gitSpawn(cwd, 'worktree', 'remove', worktreePath);
  if (plain.status === 0) {
    return { ok: true, dirty: false };
  }
  const forced = gitSpawn(cwd, 'worktree', 'remove', '--force', worktreePath);
  if (forced.status === 0) {
    return { ok: true, dirty: true, stderr: plain.stderr };
  }
  return {
    ok: false,
    dirty: true,
    stderr: forced.stderr || plain.stderr,
  };
}

/** Pure: render the dry-run plan as the operator-facing text block. */
export function renderDryRun(plan) {
  const lines = [
    `[git-cleanup-branches] DRY RUN (nothing deleted) — ${plan.candidates.length} candidate(s)`,
  ];
  if (plan.candidates.length === 0) {
    lines.push('  (no merged branches to clean up)');
    return lines;
  }
  for (const c of plan.candidates) {
    const pr = c.prNumber ? `PR #${c.prNumber}` : c.detectedBy;
    const wt = c.hasWorktree ? ` (worktree: ${c.worktreePath})` : '';
    lines.push(`  • ${c.branch} — ${pr}${wt}`);
  }
  return lines;
}

/** Pure: render a per-branch execution line. */
export function renderExecutionLine(entry, scope) {
  const icon = entry.ok ? '✅' : '❌';
  const label = scope.padEnd(8);
  const tag =
    scope === 'local' || scope === 'remote' ? entry.branch : entry.path;
  const note = entry.alreadyGone
    ? ' (already gone)'
    : entry.dirty
      ? ' (forced — was dirty)'
      : '';
  return `[git-cleanup-branches] ${icon} ${label} ${tag}${note}`;
}

/** Pure: render the trailing summary line. */
export function renderExecutionSummary(result) {
  if (!result.ok) {
    return `[git-cleanup-branches] ❌ ${result.failures.length} failure(s) during cleanup.`;
  }
  return `[git-cleanup-branches] ✅ Reaped ${result.local.length} local + ${result.remote.length} remote + ${result.worktrees.length} worktree(s).`;
}

/* node:coverage ignore next */
function emitDryRunHuman(plan) {
  for (const line of renderDryRun(plan)) Logger.info(line);
}

/* node:coverage ignore next */
function emitExecutionHuman(result) {
  for (const r of result.worktrees)
    Logger.info(renderExecutionLine(r, 'worktree'));
  for (const r of result.local) Logger.info(renderExecutionLine(r, 'local'));
  for (const r of result.remote) Logger.info(renderExecutionLine(r, 'remote'));
  const summary = renderExecutionSummary(result);
  if (result.ok) Logger.info(summary);
  else Logger.error(summary);
}

/* node:coverage ignore next */
function emitJson(payload, fail) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (fail) process.exit(1);
}

/* node:coverage ignore next */
function resolveBaseBranch(cwd, override) {
  if (override) return override;
  try {
    const cfg = resolveConfig({ cwd });
    return cfg?.agentSettings?.baseBranch || 'main';
  } catch {
    return 'main';
  }
}

const EMPTY_RESULT = Object.freeze({
  worktrees: [],
  local: [],
  remote: [],
  failures: [],
  ok: true,
});

/**
 * Pure: build the JSON envelope emitted in `--json` mode. The shape is
 * identical across the empty / dry-run / execute branches; only the
 * field values differ. Extracted so the CLI orchestrator stays linear.
 *
 * @param {{ dryRun: boolean, baseBranch: string, plan: { candidates: Array, skipped: Array }, result?: { worktrees: Array, local: Array, remote: Array, failures: Array, ok: boolean } }} args
 */
export function buildJsonEnvelope({ dryRun, baseBranch, plan, result }) {
  const r = result ?? EMPTY_RESULT;
  return {
    dryRun,
    baseBranch,
    candidates: plan.candidates,
    skipped: plan.skipped,
    worktrees: r.worktrees,
    local: r.local,
    remote: r.remote,
    failures: r.failures,
    ok: r.ok,
  };
}

/* node:coverage ignore next */
async function main() {
  const opts = parseCleanupArgs(process.argv.slice(2));
  const cwd = path.resolve(opts.cwd ?? PROJECT_ROOT);
  const baseBranch = resolveBaseBranch(cwd, opts.base);
  const filter = buildGlobFilter({
    include: opts.include,
    exclude: opts.exclude,
  });

  const plan = planCleanup({ cwd, baseBranch, filter });
  const result =
    !opts.dryRun && plan.candidates.length > 0
      ? executeCleanup({
          candidates: plan.candidates,
          cwd,
          remote: opts.remote,
        })
      : null;

  if (opts.json) {
    emitJson(
      buildJsonEnvelope({ dryRun: opts.dryRun, baseBranch, plan, result }),
      result ? !result.ok : false,
    );
  } else if (result) {
    emitExecutionHuman(result);
  } else {
    emitDryRunHuman(plan);
  }

  if (plan.candidates.length === 0) process.exit(2);
  if (result && !result.ok) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'git-cleanup-branches' });
