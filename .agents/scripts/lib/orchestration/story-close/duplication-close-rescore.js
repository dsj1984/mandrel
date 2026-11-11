/**
 * duplication-close-rescore.js — at close, re-score the duplication rows of
 * the files the Story changed and commit any row that moved, either way.
 *
 * The commit is deliberately UNTAGGED (no `baseline-refresh:`): a tagged
 * commit would acknowledge the very rise it exists to expose, so a Story that
 * adds clones to a file it changed fails the head-vs-base compare at close.
 * The scan covers the whole tree (clones are pairwise); only changed-file rows
 * and their clone partners' rows are written. Every failure is a named skip, never a failed close.
 *
 * A skipped base sync passes `baselineRef` (the merge-base): the change set is
 * scoped on it, and no row is written for a path `origin/<base>` changed since,
 * because the tree holds that file's merge-base version and main owns its row.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  refreshBaseline as defaultRefreshBaseline,
  fileFilterFor,
  readPriorEnvelope,
} from '../../baselines/refresh-service.js';
import { writeFile as writeEnvelopeFile } from '../../baselines/writer.js';
import { getBaselineEpsilon } from '../../config/quality.js';
import { getQuality } from '../../config-resolver.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import { closeGitSync as defaultGitSync } from './commit-body.js';
import {
  currentBranch,
  listChangedFiles,
  listDirtyPaths,
} from './format-autofix.js';

const TAG = '[duplication-rescore]';

const KIND = 'duplication';

export const DEFAULT_BASELINE_REL_PATH = 'baselines/duplication.json';

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
function skip(logger, reason, extra = {}) {
  logger.info?.(`${TAG} no re-score commit (${reason}).`);
  return { ran: false, committed: false, reason, ...extra };
}

/** A completed scan that moved nothing still reports its clone partners. */
function unchanged(logger, partners) {
  return skip(logger, 'unchanged', { moved: [], partners });
}

