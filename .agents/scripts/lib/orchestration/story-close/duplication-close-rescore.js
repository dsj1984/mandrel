/**
 * duplication-close-rescore.js — at close, re-score the duplication rows of
 * the files the Story changed and commit any row that moved, either way.
 *
 * The commit is deliberately UNTAGGED (no `baseline-refresh:`): a tagged
 * commit would acknowledge the very rise it exists to expose, so a Story that
 * adds clones to a file it changed fails the head-vs-base compare at close.
 * The scan covers the whole tree (clones are pairwise); only changed-file rows
 * and their clone partners' rows are written. Every failure is a named skip, never a failed close.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  refreshBaseline as defaultRefreshBaseline,
  fileFilterFor,
  readPriorEnvelope,
} from '../../baselines/refresh-service.js';
import { getBaselineEpsilon } from '../../config/quality.js';
import { getQuality } from '../../config-resolver.js';
import { gitSync as defaultGitSync } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  currentBranch,
  listChangedFiles,
  listDirtyPaths,
} from './format-autofix.js';

const TAG = '[duplication-rescore]';

const KIND = 'duplication';

const DEFAULT_BASELINE_REL_PATH = 'baselines/duplication.json';

/**
 * Untagged on purpose (see the module header): never `baseline-refresh:`.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): re-score duplication rows for changed files (story #${storyId})`;
}

/**
 * @param {Array<{ path: string, before: number|null, after: number|null }>} moved
 * @returns {string}
 */
function buildCommitBody(moved) {
  const fmt = (v) => (v === null ? 'none' : `${v}%`);
  return [
    'Duplication rows for files this branch changed, re-scored at close so',
    'the head-vs-base duplication compare scores the tree rather than a',
    'stale committed row. Untagged: a rise here is a gate failure, not an',
    'acknowledged refresh.',
    '',
    ...moved.map((m) => `- ${m.path}: ${fmt(m.before)} -> ${fmt(m.after)}`),
  ].join('\n');
}

/**
 * @param {object} logger
 * @param {string} reason
 */
function skip(logger, reason) {
  logger.info?.(`${TAG} no re-score commit (${reason}).`);
  return { ran: false, committed: false, reason };
}

/**
 * Prefer `origin/<base>`: a stale local base widens the three-dot range.
 *
 * @param {{ workTree: string, git: Function, baseBranch: string }} ctx
 * @returns {string}
 */
