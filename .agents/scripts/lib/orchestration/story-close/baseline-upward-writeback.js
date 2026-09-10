/**
 * baseline-upward-writeback.js — persist improved maintainability rows on the
 * branch that earned them (Story #5224).
 *
 * The diff-scoped baseline ratchet only ever reds on a REGRESSION. A branch
 * that *improves* a file it touched is therefore waved through with its
 * committed row left describing the worse, older tree — and nothing on the
 * per-PR path ever writes it back. The only thing that notices is the nightly
 * full-scope re-score (`check-baseline-drift.js`), which had filed the same
 * one-command chore seven times before this module existed.
 *
 * The classifier already does the hard half: `kinds/kind-factory.js#classify`
 * partitions every compared row into `regressions` / `improvements` /
 * `unchanged` / `additions`, and the enforcement path forwards `improvements`
 * all the way to the report. Nothing persisted it. This module is that
 * missing half — run from the close's `close-validation` phase, ahead of the
 * gate chain, so the refreshed row lands in the branch's own PR.
 *
 * Shape borrowed from {@link ../story-close/format-autofix.js#runScopedFormatAutofix}:
 * scope to the branch's changed-file set, fold the writes into one dedicated
 * commit ahead of the gates, log the paths touched, and inject every
 * git / baseline / scoring collaborator so the unit tests never spawn git
 * (`.agents/rules/test-seams.md`).
 *
 * Four constraints bind the design, and every one of them is a "must not":
 *
 *  1. **Only `improvements` are written.** A regression must still fail the
 *     gate exactly as it does today. A write-back that could launder one
 *     makes the baseline actively worse than leaving it stale, so a regressed
 *     row is never in the written set — it is not filtered out downstream, it
 *     never enters.
 *  2. **`maintainability` only.** CRAP's drift identity is
 *     `path::method@startLine`, which re-keys whenever anything above a
 *     method moves, so the same treatment there is churn rather than signal.
 *     That is exactly why the nightly watches maintainability alone.
 *  3. **Changed files only — never a full-scope regeneration.** A full-scope
 *     write at land time would absorb unrelated drift from other branches
 *     into whichever PR happened to land next, and would fight the
 *     row-identity merge driver that exists to keep concurrent refreshes
 *     apart (Story #5215).
 *  4. **Idempotent and silent.** No empty commit; a second close over the
 *     same tree finds nothing left to improve and commits nothing.
 *
 * The authored commit carries the `baseline-refresh:` marker
 * `phases/refresh-ack.js` recognises, so the refreshed rows are vouched for
 * rather than read as fresh drift, and its subject is conventional so
 * commitlint accepts it.
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

/** The one kind this module touches. See constraint 2 in the preamble. */
const KIND = 'maintainability';

/**
 * Absolute drift tolerance when the gate configures none. Mirrors
 * `drift-detector.js`'s `KIND_SPECS.maintainability.defaultTolerance`, so the
 * per-PR write-back and the nightly full-scope check agree on what counts as
 * movement rather than float noise.
 */
const DEFAULT_TOLERANCE = 0.5;

/** Files the maintainability scorer can measure at all. */
const SCORABLE = /\.(?:m?[jt]sx?)$/i;

/**
 * Reasons reported before the step scored anything, so `ran: false` means
 * exactly "a guard stopped this before any work happened" rather than the
 * softer "nothing came of it". `no-scored-rows`, `no-improvements` and
 * `unchanged` are deliberately absent: those are outcomes of a run.
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
 * Resolve the gate's absolute tolerance. Anything below it is float noise the
 * ratchet already refuses to red on, so writing it back would be churn — and
 * churn on a file every concurrent branch also touches is the one cost this
 * step must not add.
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
 * Read the maintainability gate block as DECLARED — `quality.gates[kind]`, not
 * the sibling `quality[kind]` projection. The two differ in exactly the two
 * fields this module reads: the projection drops `enabled` entirely and
 * flattens `tolerance` to a bare number, so reading it would silently make the
 * gate un-disablable and every configured tolerance unreadable. `evaluate.js`
 * receives this same declared block as its `gateBlock`, which is what keeps
 * the write-back's notion of "moved" identical to the gate's.
 *
 * Tolerates a resolver that throws (a malformed config under a tmp cwd). An
 * unresolvable config reads as "framework defaults", which enable the gate —
 * the same reading `projections/advisories.js#isEnabled` applies.
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
 * Normalise scorer output into the on-disk row shape so scored rows and
 * committed rows are directly comparable. `projectRow` is the same projection
 * the writer applies, which is what makes the two sides comparable at all.
 * A row the writer itself would refuse is dropped rather than compared.
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
 * Select the rows this branch has genuinely improved.
 *
 * The base side is deliberately narrowed to the rows the head side actually
 * scored. `compare()` classifies a base row with no head row through the
 * kind's `removedRowPolicy`, which for maintainability pushes an
 * **improvement** ("the file is gone, so its debt is gone too"). That policy
 * is correct for a full-scope compare and catastrophic for a scoped one: every
 * untouched file in the repo would arrive here as an improvement and be
 * rewritten from a score nobody computed. Narrowing the base to the scored
 * keys means every comparison has both sides, so the removed-row arm cannot
 * fire at all — and the `head === null` guard below makes that structural
 * rather than incidental.
 *
 * `additions` — a scored file with no committed row — is likewise excluded:
 * constraint 1 admits only what the classifier calls an improvement, and a new
 * file's row is the ordinary refresh path's business, not this step's.
 *
 * Pure.
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
 * Render the commit body: one line per rewritten row, before → after. The body
 * is the durable record of what the step touched — the `Logger` line scrolls
 * out of a close transcript, this does not — and `check-baseline-drift.js`'s
 * remedy text asks a `baseline-refresh:` commit to carry a non-empty body.
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
 * Build the commit subject. Conventional (`chore(baselines): …`) so commitlint
 * accepts it, carrying the `baseline-refresh:` marker as a plain substring so
 * `refresh-ack.js#resolveRefreshTrigger` recognises it, and fixed-length in
 * everything but the Story id so it cannot drift past commitlint's 100-char
 * subject cap.
 *
 * @param {number|string} storyId
 * @returns {string}
 */
