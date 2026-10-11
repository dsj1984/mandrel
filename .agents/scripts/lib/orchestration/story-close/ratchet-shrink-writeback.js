/**
 * ratchet-shrink-writeback.js — at close, bank the burn-down of the dead-export
 * (default and `--production`) and cyclomatic ratchets, whose checks exit 0 on
 * removals so a burnt-down row would otherwise linger as slack.
 *
 * Shrink only: a baseline is rewritten only when its recomputed rows are a
 * strict subset of (cyclomatic: no worse than) the committed rows, so a write
 * never adds a row or raises a value. Rows come from each check's own
 * machinery. One `baseline-refresh:` commit; every failure is a named skip.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  diffRows as defaultDiffDeadExportRows,
  loadBaseline as loadJsonBaseline,
} from '../../../check-dead-exports.js';
import { getQuality } from '../../config-resolver.js';
import {
  DEFAULT_CYCLOMATIC_BASELINE,
  scanCyclomatic as defaultScanCyclomatic,
  diffCyclomaticRows,
  resolveCyclomaticPolicy,
} from '../../cyclomatic-ceiling.js';
import { resolveScanScope as defaultResolveScanScope } from '../../cyclomatic-scope.js';
import {
  runKnip as defaultRunKnip,
  extractRowsFromKnip,
} from '../../dead-exports-knip.js';
import { resolveDeadExportsMode } from '../../dead-exports-mode.js';
import { gitSync as defaultGitSync } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import { currentBranch, listDirtyPaths } from './format-autofix.js';

const TAG = '[ratchet-shrink]';

/**
 * Carries the `baseline-refresh:` marker `refresh-ack.js` recognises.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): baseline-refresh: drop burnt-down ratchet rows (story #${storyId})`;
}

/**
 * @param {Array<{ relPath: string, lines: string[] }>} shrinks
 * @returns {string}
 */
