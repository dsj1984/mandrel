/**
 * baseline-upward-writeback.js — persist improved maintainability rows on the
 * branch that earned them, as one `baseline-refresh:` commit ahead of the
 * close gates. The diff-scoped ratchet only reds on regressions, so nothing
 * else writes an improvement back.
 *
 * Invariants:
 *  1. Only classifier `improvements` are written — a regression never enters
 *     the written set, so it still fails the gate.
 *  2. Maintainability only: CRAP rows re-key on `method@startLine` when code
 *     above moves, so write-back there is churn.
 *  3. Changed files only — a full-scope write would absorb other branches'
 *     drift into whichever PR lands next.
 *  4. Idempotent: no empty commit.
 */

import path from 'node:path';

import {
  compare as compareMaintainability,
  projectRow as projectMaintainabilityRow,
} from '../../baselines/kinds/maintainability.js';
import {
  _internals as baselineReaderInternals,
  load as loadBaselineEnvelope,
} from '../../baselines/reader.js';
import {
  refreshBaseline as defaultRefreshBaseline,
  resolveDefaultScorer,
} from '../../baselines/refresh-service.js';
import { getQuality } from '../../config-resolver.js';
import { gitSync as defaultGitSync } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  currentBranch,
  listChangedFiles,
  listDirtyPaths,
} from './format-autofix.js';

const TAG = '[baseline-writeback]';

const KIND = 'maintainability';

/** Matches the drift detector's maintainability default tolerance. */
const DEFAULT_TOLERANCE = 0.5;

const SCORABLE = /\.(?:m?[jt]sx?)$/i;

/**
 * Skips that fire before any scoring, so `ran: false` means exactly "a guard
 * stopped this"; outcome reasons are deliberately absent.
 */
const GUARD_REASONS = new Set([
  'gate-disabled',
  'no-changed-files',
  'wrong-branch',
  'dirty-tree',
  'no-baseline',
  'no-scorer',
]);

/**
 * Deltas under the tolerance are float noise; writing them is churn.
 *
 * @param {object|undefined} gate resolved `delivery.quality.gates.maintainability`
 * @returns {number}
 */
function resolveTolerance(gate) {
  const configured = gate?.tolerance;
  if (configured?.kind === 'absolute') {
    const value = Number(configured.value);
    if (Number.isFinite(value)) return Math.abs(value);
  }
  return DEFAULT_TOLERANCE;
}

/**
 * Read the DECLARED `quality.gates[kind]` block, not the `quality[kind]`
 * projection, which drops `enabled` and flattens `tolerance`. A resolver that
 * throws reads as framework defaults (gate enabled).
 *
 * @param {object|undefined} config
 * @returns {object|undefined}
 */
function resolveGate(config) {
  try {
    return getQuality(config)?.gates?.[KIND];
  } catch {
    return undefined;
  }
}

/**
 * Project scorer output through the writer's own `projectRow` so scored and
 * committed rows are comparable; unprojectable rows are dropped.
 *
 * @param {Array<object>} rows
 * @returns {Array<{ path: string, mi: number }>}
 */
function projectRows(rows) {
  const out = [];
  for (const row of rows ?? []) {
    try {
      const projected = projectMaintainabilityRow(row);
      if (Number.isFinite(projected.mi)) out.push(projected);
    } catch {
      // Unprojectable row → not evidence of an improvement.
    }
  }
  return out;
}

/**
 * The base side is narrowed to scored paths: maintainability's
 * `removedRowPolicy` counts a missing head row as an improvement, which in a
 * scoped compare would rewrite every untouched file. `additions` are excluded
 * too. Pure.
 *
 * @param {{ scoredRows: Array<object>, baselineRows: Array<object>, tolerance: number }} opts
 * @returns {Array<{ path: string, mi: number }>} the head rows to persist
 */
function selectImprovedRows({ scoredRows, baselineRows, tolerance }) {
  const scoredPaths = new Set(scoredRows.map((row) => row.path));
  const baseSubset = (baselineRows ?? []).filter((row) =>
    scoredPaths.has(row?.path),
  );
  if (baseSubset.length === 0) return [];

  const result = compareMaintainability(
    { rows: scoredRows },
    { rows: baseSubset },
  );
  const improved = [];
  for (const entry of result?.improvements ?? []) {
    const head = entry?.head;
    const base = entry?.base;
    if (!head || !base) continue;
    if (head.mi - base.mi <= tolerance) continue;
    improved.push(head);
  }
  return improved;
}

