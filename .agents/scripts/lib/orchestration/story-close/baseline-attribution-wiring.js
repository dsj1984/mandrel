/**
 * baseline-attribution-wiring.js — glue between the close-validation gate
 * chain and the diff-based attribution classifier (Story #1124).
 *
 * `runPreMergeGates` throws on the first failed gate but does not surface
 * regression rows. For baseline gates (`check-maintainability`, `check-crap`)
 * the post-#1120 contract is to:
 *
 *   1. Compute the regressions list ourselves (the pre-merge MI projection
 *      already knows how — Story #874).
 *   2. Compute the Story's diff vs `epic/<id>` so the classifier can split
 *      attributable from non-attributable rows.
 *   3. If every regression is attributable, run the gate's refresh command
 *      (`npm run maintainability:update` / `npm run crap:update`) inside
 *      the worktree, stage the changed baseline file, and commit on the
 *      Story branch with a `baseline-refresh: ...` subject. The caller
 *      then re-runs the gate chain — drift is now committed, gate passes.
 *   4. If any regression is non-attributable, render the friction body
 *      (`renderBaselineFrictionBody`) and upsert it via
 *      `upsertStructuredComment`. Return a status that signals story-close
 *      to short-circuit with `{ status: 'blocked', phase: 'closing' }`.
 *
 * The wiring is gate-agnostic at the API level — every dependency is
 * injected — but ships with a default gate registry covering the two
 * baseline gates we own today. Adding a new baseline gate is a registry
 * append; the orchestration here doesn't change.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { readBaselineAtRef as defaultReadBaselineAtRef } from '../../baseline-loader.js';
import { projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions } from '../../close-validation.js';
import { getBaselines as defaultGetBaselines } from '../../config-resolver.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';
import { classifyBaselineDrift as defaultClassifyBaselineDrift } from './baseline-attribution.js';
import { renderBaselineFrictionBody as defaultRenderBaselineFrictionBody } from './baseline-friction-body.js';
import { runPreMergeGates as defaultRunPreMergeGates } from './pre-merge-validation.js';

/**
 * Map gate names → metadata used to project regressions and refresh the
 * baseline. Only baseline-style gates appear here; non-baseline gates
 * (typecheck, lint, test, format) fall through and the orchestrator
 * re-throws the original gate error.
 *
 * The `refreshCmd` shape is `{ cmd: string, args: string[] }` so the
 * caller can spawn it without re-parsing a shell string. Both `--prefix`-
 * style monorepo overrides and direct `node` invocations work.
 */
const DEFAULT_GATE_REGISTRY = {
  'check-maintainability': {
    refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
    refreshSubject: 'baseline-refresh: maintainability',
    baselineHint: 'maintainability',
  },
  'check-crap': {
    refreshCmd: { cmd: 'npm', args: ['run', 'crap:update'] },
    refreshSubject: 'baseline-refresh: crap',
    baselineHint: 'crap',
  },
};

/**
 * Compute repo-relative paths the Story branch changed vs `origin/<epicBranch>`.
 * Best-effort: a non-zero diff exit returns an empty array so the caller
 * conservatively treats every regression as non-attributable (the safer
 * default — the close blocks rather than absorbs sibling drift).
 */
export function computeStoryDiffPaths({
  cwd,
  epicBranch,
  storyBranch,
  gitRunner = { gitSpawn: defaultGitSpawn },
}) {
  if (!cwd || !epicBranch || !storyBranch) return [];
  const diff = gitRunner.gitSpawn(
    cwd,
    'diff',
    '--name-only',
    `origin/${epicBranch}...${storyBranch}`,
  );
  if (diff.status !== 0) return [];
  return (diff.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));
}

/**
 * Resolve a "prior" `baseline-refresh:` commit SHA the current refresh
 * should fold into rather than emit a sibling for. `cycleState` (mutable,
 * passed by the retry loop) wins when populated; otherwise we look at
 * HEAD's subject — a refresh commit at the tip is fair game to amend.
 *
 * Returns the SHA (short or long — either works with `git show`/`git
 * diff --cached`) or `null` when no prior refresh is in scope.
 *
 * @param {{
 *   cwd: string,
 *   cycleState?: { priorRefreshSha?: string|null } | null,
 *   gitRunner: { gitSpawn: typeof defaultGitSpawn },
 * }} input
 * @returns {string|null}
 */
