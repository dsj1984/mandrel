#!/usr/bin/env node

/**
 * sync-branch-from-base.js — operator-facing CLI wrapper around
 * `lib/git/sync-from-base.js` (Story #2580).
 *
 * Use this from workflow markdown when the operator needs to sync a
 * working branch with `origin/<baseBranch>` before opening a PR — for
 * example as a pre-Phase-6 step in `/deliver` so the Epic→main PR
 * opens with the latest `main` commits already integrated.
 *
 * For `/single-story-deliver`, the sync runs in-process inside
 * `single-story-close.js`; this CLI is the operator surface for
 * workflows that don't have a built-in close pipeline.
 *
 * Usage:
 *   node .agents/scripts/sync-branch-from-base.js \
 *     --branch <branchName> --base <baseBranch> [--cwd <path>]
 *
 * Exit codes:
 *   0 — synced (`fast-forward`, `merge-commit`, or `noop-already-current`).
 *   1 — fetch/merge failed or conflict; error message on stderr names the
 *       outcome kind and (for conflicts) the conflicting file list.
 *
 * The script does NOT post structured comments or flip ticket labels —
 * it is a pure git operation. Recovery surfaces are the caller's
 * responsibility (the workflow doc tells the operator what to do when
 * this exits non-zero).
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { syncBranchFromBase } from './lib/git/sync-from-base.js';
import { gitSpawn, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { emitTerseResult } from './lib/observability/terse-result.js';
import { PROJECT_ROOT } from './lib/project-root.js';

const progress = Logger.createProgress('sync-branch-from-base', {
  stderr: true,
});

/**
 * Core runner. Exported for tests so the CLI surface can be exercised
 * without spawning a subprocess.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] Branch name expected to be checked out.
 * @param {string} [opts.base] Base branch name on origin (e.g. `main`).
 * @param {string} [opts.cwd] Worktree or repo root. Defaults to PROJECT_ROOT.
 * @param {typeof syncBranchFromBase} [opts.injectedSync] Test-only seam.
 * @param {(cwd: string, ...args: string[]) => string} [opts.injectedGitSync]
 *   Test-only seam for the branch-name guard.
 */
export async function runSyncBranchFromBase(opts = {}) {
  const parsed = opts.branch ? opts : parseArgv(process.argv.slice(2));
  const branch = opts.branch ?? parsed.branch;
  const base = opts.base ?? parsed.base;
  if (!branch || !base) {
    throw new Error(
      'Usage: node sync-branch-from-base.js --branch <branchName> --base <baseBranch> [--cwd <path>]',
    );
  }
  const cwd = path.resolve(opts.cwd ?? parsed.cwd ?? PROJECT_ROOT);

  // Guard: refuse to sync if the active branch doesn't match the
  // operator's intent. A mismatched checkout would merge `origin/<base>`
  // into the wrong branch — silently — and only surface as a confusing
  // diff later. Skipped when injectedGitSync is set so tests can run
  // without a real git repo.
  const gitSyncFn = opts.injectedGitSync ?? gitSync;
  let activeBranch = null;
  try {
    activeBranch = gitSyncFn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch (err) {
    throw new Error(
      `[sync-branch-from-base] Could not resolve active branch in ${cwd}: ${err?.message ?? err}`,
    );
  }
  if (activeBranch !== branch) {
    throw new Error(
      `[sync-branch-from-base] Active branch is "${activeBranch}" but --branch is "${branch}". ` +
        `Check out ${branch} first, or pass --cwd to the correct worktree.`,
    );
  }

  progress('INIT', `Syncing ${branch} from origin/${base} in ${cwd}...`);
  const syncFn = opts.injectedSync ?? syncBranchFromBase;
  const result = await syncFn({
    cwd,
    baseBranch: base,
    log: (tag, msg) => progress(tag, msg),
    gitSpawn,
  });

  // Story #4685 — full detail to a temp log; emit a single summary line.
  emitTerseResult({
    label: 'SYNC RESULT',
    result,
    scope: branch,
    logDir: path.join(cwd, 'temp', 'orchestration'),
    summary: { branch, base, synced: result.synced, kind: result.kind },
  });

  if (!result.synced) {
    const detail =
      result.kind === 'conflict'
        ? `: ${result.conflictFiles?.join(', ') ?? '(no file list)'}`
        : result.stderr
          ? `: ${result.stderr.slice(0, 200)}`
          : '';
    throw new Error(
      `[sync-branch-from-base] sync failed (${result.kind})${detail}`,
    );
  }
  progress('DONE', `✅ Synced ${branch} from origin/${base} (${result.kind}).`);
  return { success: true, result };
}

/**
 * Tiny argv parser scoped to this CLI's three flags. Exported for
 * tests.
 */
export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      branch: { type: 'string' },
      base: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  return {
    branch: values.branch ?? null,
    base: values.base ?? null,
    cwd: values.cwd ?? null,
  };
}

runAsCli(import.meta.url, runSyncBranchFromBase, {
  source: 'sync-branch-from-base',
});