function buildCommitBody(shrinks) {
  const out = [
    'Dead-export and cyclomatic rows this branch burnt down, banked so the',
    'ratchet stops holding slack the tree no longer spends. Additions and',
    'rises are never written here.',
  ];
  for (const s of shrinks) out.push('', `${s.relPath}:`, ...s.lines);
  return out.join('\n');
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
 * One dead-export mode: the shrunk envelope, or a skip reason.
 *
 * @param {{ workTree: string, production: boolean, runKnip: Function, diffRows: Function }} ctx
 * @returns {{ relPath: string, envelope?: object, lines?: string[], reason?: string }}
 */
function planDeadExportShrink({
  workTree,
  production,
  runKnip = defaultRunKnip,
  diffRows = defaultDiffDeadExportRows,
}) {
  const { baseline } = resolveDeadExportsMode(production);
  const relPath = baseline.split(path.sep).join('/');
  const committed = loadJsonBaseline(path.join(workTree, baseline));
  if (!Array.isArray(committed?.rows))
    return { relPath, reason: 'no-baseline' };
  const report = runKnip({ cwd: workTree, production });
  // A failed or unrecognised report reads as "every row removed" — never shrink on it.
  if (!report?.ok) return { relPath, reason: 'knip-failed' };
  if (!Array.isArray(report.envelope?.issues)) {
    return { relPath, reason: 'knip-report-unusable' };
  }
  const diff = diffRows(committed.rows, extractRowsFromKnip(report.envelope));
  if (diff.added.length > 0) return { relPath, reason: 'not-a-shrink' };
  if (diff.removed.length === 0) return { relPath, reason: 'no-shrink' };
  const gone = new Set(diff.removed.map((r) => `${r.file}\0${r.symbol}`));
  return {
    relPath,
    envelope: {
      ...committed,
      rows: committed.rows.filter((r) => !gone.has(`${r.file}\0${r.symbol}`)),
    },
    lines: diff.removed.map((r) => `- ${r.file}: ${r.symbol}`),
  };
}

/**
 * Lower each improved row to the measured values; never above the prior.
 *
 * @param {Array<object>} rows committed rows
 * @param {{ removed: Array<object>, improved: Array<object> }} diff
 * @returns {Array<object>}
 */
function shrinkCyclomaticRows(rows, diff) {
  const gone = new Set(diff.removed.map((r) => r.file));
  const lowered = new Map(diff.improved.map((r) => [r.file, r]));
  const out = [];
  for (const row of rows) {
    if (gone.has(row.file)) continue;
    const cur = lowered.get(row.file);
    out.push(
      cur
        ? {
            ...row,
            methodsAboveCeiling: Math.min(
              row.methodsAboveCeiling,
              cur.methodsAboveCeiling,
            ),
            maxCyclomatic: Math.min(row.maxCyclomatic, cur.maxCyclomatic),
          }
        : row,
    );
  }
  return out;
}

/**
 * The cyclomatic shrink: the lowered envelope, or a skip reason.
 *
 * @param {{ workTree: string, config: object, scanCyclomatic: Function, resolveScanScope: Function }} ctx
 * @returns {{ relPath: string, envelope?: object, lines?: string[], reason?: string }}
 */
function planCyclomaticShrink({
  workTree,
  config,
  scanCyclomatic = defaultScanCyclomatic,
  resolveScanScope = defaultResolveScanScope,
}) {
  const relPath = DEFAULT_CYCLOMATIC_BASELINE;
  const committed = loadJsonBaseline(path.join(workTree, relPath));
  if (!Array.isArray(committed?.rows))
    return { relPath, reason: 'no-baseline' };
  const policy = resolveCyclomaticPolicy(getQuality(config));
  if (committed.ceiling !== policy.mustFix) {
    return { relPath, reason: 'ceiling-mismatch' };
  }
  const scan = scanCyclomatic({
    targetDirs: policy.targetDirs,
    ignoreGlobs: policy.ignoreGlobs,
    ceiling: policy.mustFix,
    cwd: workTree,
    scopeFiles: resolveScanScope({
      cwd: workTree,
      config,
      baselineRows: committed.rows,
    }),
  });
  // An unparseable file yields no row, which would read as a burnt-down one.
  if (scan.parseErrors > 0) return { relPath, reason: 'parse-errors' };
  const diff = diffCyclomaticRows(committed.rows, scan.rows);
  if (diff.added.length + diff.worsened.length > 0) {
    return { relPath, reason: 'not-a-shrink' };
  }
  if (diff.removed.length + diff.improved.length === 0) {
    return { relPath, reason: 'no-shrink' };
  }
  return {
    relPath,
    envelope: {
      ...committed,
      rows: shrinkCyclomaticRows(committed.rows, diff),
    },
    lines: [
      ...diff.removed.map((r) => `- ${r.file}: removed`),
      ...diff.improved.map(
        (r) =>
          `- ${r.file}: ${r.baselineCount}/${r.baselineMax} -> ${r.methodsAboveCeiling}/${r.maxCyclomatic}`,
      ),
    ],
  };
}

/**
 * Run a planner; a throw becomes a named skip for that baseline only.
 *
 * @param {string} relPath
 * @param {() => object} plan
 * @returns {object}
 */
function safePlan(relPath, plan) {
  try {
    return plan();
  } catch (err) {
    return { relPath, reason: `failed: ${err?.message ?? err}` };
  }
}

/**
 * Write every shrunk envelope and fold them into one commit. On a rejected
 * commit the files are restored so the gates score the tree the close found.
 *
 * @param {{ workTree: string, git: Function, shrinks: object[], storyId: number|string }} args
 * @returns {string} the short sha
 */
function commitShrinks({ workTree, git, shrinks, storyId }) {
  const paths = shrinks.map((s) => s.relPath);
  for (const s of shrinks) {
    fs.writeFileSync(
      path.join(workTree, s.relPath),
      `${JSON.stringify(s.envelope, null, 2)}\n`,
    );
  }
  git(['add', '--', ...paths], { cwd: workTree });
  try {
    git(
      [
        'commit',
        '-m',
        buildCommitSubject(storyId),
        '-m',
        buildCommitBody(shrinks),
      ],
      { cwd: workTree },
    );
  } catch (err) {
    git(['restore', '--staged', '--worktree', '--', ...paths], {
      cwd: workTree,
    });
    throw err;
  }
  return String(
    git(['rev-parse', '--short', 'HEAD'], { cwd: workTree }) ?? '',
  ).trim();
}

/**
 * Adapt `gitSync(cwd, ...args)` to the `(args, opts)` shape format-autofix uses.
 *
 * @param {(cwd: string, ...args: string[]) => string} gitSync
 * @param {string} workTree
 * @returns {(args: string[], opts?: { cwd?: string }) => string}
 */
function bindGit(gitSync, workTree) {
  return (args, opts = {}) => gitSync(opts.cwd ?? workTree, ...args);
}

/**
 * @param {{
 *   cwd: string,
 *   worktreePath?: string|null,
 *   storyId: number|string,
 *   storyBranch?: string,
 *   config?: object,
 *   logger?: object,
 *   gitSync?: (cwd: string, ...args: string[]) => string,
 *   runKnip?: typeof defaultRunKnip,
 *   scanCyclomatic?: typeof defaultScanCyclomatic,
 *   resolveScanScope?: typeof defaultResolveScanScope,
 * }} opts
 * @returns {{ ran: boolean, committed: boolean, sha?: string, baselines?: string[], skipped?: Record<string, string>, reason?: string }}
 */
export function runRatchetShrinkWriteback({
  cwd,
  worktreePath,
  storyId,
  storyBranch,
  config,
  logger = DefaultLogger,
  gitSync = defaultGitSync,
  runKnip = defaultRunKnip,
  scanCyclomatic = defaultScanCyclomatic,
  resolveScanScope = defaultResolveScanScope,
} = {}) {
  if (!cwd || !storyBranch) return skip(logger, 'missing-context');
  const workTree = worktreePath || cwd;
  const git = bindGit(gitSync, workTree);
  const relPaths = [
    resolveDeadExportsMode(false).baseline,
    resolveDeadExportsMode(true).baseline,
    DEFAULT_CYCLOMATIC_BASELINE,
  ].map((p) => p.split(path.sep).join('/'));
  try {
    if (currentBranch(workTree, git) !== storyBranch) {
      return skip(logger, 'wrong-branch');
    }
    const dirty = listDirtyPaths(workTree, git);
    if (relPaths.some((p) => dirty.includes(p))) {
      return skip(logger, 'dirty-tree');
    }
  } catch (err) {
    return skip(logger, `git-failed: ${err?.message ?? err}`);
  }

  const plans = [
    safePlan(relPaths[0], () =>
      planDeadExportShrink({ workTree, production: false, runKnip }),
    ),
    safePlan(relPaths[1], () =>
      planDeadExportShrink({ workTree, production: true, runKnip }),
    ),
    safePlan(relPaths[2], () =>
      planCyclomaticShrink({
        workTree,
        config,
        scanCyclomatic,
        resolveScanScope,
      }),
    ),
  ];
  const shrinks = plans.filter((p) => p.envelope);
  const skipped = Object.fromEntries(
    plans.filter((p) => p.reason).map((p) => [p.relPath, p.reason]),
  );
  if (shrinks.length === 0) {
    const detail = Object.entries(skipped)
      .map(([p, r]) => `${path.basename(p)}=${r}`)
      .join(', ');
    return { ...skip(logger, `no-shrink: ${detail}`), skipped };
  }
  try {
    const sha = commitShrinks({ workTree, git, shrinks, storyId });
    const baselines = shrinks.map((s) => s.relPath);
    logger.warn?.(
      `${TAG} dropped burnt-down rows from ${baselines.join(', ')} on story #${storyId}; committed as ${sha}.`,
    );
    return { ran: true, committed: true, sha, baselines, skipped };
  } catch (err) {
    return { ...skip(logger, `git-failed: ${err?.message ?? err}`), skipped };
  }
}