function resolvePriorRefreshSha({ cwd, cycleState, gitRunner }) {
  if (cycleState?.priorRefreshSha) return cycleState.priorRefreshSha;
  const subjRes = gitRunner.gitSpawn(cwd, 'log', '-1', '--format=%s', 'HEAD');
  if (subjRes.status !== 0) return null;
  const subject = (subjRes.stdout || '').trim();
  if (!subject.startsWith('baseline-refresh:')) return null;
  const shaRes = gitRunner.gitSpawn(cwd, 'rev-parse', 'HEAD');
  if (shaRes.status !== 0) return null;
  return (shaRes.stdout || '').trim() || null;
}

/**
 * Story #2176 — preserve the single-commit-per-close-cycle invariant when
 * a prior `baseline-refresh:` commit is in scope. The staged tree is
 * compared against that prior commit's tree via `git diff --cached
 * <priorSha>`:
 *
 *   - empty diff → the new refresh reproduces the prior baseline exactly;
 *     unstage and return `{ skipped: true, reason: 'no-baseline-drift' }`
 *     so no commit lands.
 *   - non-empty diff → drift differs from the prior commit; amend the
 *     prior with `git commit --amend --no-edit` instead of emitting a
 *     sibling `baseline-refresh:` commit.
 *
 * The caller has already run the refresh command, staged with
 * `git add -u`, and confirmed `git status --porcelain` is non-empty.
 *
 * @returns {{ ok: true, sha: string, skipped?: boolean, amended?: boolean, reason?: string }
 *   | { ok: false, error: string }}
 */
function foldIntoPriorRefresh({
  cwd,
  priorSha,
  cycleState,
  gitRunner,
  logger,
}) {
  const driftRes = gitRunner.gitSpawn(cwd, 'diff', '--cached', priorSha);
  if (driftRes.status !== 0) {
    return {
      ok: false,
      error: `git diff --cached ${priorSha} failed: ${driftRes.stderr || driftRes.stdout}`,
    };
  }
  if ((driftRes.stdout || '').length === 0) {
    gitRunner.gitSpawn(cwd, 'reset', 'HEAD', '--');
    logger?.info?.(
      `[baseline-attribution-wiring] no-baseline-drift (prior=${priorSha}); skipping refresh commit.`,
    );
    return {
      ok: true,
      sha: priorSha,
      skipped: true,
      reason: 'no-baseline-drift',
    };
  }
  const amendRes = gitRunner.gitSpawn(cwd, 'commit', '--amend', '--no-edit');
  if (amendRes.status !== 0) {
    return {
      ok: false,
      error: `git commit --amend failed: ${amendRes.stderr || amendRes.stdout}`,
    };
  }
  const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
  const newSha = headRes.status === 0 ? (headRes.stdout || '').trim() : '';
  if (cycleState) cycleState.priorRefreshSha = newSha;
  logger?.info?.(
    `[baseline-attribution-wiring] amended prior baseline-refresh commit → ${newSha}; single-commit invariant preserved.`,
  );
  return { ok: true, sha: newSha, amended: true };
}

/**
 * Run the gate's refresh command (`npm run maintainability:update`, etc.)
 * inside the supplied worktree, stage the resulting baseline drift, and
 * commit on the Story branch with the canonical `baseline-refresh: ...`
 * subject. Returns the new commit SHA (short) on success.
 *
 * The caller must already have asserted `cwd === worktreePath` is on the
 * Story branch — this helper does NOT re-check the branch. story-close.js
 * holds that invariant via `withEpicMergeLock`.
 *
 * Story #2176: enforces a single `baseline-refresh:` commit per close
 * cycle. When `cycleState.priorRefreshSha` is populated, or HEAD itself
 * carries a `baseline-refresh:` subject, the staged drift is folded into
 * that prior commit via `git commit --amend --no-edit` (or skipped
 * entirely when the staged tree matches the prior commit's tree). This
 * prevents the per-retry cascade where 7+ sibling `baseline-refresh:`
 * commits would otherwise accumulate.
 *
 * @returns {{ ok: true, sha: string, amended?: boolean, skipped?: boolean, reason?: string }
 *   | { ok: false, error: string }}
 */
