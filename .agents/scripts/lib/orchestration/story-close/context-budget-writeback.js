/**
 * context-budget-writeback.js — when the tree measures under its recorded
 * context-budget totals, write the lower totals back as one
 * `baseline-refresh:` commit on the Story branch, so a stale total can't
 * silently absorb the next growth.
 *
 * Runs at the pre-gate seam, not post-land: the only sanctioned landing is
 * branch → PR → `main`, so a post-land write would commit to the base branch.
 *
 * Only a downward move is written — any growth or unbacked row skips and
 * leaves `check-context-budget.js` to fail. Idempotent; every failure is a
 * named skip, never a failed close.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TOLERANCE_BYTES,
  buildBaseline as defaultBuildBaseline,
  diffBudget as defaultDiffBudget,
  loadBaseline as defaultLoadBaseline,
} from '../../../check-context-budget.js';
import { resolveDocTiers as defaultResolveDocTiers } from '../../doc-tiers.js';
import { gitSync as defaultGitSync } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const TAG = '[context-budget-writeback]';

const BASELINE_REL_PATH = 'baselines/context-budget.json';

/**
 * Carries the `baseline-refresh:` marker `refresh-ack.js` recognises.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): baseline-refresh: lower context-budget totals (story #${storyId})`;
}

/**
 * @param {Array<{ tier: string, current: number, baseline: number }>} shrunk
 * @returns {string}
 */
function buildCommitBody(shrunk) {
  return [
    'Documentation tiers this branch trimmed under their recorded totals,',
    'written back so the budget stops holding slack the tree no longer',
    'spends. Growth and unbacked rows are never rewritten here.',
    '',
    ...shrunk.map((s) => `- ${s.tier}: ${s.baseline} -> ${s.current} bytes`),
  ].join('\n');
}

/**
 * @param {object} logger
 * @param {string} reason
 */
function skip(logger, reason) {
  logger.info?.(`${TAG} no write-back (${reason}).`);
  return { ran: false, committed: false, reason };
}

/**
 * Returns a skip reason or `null`.
 *
 * @param {{ workTree: string, storyBranch: string, git: Function, relPath: string }} ctx
 * @returns {string|null}
 */
function precheck({ workTree, storyBranch, git, relPath }) {
  const onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workTree,
  });
  if (onBranch !== storyBranch) return 'wrong-branch';
  const status = git(['status', '--porcelain', '--', relPath], {
    cwd: workTree,
  });
  if (status.length > 0) return 'dirty-tree';
  return null;
}

/**
 * Write the envelope and fold it into one commit. On a rejected commit the
 * file is restored so the gates score the tree the close found.
 *
 * @param {{ workTree: string, git: Function, relPath: string, envelope: object, storyId: number|string, shrunk: object[] }} args
 * @returns {{ sha: string }}
 */
function commitBaseline({ workTree, git, relPath, envelope, storyId, shrunk }) {
  fs.writeFileSync(
    path.join(workTree, relPath),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  git(['add', '--', relPath], { cwd: workTree });
  try {
    git(
      [
        'commit',
        '-m',
        buildCommitSubject(storyId),
        '-m',
        buildCommitBody(shrunk),
      ],
      { cwd: workTree },
    );
  } catch (err) {
    git(['restore', '--staged', '--worktree', '--', relPath], {
      cwd: workTree,
    });
    throw err;
  }
  return { sha: git(['rev-parse', '--short', 'HEAD'], { cwd: workTree }) };
}

/**
 * @param {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyId: number|string,
 *   storyBranch?: string,
 *   config: object,
 *   logger?: object,
 *   gitSync?: (cwd: string, ...args: string[]) => string,
 *   resolveDocTiersImpl?: typeof defaultResolveDocTiers,
 *   loadBaselineImpl?: typeof defaultLoadBaseline,
 *   diffBudgetImpl?: typeof defaultDiffBudget,
 *   buildBaselineImpl?: typeof defaultBuildBaseline,
 * }} opts
 * @returns {{ ran: boolean, committed: boolean, sha?: string, tiers?: string[], reason?: string }}
 */
export function runContextBudgetWriteback({
  cwd,
  worktreePath,
  storyId,
  storyBranch,
  config,
  logger = DefaultLogger,
  gitSync = defaultGitSync,
  resolveDocTiersImpl = defaultResolveDocTiers,
  loadBaselineImpl = defaultLoadBaseline,
  diffBudgetImpl = defaultDiffBudget,
  buildBaselineImpl = defaultBuildBaseline,
} = {}) {
  if (!cwd || !storyBranch) return skip(logger, 'missing-context');
  const workTree = worktreePath || cwd;
  const git = (args, opts = {}) => gitSync(opts.cwd ?? workTree, ...args);
  try {
    const blocked = precheck({
      workTree,
      storyBranch,
      git,
      relPath: BASELINE_REL_PATH,
    });
    if (blocked) return skip(logger, blocked);
    const baseline = loadBaselineImpl(path.join(workTree, BASELINE_REL_PATH));
    if (!baseline) return skip(logger, 'no-baseline');
    const tierMap = resolveDocTiersImpl(config, { root: workTree });
    const diff = diffBudgetImpl(tierMap, baseline);
    if (diff.grown.length > 0 || diff.absent.length > 0) {
      return skip(logger, 'drift-not-downward');
    }
    if (diff.shrunk.length === 0) return skip(logger, 'no-shrink');
    const tolerance = Number.isFinite(baseline.toleranceBytes)
      ? baseline.toleranceBytes
      : DEFAULT_TOLERANCE_BYTES;
    const { sha } = commitBaseline({
      workTree,
      git,
      relPath: BASELINE_REL_PATH,
      envelope: buildBaselineImpl(tierMap, tolerance),
      storyId,
      shrunk: diff.shrunk,
    });
    const tiers = diff.shrunk.map((s) => s.tier);
    logger.warn?.(
      `${TAG} wrote back lower totals for ${tiers.join(', ')} on story #${storyId}; committed as ${sha}.`,
    );
    return { ran: true, committed: true, sha, tiers };
  } catch (err) {
    return skip(logger, `failed: ${err?.message ?? err}`);
  }
}
