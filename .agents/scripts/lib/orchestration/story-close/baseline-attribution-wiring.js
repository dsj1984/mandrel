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
 *   3. If every regression is attributable, refresh the kind's baseline via
 *      `refreshBaseline()` (Story #2197), stage the changed baseline file,
 *      and commit on the Story branch with a `chore(baselines): refresh
 *      <kind> for story-<id>` subject. The caller then re-runs the gate
 *      chain — drift is now committed, gate passes.
 *   4. If any regression is non-attributable, render the friction body
 *      (`renderBaselineFrictionBody`) and upsert it via
 *      `upsertStructuredComment`. Return a status that signals story-close
 *      to short-circuit with `{ status: 'blocked', phase: 'closing' }`.
 *
 * Story #2205 — refresh path now flows through `refreshBaseline()` from
 * `lib/baselines/refresh-service.js`. The `--amend` / `--allow-empty`
 * shortcuts and the legacy `npm run <kind>:update` shell-outs are gone.
 * Post-refresh hygiene is: stage the baseline file, run `git diff --cached
 * --exit-code`, and either skip (empty diff → log "no baseline drift to
 * fold in") or emit one canonical `chore(baselines): refresh <kind> for
 * story-<id>` commit. The retry loop is gated by an idempotency token
 * (`cycleState.refreshedKinds`) so a fail-then-pass sequence still emits
 * at most one baseline-refresh commit per close cycle (AC-9, #2176-fixture).
 */

import fs from 'node:fs';
import path from 'node:path';
import { refreshBaseline as defaultRefreshBaseline } from '../../../../../lib/baselines/refresh-service.js';
import { readBaselineAtRef as defaultReadBaselineAtRef } from '../../baseline-loader.js';
import { projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions } from '../../close-validation.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
} from '../../config-resolver.js';
import { COVERAGE_TIMEOUT_EXIT_CODE } from '../../coverage-capture.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { loadCoverage as defaultLoadCoverage } from '../../coverage-utils.js';
import {
  resolveEscomplexVersion as defaultResolveEscomplexVersion,
  scanAndScore as defaultScanAndScore,
  resolveTsTranspilerVersion as defaultResolveTsTranspilerVersion,
} from '../../crap-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  calculateAll as defaultCalculateAll,
  scanDirectory as defaultScanDirectory,
} from '../../maintainability-utils.js';
import { canonicalise as canonicalisePath } from '../../baselines/path-canon.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';
import { classifyBaselineDrift as defaultClassifyBaselineDrift } from './baseline-attribution.js';
import { renderBaselineFrictionBody as defaultRenderBaselineFrictionBody } from './baseline-friction-body.js';
import { runPreMergeGates as defaultRunPreMergeGates } from './pre-merge-validation.js';

/**
 * Story #2165 — exit code surfaced when one of the baseline-refresh spawns
 * is killed by the bounded-timeout watchdog. Matches
 * `COVERAGE_TIMEOUT_EXIT_CODE` and the GNU `timeout(1)` convention so the
 * close orchestrator can branch on "refresh hung" (124) vs. "refresh
 * exited non-zero for some other reason" without inspecting signal names.
 *
 * Story #2205 — the gate-attribution refresh now uses the in-process
 * `refreshBaseline()` service and never spawns a child process, so this
 * timeout no longer fires from this module. Kept as an exported constant
 * for callers (and tests) that still reference the historical contract.
 */
export const REFRESH_TIMEOUT_EXIT_CODE = 124;

/**
 * Map gate names → metadata used to project regressions and refresh the
 * baseline. Only baseline-style gates appear here; non-baseline gates
 * (typecheck, lint, test, format) fall through and the orchestrator
 * re-throws the original gate error.
 *
 * Story #2205 — the `refreshCmd` shell-out is gone. Each gate now declares
 * the `kind` (matching `refreshBaseline`'s supported kinds) and the
 * timeout block is retained as informational metadata only.
 */
const DEFAULT_GATE_REGISTRY = {
  'check-maintainability': {
    kind: 'maintainability',
    baselineHint: 'maintainability',
    timeoutBlockKey: 'maintainability',
  },
  'check-crap': {
    kind: 'crap',
    baselineHint: 'crap',
    timeoutBlockKey: 'crap',
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
 * Build the per-kind scorer the refresh-service consumes. Each scorer
 * receives an (in-scope) file list plus a context bag and returns the
 * row array the writer persists.
 *
 * Story #2205 — the scorer is exposed as a helper so unit tests can
 * inject a deterministic stub via `deps.refreshBaseline` (which receives
 * the scorer via the option bag).
 *
 * @param {{
 *   kind: 'maintainability' | 'crap',
 *   cwd: string,
 *   agentSettings?: object,
 *   getQuality?: typeof defaultGetQuality,
 *   scanDirectory?: typeof defaultScanDirectory,
 *   calculateAll?: typeof defaultCalculateAll,
 *   loadCoverage?: typeof defaultLoadCoverage,
 *   scanAndScore?: typeof defaultScanAndScore,
 *   resolveEscomplexVersion?: typeof defaultResolveEscomplexVersion,
 *   resolveTsTranspilerVersion?: typeof defaultResolveTsTranspilerVersion,
 * }} input
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
export function buildKindScorer({
  kind,
  cwd,
  agentSettings,
  getQuality = defaultGetQuality,
  scanDirectory = defaultScanDirectory,
  calculateAll = defaultCalculateAll,
  loadCoverage = defaultLoadCoverage,
  scanAndScore = defaultScanAndScore,
  resolveEscomplexVersion = defaultResolveEscomplexVersion,
  resolveTsTranspilerVersion = defaultResolveTsTranspilerVersion,
}) {
  const quality = getQuality({ agentSettings }) ?? {};
  if (kind === 'maintainability') {
    const targetDirs = quality?.maintainability?.targetDirs ?? [];
    return async () => {
      const sourceList = [];
      for (const dir of targetDirs) {
        const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
        scanDirectory(abs, sourceList);
      }
      const scores = await calculateAll(sourceList);
      return Object.entries(scores).map(([key, mi]) => {
        const rel = path.isAbsolute(key) ? path.relative(cwd, key) : key;
        const posixRel = rel.split(path.sep).join('/');
        return { path: canonicalisePath(posixRel), mi };
      });
    };
  }
  if (kind === 'crap') {
    const crapCfg = quality?.crap ?? {};
    const targetDirs = Array.isArray(crapCfg.targetDirs)
      ? crapCfg.targetDirs
      : [];
    const requireCoverage = crapCfg.requireCoverage !== false;
    const coveragePath = crapCfg.coveragePath ?? 'coverage/coverage-final.json';
    return async () => {
      const coverageAbs = path.isAbsolute(coveragePath)
        ? coveragePath
        : path.resolve(cwd, coveragePath);
      const coverage = loadCoverage(coverageAbs);
      if (!coverage && requireCoverage) return [];
      const { rows } = await scanAndScore({
        targetDirs,
        coverage,
        requireCoverage,
        cwd,
      });
      // Stamp kernel versions so downstream gates can reason about the
      // scoring environment. The writer keeps `kernelVersion`; the others
      // remain available via the resolved values for the per-kind module.
      resolveEscomplexVersion(cwd);
      resolveTsTranspilerVersion();
      return (rows ?? []).filter(
        (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
      );
    };
  }
  throw new Error(
    `buildKindScorer: unsupported kind "${kind}" (expected maintainability|crap)`,
  );
}

/**
 * Resolve the absolute on-disk path for a kind's baseline file.
 *
 * @param {{ cwd: string, kind: string, agentSettings?: object, getBaselines?: typeof defaultGetBaselines }} input
 * @returns {string|null}
 */
function resolveBaselineWritePath({
  cwd,
  kind,
  agentSettings,
  getBaselines = defaultGetBaselines,
}) {
  const baselines = getBaselines({ agentSettings }) ?? {};
  const rel = baselines?.[kind]?.path;
  if (typeof rel !== 'string' || rel.length === 0) return null;
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

/**
 * Stage the baseline file, then check whether the staged tree differs
 * from HEAD via `git diff --cached --exit-code`. Returns one of:
 *
 *   - `{ hasDrift: true }`  — staged content differs; caller emits commit.
 *   - `{ hasDrift: false }` — staged content matches HEAD; caller skips.
 *   - `{ error: string }`   — git add or diff itself failed.
 *
 * Pure-ish: every git invocation goes through the injected `gitRunner`.
 */
export function stageAndCheckBaselineDrift({
  cwd,
  baselineFile,
  gitRunner = { gitSpawn: defaultGitSpawn },
}) {
  const rel = path.isAbsolute(baselineFile)
    ? path.relative(cwd, baselineFile)
    : baselineFile;
  const posixRel = rel.split(path.sep).join('/');
  const addRes = gitRunner.gitSpawn(cwd, 'add', posixRel);
  if (addRes.status !== 0) {
    return {
      error: `git add ${rel} failed: ${addRes.stderr || addRes.stdout}`,
    };
  }
  const diffRes = gitRunner.gitSpawn(
    cwd,
    'diff',
    '--cached',
    '--exit-code',
    '--',
    posixRel,
  );
  // `git diff --exit-code` exits 0 when no drift, 1 when drift. Anything
  // else (128 for a corrupt index, etc.) is an error.
  if (diffRes.status === 0) return { hasDrift: false };
  if (diffRes.status === 1) return { hasDrift: true };
  return {
    error: `git diff --cached --exit-code ${rel} failed: ${diffRes.stderr || diffRes.stdout}`,
  };
}

/**
 * Run the gate's refresh inside the supplied worktree:
 *
 *   1. Call `refreshBaseline({ kind, writePath, scopeFiles, ... })` — the
 *      service writes the scope-merged envelope atomically.
 *   2. Stage the baseline file and run `git diff --cached --exit-code`.
 *      Empty diff → return `{ ok: true, skipped: true,
 *      reason: 'no-baseline-drift' }`. No commit lands.
 *   3. Otherwise commit on the Story branch with the canonical
 *      `chore(baselines): refresh <kind> for story-<id>` subject.
 *
 * Story #2205 — the retry loop is gated by `cycleState.refreshedKinds`
 * (a `Set<string>` of kinds already refreshed this close cycle). When a
 * kind is already present, the helper short-circuits with `{ ok: true,
 * skipped: true, reason: 'idempotency-token' }` so a fail-then-pass
 * retry sequence emits at most one commit per kind per cycle (AC-9).
 *
 * The caller must already have asserted `cwd === worktreePath` is on the
 * Story branch — this helper does NOT re-check the branch. story-close.js
 * holds that invariant via `withEpicMergeLock`.
 *
 * @returns {Promise<
 *   | { ok: true, sha: string, skipped?: boolean, reason?: string }
 *   | { ok: false, error: string }
 * >}
 */
export async function runRefreshCommit({
  cwd,
  kind,
  storyId,
  epicBranch,
  storyBranch,
  agentSettings,
  cycleState = null,
  refreshBaseline = defaultRefreshBaseline,
  scorerBuilder = buildKindScorer,
  getBaselines: getBaselinesImpl = defaultGetBaselines,
  fsImpl = fs,
  gitRunner = { gitSpawn: defaultGitSpawn },
  logger = DefaultLogger,
}) {
  // AC: retry-loop is gated by an idempotency token so a fail-then-pass
  // sequence never emits a duplicate commit for the same kind.
  if (cycleState?.refreshedKinds instanceof Set) {
    if (cycleState.refreshedKinds.has(kind)) {
      logger?.info?.(
        `[baseline-attribution-wiring] refresh for kind=${kind} already landed this cycle; skipping (idempotency-token).`,
      );
      return {
        ok: true,
        sha: cycleState.lastRefreshSha ?? '',
        skipped: true,
        reason: 'idempotency-token',
      };
    }
  }

  const writePath = resolveBaselineWritePath({
    cwd,
    kind,
    agentSettings,
    getBaselines: getBaselinesImpl,
  });
  if (!writePath) {
    return {
      ok: false,
      error: `no baseline path configured for kind "${kind}"`,
    };
  }

  // The refresh-service derives the scope from `git diff --name-only
  // <baseRef>..<headRef>` when scopeFiles is null. Story-close branches
  // diff against `origin/<epicBranch>`; passing those refs makes the
  // scope-derivation match the attribution computation.
  const baseRef = epicBranch ? `origin/${epicBranch}` : 'origin/main';
  const headRef = storyBranch ?? 'HEAD';
  let scorer;
  try {
    scorer = scorerBuilder({ kind, cwd, agentSettings });
  } catch (err) {
    return {
      ok: false,
      error: `scorer build failed for kind "${kind}": ${err?.message ?? err}`,
    };
  }

  try {
    await refreshBaseline({
      kind,
      baseRef,
      headRef,
      scopeFiles: null,
      fullScope: false,
      writePath,
      scorer,
      fs: fsImpl,
      cwd,
    });
  } catch (err) {
    return {
      ok: false,
      error: `refreshBaseline(${kind}) failed: ${err?.message ?? err}`,
    };
  }

  const drift = stageAndCheckBaselineDrift({
    cwd,
    baselineFile: writePath,
    gitRunner,
  });
  if (drift.error) return { ok: false, error: drift.error };
  if (!drift.hasDrift) {
    if (cycleState?.refreshedKinds instanceof Set) {
      cycleState.refreshedKinds.add(kind);
    }
    logger?.info?.(
      `[baseline-attribution-wiring] no baseline drift to fold in for kind=${kind} (story-${storyId}).`,
    );
    return { ok: true, sha: '', skipped: true, reason: 'no-baseline-drift' };
  }

  const subject = `chore(baselines): refresh ${kind} for story-${storyId}`;
  const commitRes = gitRunner.gitSpawn(cwd, 'commit', '-m', subject);
  if (commitRes.status !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${commitRes.stderr || commitRes.stdout}`,
    };
  }
  const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
  const sha = headRes.status === 0 ? (headRes.stdout || '').trim() : '';
  if (cycleState?.refreshedKinds instanceof Set) {
    cycleState.refreshedKinds.add(kind);
    cycleState.lastRefreshSha = sha;
  }
  logger?.info?.(
    `[baseline-attribution-wiring] committed ${subject} (${sha}); single-commit-per-cycle invariant intact.`,
  );
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
 * @param {Array<{ path?: string, file?: string }>} input.regressions
 * @param {string} input.cwd Worktree path (where refresh + commit run).
 * @param {string} input.epicBranch e.g. `epic/1114` (no `origin/` prefix).
 * @param {string} input.storyBranch e.g. `story-1124`.
 * @param {number|string} input.storyId
 * @param {number|string} input.epicId
 * @param {object} input.provider Ticketing provider for friction post.
 * @param {{ refreshedKinds?: Set<string>, lastRefreshSha?: string|null } | null} [input.cycleState]
 * @param {object} [input.gateRegistry]
 * @param {object} [input.deps] Injected seams for tests.
 * @returns {Promise<{
 *   action: 'refreshed' | 'blocked' | 'rethrow',
 *   sha?: string,
 *   skipped?: boolean,
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
  agentSettings,
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
  const refreshBaseline = deps.refreshBaseline ?? defaultRefreshBaseline;
  const scorerBuilder = deps.scorerBuilder ?? buildKindScorer;
  const fsImpl = deps.fsImpl ?? fs;
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
      deps.logger?.warn?.(
        `[baseline-attribution-wiring] failed to upsert friction comment: ${err?.message ?? err}`,
      );
    }
    return { action: 'blocked', nonAttributable, commentId };
  }

  if (attributable.length === 0) return { action: 'rethrow' };

  const refresh = await runRefreshCommit({
    cwd,
    kind: meta.kind,
    storyId,
    epicBranch,
    storyBranch,
    agentSettings,
    cycleState,
    refreshBaseline,
    scorerBuilder,
    fsImpl,
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
    reason: refresh.reason,
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
    const { headCrap: _h, baseCrap: _b, ...publicEntry } = entry;
    regressions.push(publicEntry);
  }
  return regressions;
}

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

const PROJECTORS = {
  'check-maintainability': projectMaintainabilityForGate,
  'check-crap': projectCrapForGate,
};

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
 * On a baseline-gate failure we project the regressions, classify them
 * against the Story's diff vs `epic/<id>`, and either refresh-and-retry,
 * post a friction comment, or rethrow.
 *
 * Story #2205 — the retry-loop wears a single mutable `cycleState` object
 * carrying `refreshedKinds` (the idempotency token enforcing AC-9). Each
 * `runRefreshCommit` call short-circuits when its kind is already in that
 * set, so a fail-then-pass sequence emits at most one
 * `chore(baselines): refresh <kind> for story-<id>` commit per cycle.
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
  runPreMergeGates = defaultRunPreMergeGates,
  handleBaselineGateFailureFn = handleBaselineGateFailure,
  projectRegressionsFn = projectRegressionsForGate,
  logger = DefaultLogger,
  maxAttempts = 2,
} = {}) {
  let attempt = 0;
  const gateCwd = worktreePath || cwd;
  // Story #2205: single mutable cycle state object — `refreshedKinds`
  // gates the idempotency token enforcing AC-9 (one refresh commit per
  // kind per close cycle).
  const cycleState = { refreshedKinds: new Set(), lastRefreshSha: null };
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
      // Story #2136 / Task #2143 — short-circuit when coverage-capture
      // tripped the bounded-timeout watchdog (exit 124).
      const errGateName = err?.gateName ?? null;
      const errExitCode = err?.exitCode ?? null;
      if (
        errGateName === 'coverage-capture' &&
        errExitCode === COVERAGE_TIMEOUT_EXIT_CODE
      ) {
        return {
          status: 'blocked-timeout',
          gateName: errGateName,
          exitCode: errExitCode,
        };
      }
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
        agentSettings,
        provider,
        cycleState,
      });
      if (outcome.action === 'refreshed') {
        const verb = outcome.skipped
          ? `baseline-refresh skipped (${outcome.reason ?? 'no drift'})`
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
  // maxAttempts exhausted → re-run so the throw propagates with the
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