export function runRefreshCommit({
  cwd,
  refreshCmd,
  refreshSubject,
  cycleState = null,
  spawnSync = defaultSpawnSync,
  gitRunner = { gitSpawn: defaultGitSpawn },
  logger = DefaultLogger,
}) {
  const refresh = spawnSync(refreshCmd.cmd, refreshCmd.args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if ((refresh.status ?? 1) !== 0) {
    return {
      ok: false,
      error: `refresh command "${refreshCmd.cmd} ${refreshCmd.args.join(' ')}" exited ${refresh.status}`,
    };
  }
  // Stage every modified path in the working tree — the refresh command
  // overwrites the baseline JSON file(s); restricting to a known glob
  // would silently drop new baselines a future gate adds.
  const addRes = gitRunner.gitSpawn(cwd, 'add', '-u');
  if (addRes.status !== 0) {
    return {
      ok: false,
      error: `git add -u failed: ${addRes.stderr || addRes.stdout}`,
    };
  }

  // Empty refresh diff is a real failure — the gate flagged regressions
  // but the refresh command produced no changes, which means our gate
  // model is out of sync with the refresh tooling. Surface it.
  const statusRes = gitRunner.gitSpawn(cwd, 'status', '--porcelain');
  if (statusRes.status !== 0 || (statusRes.stdout || '').trim().length === 0) {
    return {
      ok: false,
      error:
        'refresh command produced no diff — baseline gate would still fail',
    };
  }

  // Story #2176: fold subsequent refreshes into the prior `baseline-refresh:`
  // commit rather than emitting siblings.
  const priorSha = resolvePriorRefreshSha({ cwd, cycleState, gitRunner });
  if (priorSha) {
    return foldIntoPriorRefresh({
      cwd,
      priorSha,
      cycleState,
      gitRunner,
      logger,
    });
  }

  const commitRes = gitRunner.gitSpawn(cwd, 'commit', '-m', refreshSubject);
  if (commitRes.status !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${commitRes.stderr || commitRes.stdout}`,
    };
  }
  const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
  const sha = headRes.status === 0 ? (headRes.stdout || '').trim() : '';
  if (cycleState) cycleState.priorRefreshSha = sha;
  return { ok: true, sha };
}

/**
 * Top-level: handle a baseline gate failure by classifying drift and
 * either auto-refreshing (attributable-only) or posting friction (any
 * non-attributable). Non-baseline gates short-circuit with `{ action:
 * 'rethrow' }` and the caller re-throws the original gate error so
 * compile/lint/test failures still hard-fail the close.
 *
 * @param {object} input
 * @param {string} input.gateName
 *   The failed gate's `name` (from `runPreMergeGates` error).
 * @param {Array<{ path?: string, file?: string }>} input.regressions
 *   Projected regression rows (e.g. from
 *   `projectMaintainabilityRegressions`). Empty array → `{ action: 'rethrow' }`
 *   so a baseline gate that failed for a non-regression reason
 *   (e.g. baseline file missing) bubbles up rather than being silently
 *   swallowed as "all attributable, refresh".
 * @param {string} input.cwd Worktree path (where refresh + commit run).
 * @param {string} input.epicBranch e.g. `epic/1114` (no `origin/` prefix).
 * @param {string} input.storyBranch e.g. `story-1124`.
 * @param {number|string} input.storyId
 * @param {number|string} input.epicId
 * @param {object} input.provider Ticketing provider for friction post.
 * @param {object} [input.gateRegistry]
 * @param {object} [input.deps] Injected seams for tests.
 * @returns {Promise<{
 *   action: 'refreshed' | 'blocked' | 'rethrow',
 *   sha?: string,
 *   nonAttributable?: Array,
 *   commentId?: number|string|null,
 * }>}
 */
export async function handleBaselineGateFailure({
  gateName,
  regressions,
  cwd,
  epicBranch,
  storyBranch,
  storyId,
  epicId,
  provider,
  cycleState = null,
  gateRegistry = DEFAULT_GATE_REGISTRY,
  deps = {},
} = {}) {
  const meta = gateRegistry[gateName];
  if (!meta) return { action: 'rethrow' };
  if (!Array.isArray(regressions) || regressions.length === 0) {
    return { action: 'rethrow' };
  }

  const classify = deps.classifyBaselineDrift ?? defaultClassifyBaselineDrift;
  const renderBody =
    deps.renderBaselineFrictionBody ?? defaultRenderBaselineFrictionBody;
  const upsertComment =
    deps.upsertStructuredComment ?? defaultUpsertStructuredComment;
  const gitRunner = deps.gitRunner ?? { gitSpawn: defaultGitSpawn };
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const computePaths = deps.computeStoryDiffPaths ?? computeStoryDiffPaths;

  const storyDiffPaths = computePaths({
    cwd,
    epicBranch,
    storyBranch,
    gitRunner,
  });

  const epicRef = `origin/${epicBranch}`;
  const { attributable, nonAttributable } = classify({
    regressions,
    storyDiffPaths,
    epicRef,
    cwd,
    gitRunner,
  });

  if (nonAttributable.length > 0) {
    const body = renderBody({ rows: nonAttributable, epicId, storyId });
    let commentId = null;
    try {
      const res = await upsertComment(provider, storyId, 'friction', body);
      commentId = res?.commentId ?? null;
    } catch (err) {
      // The post failure is logged but does not flip the action — we
      // still want story-close to surface `blocked`, just without a
      // comment receipt the operator can link to.
      deps.logger?.warn?.(
        `[baseline-attribution-wiring] failed to upsert friction comment: ${err?.message ?? err}`,
      );
    }
    return { action: 'blocked', nonAttributable, commentId };
  }

  // All attributable → run the gate's refresh + commit on the Story branch.
  if (attributable.length === 0) return { action: 'rethrow' };
  const refresh = runRefreshCommit({
    cwd,
    refreshCmd: meta.refreshCmd,
    refreshSubject: meta.refreshSubject,
    cycleState,
    spawnSync,
    gitRunner,
    logger: deps.logger,
  });
  if (!refresh.ok) {
    return { action: 'rethrow', error: refresh.error };
  }
  return {
    action: 'refreshed',
    sha: refresh.sha,
    skipped: refresh.skipped === true,
    amended: refresh.amended === true,
  };
}

export { DEFAULT_GATE_REGISTRY };

/**
 * Maintainability projector — extracts the same regression rows
 * `runPreMergeGates` would have surfaced for `check-maintainability` by
 * re-running the per-file MI ceiling projection against `origin/<epicBranch>`.
 *
 * Behaviour is preserved byte-for-byte from the pre-refactor early-return
 * branch of `projectRegressionsForGate`: missing baseline path → `[]`, and
 * the underlying `projectMaintainabilityRegressions` decides what counts as
 * a regression row.
 *
 * @returns {Array<{ path?: string, file?: string }>}
 */
function projectMaintainabilityForGate({
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  projectMaintainability = defaultProjectMaintainabilityRegressions,
  getBaselines = defaultGetBaselines,
}) {
  const baselinePath = getBaselines({ agentSettings })?.maintainability?.path;
  if (!baselinePath) return [];
  const projection = projectMaintainability({
    cwd,
    epicBranch,
    storyBranch,
    baselinePath,
  });
  return projection?.regressions ?? [];
}

/**
 * Default CRAP regression tolerance — mirrors `check-crap.js`. Score noise
 * floor is ~0.01 from coverage rounding shifts across Node/V8 builds; a
 * 0.05 tolerance clears that without admitting real regressions (those
 * cross whole-integer thresholds and clear 0.05 trivially).
 */
const DEFAULT_CRAP_TOLERANCE = 0.05;

/**
 * Pure helper — given two CRAP baseline envelopes (`{ rows: [...] }`), produce
 * the regression rows for methods whose `crap` score increased beyond
 * `tolerance` between `baselineRows` and `headRows`. When `touchedFiles` is
 * supplied (as a Set or array of repo-relative POSIX paths), rows are filtered
 * to functions inside files the Story changed — sibling drift outside the
 * Story's diff is excluded by construction, matching the maintainability
 * projector's "touched-only" contract.
 *
 * Row shape mirrors the maintainability projector — `{ file, method,
 * startLine, crap, baseline, drop, projected }` — so downstream attribution
 * + refresh-commit logic (`classifyBaselineDrift`,
 * `renderBaselineFrictionBody`) can read either projector's output with the
 * same field accessors. `projected` is an alias for `crap` retained for
 * shape compatibility with maintainability rows.
 *
 * Exported so unit tests can pin the diff math against a fixture pair of
 * baseline envelopes without spawning `git`.
 *
 * @param {{
 *   baselineRows: Array<{file: string, method: string, startLine: number, crap: number}>,
 *   headRows:     Array<{file: string, method: string, startLine: number, crap: number}>,
 *   touchedFiles?: Set<string> | Array<string> | null,
 *   tolerance?:   number,
 * }} params
 * @returns {Array<{
 *   file: string, method: string, startLine: number,
 *   crap: number, projected: number, baseline: number, drop: number,
 *   path: string,
 * }>}
 */
function coerceScopeSet(touchedFiles) {
  if (touchedFiles == null) return null;
  if (touchedFiles instanceof Set) return touchedFiles;
  return new Set(touchedFiles);
}

// Story #1895: rows from the canonical envelope key by `path`; legacy
// rows key by `file`. Accept either so this attribution layer keeps
// working while the Epic migrates consumers off the legacy shape.
function rowFileKey(row) {
  if (!row) return null;
  if (typeof row.file === 'string') return row.file;
  if (typeof row.path === 'string') return row.path;
  return null;
}

function indexCrapBaselineByMethod(baselineRows) {
  const byMethod = new Map();
  for (const b of baselineRows) {
    const f = rowFileKey(b);
    if (!f || typeof b.method !== 'string') continue;
    const key = `${f}::${b.method}`;
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key).push(b);
  }
  return byMethod;
}

function pickClosestUnseen(candidates, headStartLine, seen) {
  let pick = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const f = rowFileKey(c);
    const k = `${f}::${c.method}@${c.startLine}`;
    if (seen.has(k)) continue;
    const d = Math.abs((c.startLine ?? 0) - (headStartLine ?? 0));
    if (d < bestDist) {
      bestDist = d;
      pick = c;
    }
  }
  return pick;
}

function isValidHeadRow(row) {
  return Boolean(row && rowFileKey(row) && typeof row.method === 'string');
}

function buildCrapRegression(row, pick) {
  const headCrap = typeof row.crap === 'number' ? row.crap : 0;
  const baseCrap = typeof pick.crap === 'number' ? pick.crap : 0;
  const f = rowFileKey(row);
  return {
    file: f,
    path: f,
    method: row.method,
    startLine: row.startLine,
    crap: headCrap,
    projected: headCrap,
    baseline: baseCrap,
    drop: headCrap - baseCrap,
    headCrap,
    baseCrap,
  };
}

export function diffCrapBaselines({
  baselineRows,
  headRows,
  touchedFiles = null,
  tolerance = DEFAULT_CRAP_TOLERANCE,
} = {}) {
  if (!Array.isArray(baselineRows) || !Array.isArray(headRows)) return [];
  const scope = coerceScopeSet(touchedFiles);
  const byMethod = indexCrapBaselineByMethod(baselineRows);
  const seen = new Set();
  const regressions = [];

  for (const row of headRows) {
    if (!isValidHeadRow(row)) continue;
    const rowFile = rowFileKey(row);
    if (scope && !scope.has(rowFile)) continue;
    const candidates = byMethod.get(`${rowFile}::${row.method}`);
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const pick = pickClosestUnseen(candidates, row.startLine, seen);
    if (!pick) continue;
    seen.add(`${rowFileKey(pick)}::${pick.method}@${pick.startLine}`);
    const entry = buildCrapRegression(row, pick);
    if (entry.headCrap <= entry.baseCrap + tolerance) continue;
    // strip the internal `headCrap`/`baseCrap` fields — they were only
    // here to give the caller a single read of each value.
    const { headCrap: _h, baseCrap: _b, ...publicEntry } = entry;
    regressions.push(publicEntry);
  }
  return regressions;
}

/**
 * Project CRAP regressions for the failed `check-crap` gate against a pair
 * of refs. Reads `baselines/crap.json` at `baselineRef` and `headRef` via
 * `baseline-loader.readBaselineAtRef`, then runs `diffCrapBaselines` to
 * pick out the rows where the Story's HEAD crap score exceeds the epic
 * branch's baseline. Rows are filtered to `touchedFiles` (story diff) so
 * sibling drift outside the Story's footprint never bleeds through.
 *
 * This is the gate-agnostic, ref-pair interface declared on the Tech Spec
 * (`projectCrapRegressions(touchedFiles, baselineRef, headRef)`); the
 * dispatch table entry in `PROJECTORS` wraps this with the
 * `{ cwd, epicBranch, storyBranch }` plumbing `projectRegressionsForGate`
 * passes in.
 *
 * Read failures are swallowed and return `[]` — a missing baseline at one
 * of the refs is indistinguishable from "no regressions surfaceable" at
 * the projector layer, and the caller (`handleBaselineGateFailure`)
 * already treats an empty rows list as `{ action: 'rethrow' }` so the
 * original gate error surfaces unchanged.
 *
 * @param {{
 *   touchedFiles: Set<string> | Array<string> | null,
 *   baselineRef: string,
 *   headRef: string,
 *   cwd?: string,
 *   baselinePath?: string,
 *   tolerance?: number,
 *   readBaselineAtRef?: typeof defaultReadBaselineAtRef,
 *   getBaselines?: typeof defaultGetBaselines,
 *   agentSettings?: object,
 * }} params
 * @returns {Array<{ file: string, path: string, method: string, startLine: number, crap: number, projected: number, baseline: number, drop: number }>}
 */
export function projectCrapRegressions({
  touchedFiles,
  baselineRef,
  headRef,
  cwd,
  baselinePath,
  tolerance = DEFAULT_CRAP_TOLERANCE,
  readBaselineAtRef = defaultReadBaselineAtRef,
  getBaselines = defaultGetBaselines,
  agentSettings,
} = {}) {
  if (!baselineRef || !headRef) return [];
  const resolvedPath =
    baselinePath ?? getBaselines({ agentSettings })?.crap?.path;
  if (!resolvedPath) return [];

  let baselineEnv;
  let headEnv;
  try {
    baselineEnv = readBaselineAtRef(baselineRef, resolvedPath, { cwd });
  } catch {
    return [];
  }
  try {
    headEnv = readBaselineAtRef(headRef, resolvedPath, { cwd });
  } catch {
    return [];
  }
  const baselineRows = Array.isArray(baselineEnv?.rows) ? baselineEnv.rows : [];
  const headRows = Array.isArray(headEnv?.rows) ? headEnv.rows : [];
  return diffCrapBaselines({
    baselineRows,
    headRows,
    touchedFiles,
    tolerance,
  });
}

/**
 * Dispatch-table wrapper for `check-crap`. Translates the
 * `{ cwd, epicBranch, storyBranch }` bag the dispatcher hands every
 * projector into the ref-pair signature `projectCrapRegressions` expects,
 * sourcing `touchedFiles` from the Story's diff vs `origin/<epicBranch>`
 * — the same diff `computeStoryDiffPaths` produces for the maintainability
 * path.
 *
 * @returns {Array<{ path: string, file: string, method: string, startLine: number, crap: number, projected: number, baseline: number, drop: number }>}
 */
/**
 * Predicate: do the three projection-context fields the CRAP projector
 * needs (`cwd`, `epicBranch`, `storyBranch`) all carry truthy values?
 * Returns `true` when the bag is usable, `false` when any required field
 * is missing or falsy. Extracted from `projectCrapForGate` so the guard
 * cascade is independently testable and so the projector body stays a
 * straight-line transform.
 *
 * @param {object} ctx
 * @param {*} ctx.cwd
 * @param {*} ctx.epicBranch
 * @param {*} ctx.storyBranch
 * @returns {boolean}
 */
export function validateProjectionContext({ cwd, epicBranch, storyBranch }) {
  if (!cwd) return false;
  if (!epicBranch) return false;
  if (!storyBranch) return false;
  return true;
}

function projectCrapForGate({
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  getBaselines = defaultGetBaselines,
  // Injected seams — production callers omit these.
  readBaselineAtRef = defaultReadBaselineAtRef,
  computeTouched = computeStoryDiffPaths,
  projectCrap = projectCrapRegressions,
} = {}) {
  if (!validateProjectionContext({ cwd, epicBranch, storyBranch })) return [];
  const touchedFiles = new Set(
    computeTouched({ cwd, epicBranch, storyBranch }),
  );
  return projectCrap({
    touchedFiles,
    baselineRef: `origin/${epicBranch}`,
    headRef: storyBranch,
    cwd,
    agentSettings,
    readBaselineAtRef,
    getBaselines,
  });
}

/**
 * Dispatch table mapping gate names to their projector implementations. Each
 * projector takes the same `{ cwd, epicBranch, storyBranch, agentSettings,
 * ...injected }` bag `projectRegressionsForGate` receives and returns an array
 * of regression rows downstream attribution + refresh-commit logic consumes.
 *
 * Adding a new baseline gate is an append here; the orchestration in
 * `projectRegressionsForGate` does not change.
 */
const PROJECTORS = {
  'check-maintainability': projectMaintainabilityForGate,
  'check-crap': projectCrapForGate,
};

/**
 * Project the regression rows for the failed gate via the `PROJECTORS`
 * dispatch table. Unknown gates (typecheck, lint, test, format, or any
 * gate without a registered projector) return `[]` so
 * `handleBaselineGateFailure` re-throws — the gate's own hint chain
 * still surfaces.
 *
 * Exported so tests can pin the dispatch table without spawning `git`.
 *
 * @returns {Array<{ path?: string, file?: string }>}
 */
export function projectRegressionsForGate({
  gateName,
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  projectMaintainability = defaultProjectMaintainabilityRegressions,
  getBaselines = defaultGetBaselines,
}) {
  const project = PROJECTORS[gateName];
  if (!project) return [];
  return project({
    cwd,
    epicBranch,
    storyBranch,
    agentSettings,
    projectMaintainability,
    getBaselines,
  });
}

export { PROJECTORS };

/**
 * Wrap `runPreMergeGates` with the Story #1124 baseline-attribution flow.
 *
 * On a baseline-gate failure (`check-maintainability` today; the registry
 * also covers `check-crap`) we project the regressions, classify them
 * against the Story's diff vs `epic/<id>`, and either:
 *
 *   - `refreshed` → attributable-only drift; the helper committed
 *     `baseline-refresh: ...` on the Story branch. We re-run the gate
 *     chain once (bounded retry) so the rest of the close sees a green
 *     pre-merge.
 *   - `blocked`   → at least one path the Story never touched failed.
 *     We've upserted a friction comment on the Story; return so
 *     `runStoryCloseLocked` short-circuits the close.
 *   - `rethrow`   → non-baseline gate, empty regressions, or refresh
 *     command itself failed. Re-throw the original gate error so the
 *     close fails loudly the way it always has.
 *
 * @returns {Promise<
 *   | { status: 'ok' }
 *   | { status: 'blocked', nonAttributable: Array, commentId: string|number|null }
 * >}
 */
export async function runPreMergeGatesWithAttribution({
  cwd,
  worktreePath,
  epicBranch,
  storyBranch,
  agentSettings,
  storyId,
  epicId,
  useEvidence,
  phaseTimer,
  provider,
  // Injected for tests — production callers omit these.
  runPreMergeGates = defaultRunPreMergeGates,
  handleBaselineGateFailureFn = handleBaselineGateFailure,
  projectRegressionsFn = projectRegressionsForGate,
  logger = DefaultLogger,
  maxAttempts = 2,
} = {}) {
  let attempt = 0;
  // The worktree path is where every gate spawns + where attribution
  // commits land. When worktree isolation is off, the helper still
  // works against the main checkout via `cwd`.
  const gateCwd = worktreePath || cwd;
  // Story #2176: a single mutable cycle state object threads through every
  // retry iteration so subsequent baseline-refresh attempts fold into the
  // first commit (amend or skip) rather than emitting siblings.
  const cycleState = { priorRefreshSha: null };
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await runPreMergeGates({
        cwd,
        worktreePath,
        epicBranch,
        agentSettings,
        storyId,
        epicId,
        useEvidence,
        phaseTimer,
        logger,
      });
      return { status: 'ok' };
    } catch (err) {
      const m = /failed at "([^"]+)"/.exec(err?.message ?? '');
      const gateName = m ? m[1] : null;
      const regressions = projectRegressionsFn({
        gateName,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        agentSettings,
      });
      const outcome = await handleBaselineGateFailureFn({
        gateName,
        regressions,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        storyId,
        epicId,
        provider,
        cycleState,
      });
      if (outcome.action === 'refreshed') {
        const verb = outcome.skipped
          ? 'baseline-refresh skipped (no drift)'
          : outcome.amended
            ? 'baseline-refresh amended into prior'
            : 'baseline-refresh committed';
        logger.info?.(
          `[baseline-attribution-wiring] ${verb} (${outcome.sha}); re-running pre-merge gates.`,
        );
        continue;
      }
      if (outcome.action === 'blocked') {
        return {
          status: 'blocked',
          nonAttributable: outcome.nonAttributable ?? [],
          commentId: outcome.commentId ?? null,
        };
      }
      // 'rethrow' — and any unexpected action — surfaces the original error.
      throw err;
    }
  }
  // Two attempts still failing → re-run so the throw propagates with the
  // canonical hint.
  await runPreMergeGates({
    cwd,
    worktreePath,
    epicBranch,
    agentSettings,
    storyId,
    epicId,
    useEvidence,
    phaseTimer,
    logger,
  });
  return { status: 'ok' };
}