/** @returns {object} a committed re-score's result. */
function committedResult(sha, moved, partners) {
  const movedPaths = moved.map((m) => m.path);
  return { ran: true, committed: true, sha, movedPaths, moved, partners };
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
 * Paths `origin/<base>` changed since `baselineRef`; the base-sync probe's
 * raw-path rule. Throws on a failed diff.
 *
 * @param {{ workTree: string, git: Function, scopeBase: string, baselineRef: string }} ctx
 * @returns {string[]}
 */
function listIncomingFiles({ workTree, git, scopeBase, baselineRef }) {
  const out = git(
    ['diff', '--name-only', '--no-renames', baselineRef, scopeBase],
    { cwd: workTree },
  );
  return String(out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The change-set base and the incoming paths a skipped base sync excludes.
 *
 * @param {{ workTree: string, git: Function, baseBranch: string, baselineRef?: string }} ctx
 * @returns {{ diffBase: string, exclude: string[] }}
 */
function resolveScopeRefs({ workTree, git, baseBranch, baselineRef }) {
  const scopeBase = resolveScopeBase({ workTree, git, baseBranch });
  if (!baselineRef) return { diffBase: scopeBase, exclude: [] };
  return {
    diffBase: baselineRef,
    exclude: listIncomingFiles({ workTree, git, scopeBase, baselineRef }),
  };
}

/**
 * The scanned HEAD, the scoped file list and the paths whose rows stay
 * untouched. Read-only ref queries only: never `git status`.
 *
 * @param {{ workTree: string, baseBranch: string, storyBranch: string, git: Function, additionalFormats?: string[], baselineRef?: string }} ctx
 * @returns {{ reason: string } | { head: string, files: string[], exclude: string[] }}
 */
function resolveScope({
  workTree,
  baseBranch,
  storyBranch,
  git,
  additionalFormats,
  baselineRef,
}) {
  if (currentBranch(workTree, git) !== storyBranch) {
    return { reason: 'wrong-branch' };
  }
  const head = readHead(workTree, git);
  const { diffBase, exclude } = resolveScopeRefs({
    workTree,
    git,
    baseBranch,
    baselineRef,
  });
  const isScorable = fileFilterFor(KIND, { additionalFormats });
  const files = listChangedFiles({
    cwd: workTree,
    baseBranch: diffBase,
    storyBranch,
    git,
  }).filter((f) => isScorable(f));
  return files.length === 0
    ? { reason: 'no-changed-files' }
    : { head, files, exclude };
}

function readHead(workTree, git) {
  return String(git(['rev-parse', 'HEAD'], { cwd: workTree }) ?? '').trim();
}

/**
 * Why the scanned rows may not be committed now: HEAD moved since the scan,
 * the branch changed, or a dirty baseline would be swept into the commit.
 *
 * @returns {Promise<string|null>}
 */
async function applyRefusal({ relPath, head }, opts) {
  const { workTree, git } = gitFor(opts);
  const refusal = await attempt(() => {
    if (readHead(workTree, git) !== head) return 'head-moved';
    if (currentBranch(workTree, git) !== opts.storyBranch) {
      return 'wrong-branch';
    }
    return listDirtyPaths(workTree, git).includes(relPath)
      ? 'dirty-tree'
      : null;
  }, 'git-failed');
  return refusal.reason ?? refusal.value;
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
 * @typedef {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   baselineRef?: string,
 *   config?: object,
 *   logger?: object,
 *   gitSync?: (cwd: string, ...args: string[]) => string,
 *   refreshBaseline?: typeof defaultRefreshBaseline,
 *   scorer?: (files: string[], opts: object) => Promise<object[]>|object[],
 * }} RescoreOptions
 */

/** @param {RescoreOptions} opts */
function gitFor({ cwd, worktreePath, gitSync = defaultGitSync }) {
  const workTree = worktreePath || cwd;
  return {
    workTree,
    git: (args, opts = {}) => gitSync(opts.cwd ?? workTree, ...args),
  };
}

/**
 * Score the tree and diff the scoped rows at the recorded HEAD, writing
 * nothing and committing nothing.
 *
 * @param {RescoreOptions} opts
 * @returns {Promise<object>} a named skip (`reason`), or the scan:
 *   `{ head, relPath, writePath, envelope, wrote, changed, moved, partners }`.
 */
export async function scanDuplicationRescore(opts = {}) {
  const { logger = DefaultLogger } = opts;
  if (!opts.cwd || !opts.baseBranch || !opts.storyBranch) {
    return skip(logger, 'missing-context');
  }
  const { workTree, git } = gitFor(opts);
  const gate = await resolveGate(opts.config);
  if (gate.reason) return skip(logger, gate.reason);
  const { additionalFormats, baselinePath } = gate.value;
  const scope = await attempt(
    () => resolveScope({ ...opts, workTree, git, additionalFormats }),
    'git-failed',
  );
  const reason = scope.reason ?? scope.value.reason;
  if (reason) return skip(logger, reason);
  const relPath = baselinePath ?? DEFAULT_BASELINE_REL_PATH;
  const writePath = path.resolve(workTree, relPath);
  const priorRows = readPriorEnvelope(writePath, fs)?.rows ?? [];
  const refreshed = await attempt(
    () => refreshScope({ ...opts, ...scope.value, workTree, writePath }),
    'scorer-failed',
  );
  if (refreshed.reason) return skip(logger, refreshed.reason);
  const { head, files } = scope.value;
  return scanResult(refreshed.value, {
    head,
    files,
    priorRows,
    relPath,
    writePath,
  });
}

/** The DECLARED `gates.duplication` block — `quality.duplication` is undefined. */
async function resolveGate(config) {
  const gate = await attempt(
    () => getQuality(config)?.gates?.[KIND] ?? {},
    'config-failed',
  );
  if (gate.value?.enabled === false) return { reason: 'gate-disabled' };
  return gate;
}

/** Score the scoped files without writing the baseline. */
function refreshScope({
  refreshBaseline = defaultRefreshBaseline,
  scorer,
  workTree,
  writePath,
  files,
  exclude,
}) {
  return refreshBaseline({
    kind: KIND,
    cwd: workTree,
    writePath,
    scopeFiles: files,
    excludeWriteFiles: exclude,
    epsilon: getBaselineEpsilon(KIND),
    write: false,
    ...(scorer ? { scorer } : {}),
  });
}

/** A completed scan: the envelope to write and the scoped rows that moved. */
function scanResult(refreshed, { files, priorRows, ...rest }) {
  const { partners = {}, envelope, wrote = false } = refreshed;
  const changed = refreshed.changed ?? wrote;
  const moved = changed
    ? diffScopedRows({
        files: refreshed.scope?.files ?? files,
        priorRows,
        nextRows: envelope?.rows,
      })
    : [];
  return { ...rest, envelope, wrote, changed, moved, partners };
}

/**
 * Write a scan's envelope and commit it untagged; a scan skip passes through.
 * Refused (named skip, nothing written) once HEAD, the branch or the
 * baseline file moved since the scan.
 *
 * @param {object} scan {@link scanDuplicationRescore}'s result.
 * @param {RescoreOptions} opts
 * @returns {Promise<{ ran: boolean, committed: boolean, sha?: string, movedPaths?: string[], reason?: string, moved?: Array<{ path: string, before: number|null, after: number|null }>, partners?: Record<string, string[]> }>}
 */
export async function applyDuplicationRescore(scan, opts = {}) {
  if (scan?.reason) return scan;
  const { logger = DefaultLogger } = opts;
  const refused = await applyRefusal(scan, opts);
  if (refused) return skip(logger, refused);
  if (!scan.changed) return unchanged(logger, scan.partners);
  // A refresh that ignored `write: false` already wrote the file.
  const written = scan.wrote
    ? {}
    : await attempt(
        () => writeEnvelopeFile(scan.writePath, scan.envelope),
        'write-failed',
      );
  if (written.reason) return skip(logger, written.reason);
  return commitScan(scan, opts);
}

/** Commit a written scan untagged; a refused commit is a named skip. */
async function commitScan({ relPath, moved, partners }, opts) {
  const { storyId, logger = DefaultLogger } = opts;
  const committed = await attempt(
    () =>
      commitBaseline({
        ...gitFor(opts),
        relPath,
        subject: buildCommitSubject(storyId),
        body: buildCommitBody(moved),
      }),
    'git-failed',
  );
  if (committed.reason) return skip(logger, committed.reason);
  logger.warn?.(
    `${TAG} re-scored ${moved.length} duplication row(s) on story #${storyId}; committed as ${committed.value}.`,
  );
  return committedResult(committed.value, moved, partners);
}

/**
 * Close's re-score: {@link scanDuplicationRescore} then
 * {@link applyDuplicationRescore}.
 *
 * @param {RescoreOptions} opts
 * @returns {Promise<object>} `moved` and `partners` (write-scope clone
 *   partners) whenever a scan completed.
 */
export async function runDuplicationCloseRescore(opts = {}) {
  return applyDuplicationRescore(await scanDuplicationRescore(opts), opts);
}