/**
 * One before → after line per row: the durable record of what was touched
 * (a `baseline-refresh:` commit must carry a non-empty body).
 *
 * @param {Array<{ path: string, mi: number }>} improved
 * @param {Array<object>} baselineRows
 * @returns {string}
 */
function buildCommitBody(improved, baselineRows) {
  const priorByPath = new Map(
    (baselineRows ?? []).map((row) => [row?.path, row?.mi]),
  );
  const lines = [
    'Rows the branch improved on files it touched, written back so the',
    'committed baseline stops falling behind the tree in the upward',
    'direction. Scoped to the branch changed set; no regression is rewritten.',
    '',
  ];
  for (const row of improved) {
    const before = Number(priorByPath.get(row.path) ?? 0).toFixed(2);
    lines.push(`- ${row.path}: ${before} -> ${row.mi.toFixed(2)}`);
  }
  return lines.join('\n');
}

/**
 * Conventional for commitlint, carrying the `baseline-refresh:` marker that
 * `refresh-ack.js` recognises, and fixed-length apart from the id so it stays
 * under the 100-char cap.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): baseline-refresh: improved maintainability rows (story #${storyId})`;
}

/**
 * Stage and commit the baseline file with hooks enabled. On a rejected commit
 * the file is reset to HEAD so the close leaves a clean tree.
 *
 * @param {{ cwd: string, git: Function, relPath: string, subject: string, body: string }} opts
 * @returns {{ sha: string }}
 */
