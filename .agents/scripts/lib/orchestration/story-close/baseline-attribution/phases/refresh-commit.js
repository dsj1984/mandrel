/**
 * refresh-commit.js — phase 3 of baseline-attribution.
 *
 * When the attribution classifier decides every regression row is
 * attributable to the Story's diff, this phase refreshes the kind's
 * baseline in-process via `refreshBaseline()` (Story #2205), stages the
 * resulting baseline file, and either skips (no drift) or commits one
 * canonical `chore(baselines): refresh <kind> for story-<id>` on the
 * Story branch. The retry loop in `gate-failure.js` is gated by an
 * idempotency token (`cycleState.refreshedKinds`) so a fail-then-pass
 * sequence still emits at most one baseline-refresh commit per close
 * cycle (AC-9, #2176-fixture).
 */

import fs from 'node:fs';
import path from 'node:path';
import { filterExcludedRows } from '../../../../baselines/kinds/maintainability.js';
import { canonicalise as canonicalisePath } from '../../../../baselines/path-canon.js';
import { refreshBaseline as defaultRefreshBaseline } from '../../../../baselines/refresh-service.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
} from '../../../../config-resolver.js';
import { loadCoverage as defaultLoadCoverage } from '../../../../coverage-utils.js';
import {
  resolveEscomplexVersion as defaultResolveEscomplexVersion,
  resolveTsTranspilerVersion as defaultResolveTsTranspilerVersion,
  scanAndScore as defaultScanAndScore,
} from '../../../../crap-utils.js';
import { gitSpawn as defaultGitSpawn } from '../../../../git-utils.js';
import { Logger as DefaultLogger } from '../../../../Logger.js';
import {
  calculateAll as defaultCalculateAll,
  scanDirectory as defaultScanDirectory,
  isIgnoredByGlobs as isIgnoredByGlobsMi,
} from '../../../../maintainability-utils.js';

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
 *   config?: object,
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
  config,
  getQuality = defaultGetQuality,
  scanDirectory = defaultScanDirectory,
  calculateAll = defaultCalculateAll,
  loadCoverage = defaultLoadCoverage,
  scanAndScore = defaultScanAndScore,
  resolveEscomplexVersion = defaultResolveEscomplexVersion,
  resolveTsTranspilerVersion = defaultResolveTsTranspilerVersion,
}) {
  const quality = getQuality(config) ?? {};
  if (kind === 'maintainability') {
    const targetDirs = quality?.maintainability?.targetDirs ?? [];
    const miIgnoreGlobs = quality?.maintainability?.ignoreGlobs ?? [];
    // Scorer receives `(files, opts)` from the refresh-service.
    // When `opts.fullScope !== true`, score only the in-scope diff files
    // that fall under a configured target dir — rows outside those roots
    // are preserved verbatim by the service / writer (out-of-scope merging).
    // When `opts.fullScope === true`, walk the full target dirs as before.
    return async (files, opts) => {
      const effectiveCwd = opts?.cwd ?? cwd;
      const targetAbsDirs = targetDirs.map((dir) =>
        path.isAbsolute(dir) ? dir : path.resolve(effectiveCwd, dir),
      );
      let sourceList;
      if (opts?.fullScope) {
        sourceList = [];
        for (const abs of targetAbsDirs) {
          scanDirectory(abs, sourceList, {
            cwd: effectiveCwd,
            ignoreGlobs: miIgnoreGlobs,
          });
        }
      } else {
        // Diff-scope: resolve each in-scope file to absolute path, keep
        // only those that fall under a configured target dir.
        sourceList = [];
        for (const rel of files ?? []) {
          const abs = path.resolve(effectiveCwd, rel);
          const underTarget = targetAbsDirs.some(
            (root) => abs === root || abs.startsWith(`${root}${path.sep}`),
          );
          // Apply `ignoreGlobs` here too — the full-scope walk drops
          // ignore-matched files via `scanDirectory`, so the diff-scope path
          // must do the same or an ignored-but-changed file (e.g. one matched
          // by `config-settings-schema*.js`) enters `rows` and drags the
          // `rollup["*"].min` below the maintainability floor. This mirrors the
          // canonical `buildDefaultMaintainabilityScorer` (refresh-service.js,
          // Story #4293); the story-close auto-refresh routes through this
          // scorer, not that one, so the fix has to live here too.
          if (
            underTarget &&
            !isIgnoredByGlobsMi(abs, miIgnoreGlobs, effectiveCwd)
          ) {
            sourceList.push(abs);
          }
        }
      }
      const scores = await calculateAll(sourceList);
      return filterExcludedRows(
        Object.entries(scores).map(([key, mi]) => {
          const rel = path.isAbsolute(key)
            ? path.relative(effectiveCwd, key)
            : key;
          const posixRel = rel.split(path.sep).join('/');
          return { path: canonicalisePath(posixRel), mi };
        }),
      );
    };
  }
  if (kind === 'crap') {
    const crapCfg = quality?.crap ?? {};
    const targetDirs = Array.isArray(crapCfg.targetDirs)
      ? crapCfg.targetDirs
      : [];
    const crapIgnoreGlobs = Array.isArray(crapCfg.ignoreGlobs)
      ? crapCfg.ignoreGlobs
      : [];
    const requireCoverage = crapCfg.requireCoverage !== false;
    const coveragePath = crapCfg.coveragePath ?? 'coverage/coverage-final.json';
    // Scorer receives `(files, opts)` from the refresh-service.
    // When `opts.fullScope !== true`, forward the diff-scope file list to
    // `scanAndScore` via its `scopeFiles` parameter so it restricts scoring
    // to the in-scope files (Story #3647 — diff-scope awareness).
    return async (files, opts) => {
      const effectiveCwd = opts?.cwd ?? cwd;
      const coverageAbs = path.isAbsolute(coveragePath)
        ? coveragePath
        : path.resolve(effectiveCwd, coveragePath);
      const coverage = loadCoverage(coverageAbs);
      if (!coverage && requireCoverage) return [];
      const scopeFiles = opts?.fullScope ? null : (files ?? null);
      const { rows } = await scanAndScore({
        targetDirs,
        coverage,
        requireCoverage,
        cwd: effectiveCwd,
        ignoreGlobs: crapIgnoreGlobs,
        scopeFiles,
      });
      // Stamp kernel versions so downstream gates can reason about the
      // scoring environment. The writer keeps `kernelVersion`; the others
      // remain available via the resolved values for the per-kind module.
      resolveEscomplexVersion(effectiveCwd);
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
 * @param {{ cwd: string, kind: string, config?: object, getBaselines?: typeof defaultGetBaselines }} input
 * @returns {string|null}
 */
function resolveBaselineWritePath({
  cwd,
  kind,
  config,
  getBaselines = defaultGetBaselines,
}) {
  const baselines = getBaselines(config) ?? {};
  const rel = baselines?.[kind]?.path;
  if (typeof rel !== 'string' || rel.length === 0) return null;
  return path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
}

function normalizeTargetDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  return dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function buildRequiredScopeFilePredicate({
  kind,
  config,
  getQuality = defaultGetQuality,
}) {
  const quality = getQuality(config) ?? {};
  const targetDirs = Array.isArray(quality?.[kind]?.targetDirs)
    ? quality[kind].targetDirs.map(normalizeTargetDir).filter(Boolean)
    : [];
  if (targetDirs.length === 0) return () => true;
  return (file) =>
    targetDirs.some((dir) => file === dir || file.startsWith(`${dir}/`));
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
 * Story #4017 — this helper is the **single refresh→stage→commit funnel**
 * for story-close. Both call paths route through it: the gate-failure
 * attribution retry (`gate-failure.js`, no `capCheck`) and the post-gates
 * bounded auto-refresh (`auto-refresh-runner.js`, which injects a
 * `capCheck` evaluating the refreshed envelope against the configured
 * delta caps). When `capCheck` returns `{ canAutoRefresh: false }`, the
 * staged refresh is rolled back to HEAD and the helper returns
 * `{ ok: true, refused: true, verdict }` without committing.
 *
 * @returns {Promise<
 *   | { ok: true, sha: string, skipped?: boolean, reason?: string, refused?: boolean, verdict?: object }
 *   | { ok: false, error: string }
 * >}
 */
export async function runRefreshCommit({
  cwd,
  kind,
  storyId,
  epicBranch,
  storyBranch,
  config,
  cycleState = null,
  capCheck = null,
  refreshBaseline = defaultRefreshBaseline,
  scorerBuilder = buildKindScorer,
  getBaselines: getBaselinesImpl = defaultGetBaselines,
  getQuality: getQualityImpl = defaultGetQuality,
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
    config,
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
    scorer = scorerBuilder({ kind, cwd, config });
  } catch (err) {
    return {
      ok: false,
      error: `scorer build failed for kind "${kind}": ${err?.message ?? err}`,
    };
  }

  let refreshResult;
  try {
    refreshResult = await refreshBaseline({
      kind,
      baseRef,
      headRef,
      scopeFiles: null,
      fullScope: false,
      writePath,
      scorer,
      fs: fsImpl,
      cwd,
      requireRowsForScopeFiles: true,
      requiredScopeFilePredicate: buildRequiredScopeFilePredicate({
        kind,
        config,
        getQuality: getQualityImpl,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `refreshBaseline(${kind}) failed: ${err?.message ?? err}`,
    };
  }

  // Story #4017 — when the service reports it persisted nothing, skip the
  // stage/diff round-trip entirely: there is no drift to fold in.
  if (refreshResult?.wrote === false) {
    if (cycleState?.refreshedKinds instanceof Set) {
      cycleState.refreshedKinds.add(kind);
    }
    logger?.info?.(
      `[baseline-attribution-wiring] refresh wrote nothing for kind=${kind} (story-${storyId}); skipping.`,
    );
    return { ok: true, sha: '', skipped: true, reason: 'no-baseline-drift' };
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

  // Story #4017 — optional bounded-delta cap check (injected by the
  // post-gates auto-refresh path). A refusal rolls the staged refresh back
  // to HEAD so the merge consumes the pre-refresh baseline unchanged.
  if (typeof capCheck === 'function') {
    const verdict = await capCheck({ kind, writePath });
    if (verdict && verdict.canAutoRefresh === false) {
      const rel = path.isAbsolute(writePath)
        ? path.relative(cwd, writePath)
        : writePath;
      const posixRel = rel.split(path.sep).join('/');
      const res = gitRunner.gitSpawn(cwd, 'checkout', 'HEAD', '--', posixRel);
      if (res.status !== 0) {
        logger?.warn?.(
          `[baseline-attribution-wiring] failed to restore ${rel} after cap refusal: ${res.stderr || res.stdout}`,
        );
      }
      return { ok: true, sha: '', refused: true, verdict };
    }
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