function buildCommitSubject(storyId) {
  return `chore(baselines): baseline-refresh: improved maintainability rows (story #${storyId})`;
}

/**
 * Stage the single baseline file and commit it. Hooks must run; never pass
 * `--no-verify` (project policy).
 *
 * On a commit failure the written file is restored, because everything
 * downstream — base-sync, the push, the gate chain's own reads — assumes the
 * close left the worktree clean. A half-applied write-back that survives as an
 * uncommitted edit would silently change what the gates score without ever
 * reaching the PR.
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
    // `git checkout -- <path>` restores the WORKTREE from the index — and the
    // index is exactly what the `git add` above just overwrote, so on a
    // rejected commit it restored the file to the value it was meant to be
    // rolled back FROM. The rollback was a no-op that looked like one, and the
    // rewritten row survived as a staged edit into whatever the gates scored
    // next. `restore --staged --worktree` resets both to HEAD, which is what
    // "leave the tree as the close found it" actually means.
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
 * Everything that must hold before the step is allowed to score anything.
 * Returns a skip reason, or `null` to proceed.
 *
 * The branch assertion runs here — before the write, not before the commit —
 * so a mis-wired `worktreePath` can never leave a modified baseline in a tree
 * whose history we then refuse to touch.
 *
 * The dirty-tree guard is the same refusal `runScopedFormatAutofix` makes and
 * for the same reason, sharpened to one path: this step's only write target is
 * the baseline file, and it commits that file by name. An uncommitted edit
 * sitting on it — a hand-run `maintainability:reanchor`, a half-resolved merge,
 * an operator mid-edit — would be swept into a `baseline-refresh:` commit
 * authored by close and attributed to rows this branch improved. That commit is
 * the one `refresh-ack.js` VOUCHES for, so an absorbed edit is not merely
 * unrelated: it arrives pre-acknowledged, which is the precise laundering this
 * whole Story exists to close.
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
 * Is the baseline file already modified in the worktree or the index?
 *
 * Fails CLOSED on an unreadable status: a step that cannot tell whether it is
 * about to absorb someone else's edit must not proceed, and skipping costs
 * only a stale upward row that the nightly full-scope re-score still catches.
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
 * The ref the branch's changed-file set is measured against.
 *
 * `origin/<baseBranch>` when the remote-tracking ref exists, the local branch
 * otherwise. A local `main` in a long-lived checkout — and in every Story
 * worktree, which is seeded once and never pulled again — drifts behind the
 * remote, and a stale base widens the three-dot range to include commits that
 * landed on the base after the branch forked. Every file in that widening is
 * then scored and written back by whichever Story happens to close next, which
 * is precisely the "absorb unrelated drift into the next PR" failure
 * constraint 3 in the preamble forbids.
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
 * Persist improved maintainability rows for the files this branch changed, and
 * fold them into one `baseline-refresh:` commit on the Story branch.
 *
 * Every no-op is reported by name rather than silently: `gate-disabled`,
 * `no-changed-files`, `wrong-branch`, `dirty-tree`, `no-baseline`,
 * `no-scored-rows`, `no-improvements`, `unchanged`. The caller logs the reason and proceeds —
 * this step is never allowed to fail a close, because `check-baselines` is
 * still the gate and this is only the refresh half of the loop.
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
  // The two format-autofix helpers below take git as `(args, opts) => stdout`;
  // `git-utils.gitSync` is `(cwd, ...args) => trimmed stdout` and throws on a
  // non-zero exit. Adapt rather than reach for `node:child_process` directly —
  // the shared surface owns the stdout ceiling, `shell: false` and error
  // normalisation, and `tests/enforcement/child-process-imports.test.js`
  // enforces that.
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
 * Write the selected rows through the one sanctioned write funnel and commit
 * them. The already-computed rows are handed to `refreshBaseline` as its
 * scorer so the files are scored exactly once — the service still owns path
 * canonicalization, `mergeRows` (which preserves every out-of-scope row
 * byte-for-byte), rollup, envelope stamping and the atomic write.
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
  // The writer short-circuits on structural equality, so `wrote: false` means
  // the committed rows already carried these values — nothing to commit, and
  // nothing worth a log line above debug.
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
 * Report a no-op by name. Every skip is `info`-level: none of them is a
 * problem, and the close transcript already carries one line per phase.
 *
 * @param {object} logger
 * @param {string} reason
 */
function skip(logger, reason) {
  logger.info?.(`${TAG} no write-back (${reason}).`);
  return { ran: !GUARD_REASONS.has(reason), committed: false, reason };
}

/**
 * Default committed-row loader — the schema-validating reader, so a baseline
 * this module would refuse to compare against is reported as `no-baseline`
 * rather than half-read.
 */
function defaultLoadBaselineRows({ cwd }) {
  try {
    return loadBaselineEnvelope(KIND, { cwd })?.rows ?? null;
  } catch {
    return null;
  }
}

/** Default on-disk location of the maintainability baseline. */
function defaultResolveWritePath({ cwd }) {
  return baselineReaderInternals.resolveBaselinePath(KIND, { cwd });
}