function commitBaseline({ cwd, git, relPath, subject, body }) {
  git(['add', '--', relPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['commit', '-m', subject, '-m', body], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // `checkout --` would restore from the index `git add` just overwrote —
    // a silent no-op. Reset both index and worktree to HEAD.
    git(['restore', '--staged', '--worktree', '--', relPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw err;
  }
  const sha = git(['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { sha: String(sha ?? '').trim() };
}

/**
 * Guards that must hold before scoring; returns a skip reason or `null`.
 * The branch check runs before any write. The dirty-tree check refuses an
 * uncommitted edit on the baseline file, which would otherwise be swept into
 * a `baseline-refresh:` commit that `refresh-ack.js` vouches for — i.e.
 * laundered.
 *
 * @param {{ gate: object|undefined, workTree: string, storyBranch: string, git: Function, changed: string[], relPath: string }} ctx
 * @returns {string|null}
 */
function precheck({ gate, workTree, storyBranch, git, changed, relPath }) {
  if (gate?.enabled === false) return 'gate-disabled';
  if (changed.length === 0) return 'no-changed-files';
  const onBranch = currentBranch(workTree, git);
  if (onBranch !== storyBranch) return 'wrong-branch';
  if (isDirty({ workTree, git, relPath })) return 'dirty-tree';
  return null;
}

/**
 * Fails CLOSED on unreadable status; skipping only costs a stale upward row.
 *
 * @param {{ workTree: string, git: Function, relPath: string }} ctx
 * @returns {boolean}
 */
function isDirty({ workTree, git, relPath }) {
  try {
    return listDirtyPaths(workTree, git).includes(relPath);
  } catch {
    return true;
  }
}

/**
 * Prefer `origin/<base>`: a stale local base (worktrees never pull it) widens
 * the three-dot range to files landed after the fork, violating invariant 3.
 *
 * @param {{ workTree: string, git: Function, baseBranch: string }} ctx
 * @returns {string}
 */
function resolveScopeBase({ workTree, git, baseBranch }) {
  try {
    git(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`],
      {
        cwd: workTree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return `origin/${baseBranch}`;
  } catch {
    return baseBranch;
  }
}

/**
 * Persist improved rows for the branch's changed files as one commit. Every
 * no-op returns a named `reason`; this step never fails a close —
 * `check-baselines` remains the gate.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath?: string,
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   config?: object,
 *   logger?: object,
 *   gitSync?: (cwd: string, ...args: string[]) => string,
 *   loadBaselineRows?: (opts: { cwd: string }) => Array<object>|null,
 *   scoreFiles?: (files: string[], opts: object) => Promise<Array<object>>|Array<object>,
 *   refreshBaseline?: typeof defaultRefreshBaseline,
 *   resolveWritePath?: (opts: { cwd: string }) => string,
 * }} opts
 * @returns {Promise<{
 *   ran: boolean,
 *   committed: boolean,
 *   sha?: string,
 *   improvedPaths?: string[],
 *   reason?: string,
 * }>}
 */
export async function runBaselineUpwardWriteback({
  cwd,
  worktreePath,
  storyId,
  baseBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  gitSync = defaultGitSync,
  loadBaselineRows = defaultLoadBaselineRows,
  scoreFiles,
  refreshBaseline = defaultRefreshBaseline,
  resolveWritePath = defaultResolveWritePath,
} = {}) {
  if (!cwd) throw new Error('runBaselineUpwardWriteback: cwd is required');
  if (!baseBranch)
    throw new Error('runBaselineUpwardWriteback: baseBranch is required');
  if (!storyBranch)
    throw new Error('runBaselineUpwardWriteback: storyBranch is required');

  const workTree = worktreePath || cwd;
  // Adapt `gitSync(cwd, ...args)` to the `(args, opts)` shape format-autofix
  // expects; direct `node:child_process` use is forbidden by an enforcement test.
  const git = (args, opts = {}) => gitSync(opts.cwd ?? workTree, ...args);
  const gate = resolveGate(config);

  const changed = listChangedFiles({
    cwd: workTree,
    baseBranch: resolveScopeBase({ workTree, git, baseBranch }),
    storyBranch,
    git,
  }).filter((file) => SCORABLE.test(file));

  const writePath = resolveWritePath({ cwd: workTree });
  const relPath = path.relative(workTree, writePath).split(path.sep).join('/');

  const blocked = precheck({
    gate,
    workTree,
    storyBranch,
    git,
    changed,
    relPath,
  });
  if (blocked) return skip(logger, blocked);

  const baselineRows = loadBaselineRows({ cwd: workTree });
  if (!Array.isArray(baselineRows) || baselineRows.length === 0) {
    return skip(logger, 'no-baseline');
  }

  const score = scoreFiles ?? resolveDefaultScorer(KIND, { cwd: workTree });
  if (typeof score !== 'function') return skip(logger, 'no-scorer');
  const scoredRows = projectRows(
    await score(changed, { kind: KIND, fullScope: false, cwd: workTree }),
  );
  if (scoredRows.length === 0) return skip(logger, 'no-scored-rows');

  const improved = selectImprovedRows({
    scoredRows,
    baselineRows,
    tolerance: resolveTolerance(gate),
  });
  if (improved.length === 0) return skip(logger, 'no-improvements');

  return await persist({
    improved,
    baselineRows,
    workTree,
    git,
    storyId,
    logger,
    refreshBaseline,
    writePath,
    relPath,
  });
}

/**
 * Write through `refreshBaseline` (which owns canonicalization, out-of-scope
 * row preservation and the atomic write), passing the computed rows as its
 * scorer so files are scored once, then commit.
 *
 * @returns {Promise<{ ran: boolean, committed: boolean, sha?: string, improvedPaths?: string[], reason?: string }>}
 */
async function persist({
  improved,
  baselineRows,
  workTree,
  git,
  storyId,
  logger,
  refreshBaseline,
  writePath,
  relPath,
}) {
  const improvedPaths = improved.map((row) => row.path);
  const { wrote } = await refreshBaseline({
    kind: KIND,
    cwd: workTree,
    writePath,
    scopeFiles: improvedPaths,
    scorer: () => improved,
  });
  if (!wrote) return skip(logger, 'unchanged');

  const { sha } = commitBaseline({
    cwd: workTree,
    git,
    relPath,
    subject: buildCommitSubject(storyId),
    body: buildCommitBody(improved, baselineRows),
  });

  logger.warn?.(
    `${TAG} wrote back ${improvedPaths.length} improved ${KIND} row(s) ` +
      `on story #${storyId}: ${improvedPaths.join(', ')}; committed as ${sha}.`,
  );
  return { ran: true, committed: true, sha, improvedPaths };
}

/**
 * @param {object} logger
 * @param {string} reason
 */
function skip(logger, reason) {
  logger.info?.(`${TAG} no write-back (${reason}).`);
  return { ran: !GUARD_REASONS.has(reason), committed: false, reason };
}

/** Schema-validating read; an unreadable baseline reports `no-baseline`. */
function defaultLoadBaselineRows({ cwd }) {
  try {
    return loadBaselineEnvelope(KIND, { cwd })?.rows ?? null;
  } catch {
    return null;
  }
}

function defaultResolveWritePath({ cwd }) {
  return baselineReaderInternals.resolveBaselinePath(KIND, { cwd });
}
