/**
 * context-budget-writeback.js — lock a context-budget gain in on the branch
 * that earned it (Story #5313).
 *
 * `check-context-budget.js` used to fail a gated documentation tier that came
 * in **under** its recorded total (Story #4872), so a Story that trimmed prose
 * paid for the trim twice: once in the edit and once in the red gate whose
 * only remedy was a hand-run `--update`. Story #5313 reverses that rule —
 * shrinkage exits 0 and is reported — and this module answers the concern
 * the rule existed for: a stale recorded total silently absorbs the next
 * growth. When the tree the close is scoring measures under its recorded
 * totals, the lower totals are written back into
 * `baselines/context-budget.json` and folded into one `baseline-refresh:`
 * commit on the Story branch, so the gain lands in the branch's own PR.
 *
 * ## Where it runs, and why not post-land
 *
 * The Story names the post-land tail. This step runs from the close's
 * **pre-gate write-back seam** (`phases/pre-gate-steps.js`, beside the
 * maintainability write-back of Story #5224) instead: the only sanctioned
 * landing is the Story branch → PR → `main`, so a post-land write would have
 * to commit straight to the base branch. Writing on the branch ahead of the
 * gates keeps the row inside the PR the gates score and lets
 * `refresh-ack.js` vouch for it through the same `baseline-refresh:` marker.
 *
 * Constraints, each a "must not":
 *
 *  1. **Only a downward move is written.** Growth past tolerance and an
 *     unbacked recorded row must still fail `check-context-budget.js` exactly
 *     as before; when either is present this step skips and the gate speaks.
 *  2. **Idempotent and silent.** No shrink, no write, no commit.
 *  3. **Never fails the close.** Every failure is a named skip.
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

/** Repo-relative location of the committed budget. */
const BASELINE_REL_PATH = 'baselines/context-budget.json';

/**
 * Build the commit subject — conventional, carrying the `baseline-refresh:`
 * marker `refresh-ack.js` recognises, fixed-length but for the Story id.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): baseline-refresh: lower context-budget totals (story #${storyId})`;
}

/**
 * One line per tier that moved down, before → after.
 *
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
 * Report a no-op by name.
 *
 * @param {object} logger
 * @param {string} reason
 */
function skip(logger, reason) {
  logger.info?.(`${TAG} no write-back (${reason}).`);
  return { ran: false, committed: false, reason };
}

/**
 * Everything that must hold before a write. Returns a skip reason or `null`.
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
 * Write the lower context-budget totals back on the Story branch.
 *
 * Total: a throw anywhere is a named skip, never a failed close.
 *
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