function resolveScopeBase({ workTree, git, baseBranch }) {
  try {
    git(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`],
      { cwd: workTree },
    );
    return `origin/${baseBranch}`;
  } catch {
    return baseBranch;
  }
}

/**
 * Guards plus the scoped file list. A dirty baseline file would otherwise be
 * swept into the commit.
 *
 * @param {{ workTree: string, baseBranch: string, storyBranch: string, git: Function, relPath: string }} ctx
 * @returns {{ reason: string } | { files: string[] }}
 */
function resolveScope({ workTree, baseBranch, storyBranch, git, relPath }) {
  if (currentBranch(workTree, git) !== storyBranch) {
    return { reason: 'wrong-branch' };
  }
  if (listDirtyPaths(workTree, git).includes(relPath)) {
    return { reason: 'dirty-tree' };
  }
  const isScorable = fileFilterFor(KIND);
  const files = listChangedFiles({
    cwd: workTree,
    baseBranch: resolveScopeBase({ workTree, git, baseBranch }),
    storyBranch,
    git,
  }).filter((f) => isScorable(f));
  return files.length === 0 ? { reason: 'no-changed-files' } : { files };
}

/**
 * Scoped rows whose percentage moved, appeared or vanished.
 *
 * @param {{ files: string[], priorRows: object[], nextRows: object[] }} args
 * @returns {Array<{ path: string, before: number|null, after: number|null }>}
 */
function diffScopedRows({ files, priorRows, nextRows }) {
  const byPath = (rows) =>
    new Map((rows ?? []).map((r) => [r?.path, r?.percentage ?? null]));
  const before = byPath(priorRows);
  const after = byPath(nextRows);
  const moved = [];
  for (const file of files) {
    const b = before.get(file) ?? null;
    const a = after.get(file) ?? null;
    if (b !== a) moved.push({ path: file, before: b, after: a });
  }
  return moved;
}

/**
 * Stage and commit with hooks enabled; on a rejected commit restore the file
 * so the gates score the tree the close found.
 *
 * @param {{ workTree: string, git: Function, relPath: string, subject: string, body: string }} args
 * @returns {string} the short sha
 */
function commitBaseline({ workTree, git, relPath, subject, body }) {
  git(['add', '--', relPath], { cwd: workTree });
  try {
    git(['commit', '-m', subject, '-m', body], { cwd: workTree });
  } catch (err) {
    git(['restore', '--staged', '--worktree', '--', relPath], {
      cwd: workTree,
    });
    throw err;
  }
  return String(
    git(['rev-parse', '--short', 'HEAD'], { cwd: workTree }) ?? '',
  ).trim();
}

/**
 * @param {() => Promise<object>|object} fn
 * @param {string} label the skip-reason prefix on a throw
 * @returns {Promise<{ value?: object, reason?: string }>}
 */
async function attempt(fn, label) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { reason: `${label}: ${err?.message ?? err}` };
  }
}

/**
 * @param {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   config?: object,
 *   logger?: object,
 *   gitSync?: (cwd: string, ...args: string[]) => string,
 *   refreshBaseline?: typeof defaultRefreshBaseline,
 *   scorer?: (files: string[], opts: object) => Promise<object[]>|object[],
 * }} opts
 * @returns {Promise<{ ran: boolean, committed: boolean, sha?: string, movedPaths?: string[], reason?: string }>}
 */
export async function runDuplicationCloseRescore({
  cwd,
  worktreePath,
  storyId,
  baseBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  gitSync = defaultGitSync,
  refreshBaseline = defaultRefreshBaseline,
  scorer,
} = {}) {
  if (!cwd || !baseBranch || !storyBranch) {
    return skip(logger, 'missing-context');
  }
  const workTree = worktreePath || cwd;
  const git = (args, opts = {}) => gitSync(opts.cwd ?? workTree, ...args);

  // The DECLARED `gates.duplication` block — `quality.duplication` is undefined.
  const gate = await attempt(
    () => getQuality(config)?.gates?.[KIND] ?? {},
    'config-failed',
  );
  if (gate.reason) return skip(logger, gate.reason);
  if (gate.value.enabled === false) return skip(logger, 'gate-disabled');

  const relPath = gate.value.baselinePath ?? DEFAULT_BASELINE_REL_PATH;
  const writePath = path.resolve(workTree, relPath);
  const scope = await attempt(
    () => resolveScope({ workTree, baseBranch, storyBranch, git, relPath }),
    'git-failed',
  );
  if (scope.reason) return skip(logger, scope.reason);
  if (scope.value.reason) return skip(logger, scope.value.reason);
  const { files } = scope.value;

  const priorRows = readPriorEnvelope(writePath, fs)?.rows ?? [];
  const refreshed = await attempt(
    () =>
      refreshBaseline({
        kind: KIND,
        cwd: workTree,
        writePath,
        scopeFiles: files,
        epsilon: getBaselineEpsilon(KIND),
        ...(scorer ? { scorer } : {}),
      }),
    'scorer-failed',
  );
  if (refreshed.reason) return skip(logger, refreshed.reason);
  if (!refreshed.value?.wrote) return skip(logger, 'unchanged');

  const moved = diffScopedRows({
    files: refreshed.value.scope?.files ?? files,
    priorRows,
    nextRows: refreshed.value.envelope?.rows,
  });
  const committed = await attempt(
    () =>
      commitBaseline({
        workTree,
        git,
        relPath,
        subject: buildCommitSubject(storyId),
        body: buildCommitBody(moved),
      }),
    'git-failed',
  );
  if (committed.reason) return skip(logger, committed.reason);
  const movedPaths = moved.map((m) => m.path);
  logger.warn?.(
    `${TAG} re-scored ${movedPaths.length} duplication row(s) on story #${storyId}; committed as ${committed.value}.`,
  );
  return { ran: true, committed: true, sha: committed.value, movedPaths };
}
