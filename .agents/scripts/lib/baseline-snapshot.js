import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterExcludedRows } from './baselines/kinds/maintainability.js';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import { loadFile as readerLoadFile } from './baselines/reader.js';
import {
  write as defaultWriteBaseline,
  writeFile as defaultWriteBaselineFile,
} from './baselines/writer.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
  resolveConfig as defaultResolveConfig,
  PROJECT_ROOT,
} from './config-resolver.js';
import { loadCoverage } from './coverage-utils.js';
import {
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
  scanAndScoreCombined,
} from './crap-utils.js';
import { ensureEpicBranchRef as defaultEnsureEpicBranchRef } from './git-branch-lifecycle.js';
import { calculateAll, scanDirectory } from './maintainability-utils.js';

/**
 * baseline-snapshot.js — per-Epic baseline lifecycle helpers.
 *
 * Story #1396 (Epic #1386). The Epic-snapshot scheme freezes the maintainability
 * and crap baselines at /plan time and reconciles them back to `main`
 * at /deliver time. Two helpers, both pure-ish (deterministic given the
 * working tree + injected I/O):
 *
 *   - forkMainToEpic({ epicId, cwd }) — copies the tracked main baselines
 *     under `temp/epic-<id>/baselines/`. Idempotent: re-running with the same
 *     source content produces the same destination bytes (no fs churn). When
 *     the source baseline is missing, emits a warn through the injected
 *     logger and returns `{ written: false, reason: 'source-missing' }` for
 *     that file — callers (e.g. /plan Phase 7) treat the absence as
 *     non-fatal and stay in `--full-scope` mode.
 *
 *   - regenerateMainFromTree({ cwd }) — re-scores maintainability + crap
 *     against the current working tree and writes the result to the tracked
 *     main baseline paths. Returns `{ didChange, paths }` where `didChange`
 *     is true iff any baseline file's content differs from what's already on
 *     disk. Callers in /deliver use `didChange === false` to skip the
 *     `baseline-refresh: epic-<id>` commit.
 *
 * Lifecycle note (Story #1467): per-epic ratchet snapshots are ephemeral
 * scratch state under the `temp/epic-<id>/baselines/` namespace, NOT committed
 * artifacts. They inherit the existing per-epic temp-tree cleanup contract —
 * `/deliver` reaps the parent `temp/epic-<id>/` directory on merge, so
 * no manual prune is required. Earlier versions of this module wrote under
 * `baselines/epic/<id>/`, which committed them to git and accumulated obsolete
 * snapshots forever.
 *
 * Why "pure-ish" and not pure: both helpers read+write the filesystem and
 * (for regenerateMainFromTree) walk source trees + parse coverage. The seam
 * exposes the pieces that matter for tests — `fs`, the config accessors,
 * the scoring helpers — through dependency injection so the unit tests can
 * pin behaviour without ever touching real `baselines/*.json`.
 */

const EPIC_BASELINES = ['maintainability', 'crap'];

/**
 * Resolve the per-Epic snapshot path for a baseline kind.
 *
 * @param {{ epicId: number, kind: 'maintainability'|'crap', cwd?: string }} opts
 * @returns {string} absolute path under `<cwd>/temp/epic-<id>/baselines/<kind>.json`
 */
export function epicSnapshotPathFor({ epicId, kind, cwd = process.cwd() }) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      '[baseline-snapshot] epicId must be a positive integer',
    );
  }
  if (kind !== 'maintainability' && kind !== 'crap') {
    throw new TypeError(
      `[baseline-snapshot] kind must be one of ${EPIC_BASELINES.join(', ')}`,
    );
  }
  return path.resolve(
    cwd,
    'temp',
    `epic-${epicId}`,
    'baselines',
    `${kind}.json`,
  );
}

/**
 * Fork the tracked main baselines into `temp/epic-<id>/baselines/`. Idempotent.
 *
 * Source paths are resolved through the agent-settings config so a repo that
 * relocates its baselines (`delivery.quality.gates.{maintainability,crap}.baselinePath`)
 * is honoured. Destination layout is fixed at `temp/epic-<id>/baselines/<kind>.json`
 * so the close-validation gate's `--epic-ref` resolution stays predictable, and
 * the per-epic temp-tree cleanup reaps them on Story merge with no extra wiring.
 *
 * Failure modes:
 *   - Source baseline missing → returned per-file `{ written: false,
 *     reason: 'source-missing' }`. Logger warn fires once per missing file.
 *     Caller stays in `--full-scope` mode.
 *   - Source unreadable / not parseable → throws. Re-running /plan
 *     with `--force` after fixing the source recovers.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   force?: boolean,                            // unused at this layer; reserved
 *   resolveConfig?: typeof defaultResolveConfig,
 *   getBaselines?: typeof defaultGetBaselines,
 *   logger?: { warn?: (m: string) => void, info?: (m: string) => void },
 *   fsImpl?: { existsSync: typeof fs.existsSync, readFileSync: typeof fs.readFileSync, writeFileSync: typeof fs.writeFileSync, mkdirSync: typeof fs.mkdirSync },
 * }} opts
 * @returns {{
 *   epicId: number,
 *   results: Array<{
 *     kind: 'maintainability'|'crap',
 *     source: string,
 *     destination: string,
 *     written: boolean,
 *     reason?: 'source-missing'|'idempotent'|'fresh',
 *   }>,
 * }}
 */
export function forkMainToEpic({
  epicId,
  cwd = process.cwd(),
  resolveConfig = defaultResolveConfig,
  getBaselines = defaultGetBaselines,
  logger = console,
  fsImpl = fs,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      '[baseline-snapshot] forkMainToEpic: epicId must be a positive integer',
    );
  }

  const config = resolveConfig({ cwd });
  const baselines = getBaselines(config);
  const results = [];

  for (const kind of EPIC_BASELINES) {
    const sourceRel = baselines?.[kind]?.path;
    if (typeof sourceRel !== 'string' || sourceRel.length === 0) {
      logger.warn?.(
        `[baseline-snapshot] no configured path for ${kind} baseline — skipping fork.`,
      );
      results.push({
        kind,
        source: '',
        destination: epicSnapshotPathFor({ epicId, kind, cwd }),
        written: false,
        reason: 'source-missing',
      });
      continue;
    }

    const sourceAbs = path.isAbsolute(sourceRel)
      ? sourceRel
      : path.resolve(cwd, sourceRel);
    const destinationAbs = epicSnapshotPathFor({ epicId, kind, cwd });

    if (!fsImpl.existsSync(sourceAbs)) {
      logger.warn?.(
        `[baseline-snapshot] ⚠ source baseline missing for ${kind} at ${sourceRel} — fork skipped (gate stays in --full-scope mode).`,
      );
      results.push({
        kind,
        source: sourceAbs,
        destination: destinationAbs,
        written: false,
        reason: 'source-missing',
      });
      continue;
    }

    const sourceBytes = fsImpl.readFileSync(sourceAbs, 'utf8');

    let existingBytes = null;
    if (fsImpl.existsSync(destinationAbs)) {
      try {
        existingBytes = fsImpl.readFileSync(destinationAbs, 'utf8');
      } catch {
        existingBytes = null;
      }
    }

    if (existingBytes === sourceBytes) {
      results.push({
        kind,
        source: sourceAbs,
        destination: destinationAbs,
        written: false,
        reason: 'idempotent',
      });
      continue;
    }

    fsImpl.mkdirSync(path.dirname(destinationAbs), { recursive: true });
    fsImpl.writeFileSync(destinationAbs, sourceBytes);
    logger.info?.(
      `[baseline-snapshot] forked ${kind} baseline → ${path.relative(cwd, destinationAbs)}`,
    );
    results.push({
      kind,
      source: sourceAbs,
      destination: destinationAbs,
      written: true,
      reason: 'fresh',
    });
  }

  return { epicId, results };
}

/**
 * Author a single planning commit on `epic/<id>` that adds the per-Epic
 * baseline snapshots, without disturbing the live working tree or HEAD.
 *
 * Implementation strategy: build a fresh, isolated git index seeded from the
 * Epic branch's tree (`read-tree`), `update-index --add` the snapshot blobs
 * (sourced via `hash-object -w`), `write-tree` against that index, and
 * `commit-tree` the result with the Epic branch as parent. The commit is
 * then attached via `update-ref refs/heads/epic/<id>`. The live worktree
 * `.git/index` is never touched — we route every git invocation through a
 * temporary `GIT_INDEX_FILE`.
 *
 * Idempotent: when the resulting tree equals the parent's tree (because the
 * blobs were already on the Epic branch), no commit is made and the helper
 * returns `{ committed: false, reason: 'no-change' }`.
 *
 * Pre-conditions:
 *   - `epic/<id>` ref exists (caller has invoked `ensureEpicBranchRef`).
 *   - The destination snapshot files exist on disk (call `forkMainToEpic`
 *     immediately before this helper).
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   epicBranch?: string,
 *   message?: string,
 *   files?: Array<{ destination: string }>,    // accepts forkMainToEpic results
 *   gitSpawn?: typeof defaultGitSpawn,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 * }} opts
 * @returns {{ committed: boolean, sha?: string, reason?: 'no-change'|'no-files'|'epic-missing', detail?: string }}
 */
export function commitSnapshotsToEpicBranch({
  epicId,
  cwd = process.cwd(),
  epicBranch = `epic/${epicId}`,
  message = `chore(baseline-snapshot): seed per-epic snapshots for epic-${epicId}`,
  files = [],
  spawnSync = defaultSpawnSync,
  fsImpl = fs,
  logger = console,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      '[baseline-snapshot] commitSnapshotsToEpicBranch: epicId must be a positive integer',
    );
  }

  // Filter to files that actually exist on disk and are under cwd. The helper
  // is purely additive — it never deletes — so files: [] short-circuits.
  const targets = files
    .filter((f) => f && typeof f.destination === 'string')
    .filter((f) => fsImpl.existsSync(f.destination))
    .map((f) => ({
      abs: f.destination,
      rel: path.relative(cwd, f.destination).split(path.sep).join('/'),
    }));
  if (targets.length === 0) {
    return { committed: false, reason: 'no-files' };
  }

  function runGit(args, extraEnv = {}) {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    return {
      status: result.status ?? 1,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
    };
  }

  // Verify the epic branch ref exists before doing any plumbing work.
  const verify = runGit(['rev-parse', '--verify', epicBranch]);
  if (verify.status !== 0) {
    return {
      committed: false,
      reason: 'epic-missing',
      detail: `epic branch ref ${epicBranch} does not exist`,
    };
  }
  const parentSha = verify.stdout;

  // Allocate an isolated index file so the live `.git/index` never moves.
  const tmpIndex = path.join(
    os.tmpdir(),
    `baseline-snapshot-${epicId}-${process.pid}-${Date.now()}.index`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex };

  try {
    // Seed the index from the Epic branch tree.
    const readTree = runGit(['read-tree', epicBranch], env);
    if (readTree.status !== 0) {
      return {
        committed: false,
        reason: 'epic-missing',
        detail: `read-tree failed: ${readTree.stderr || readTree.stdout}`,
      };
    }

    // Hash each blob (writing it to the object DB) and stage it in the
    // temp index.
    for (const t of targets) {
      const hashRes = runGit(['hash-object', '-w', '--', t.abs]);
      if (hashRes.status !== 0) {
        throw new Error(
          `[baseline-snapshot] hash-object failed for ${t.rel}: ${hashRes.stderr}`,
        );
      }
      const blobSha = hashRes.stdout;
      const updateIdx = runGit(
        ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${t.rel}`],
        env,
      );
      if (updateIdx.status !== 0) {
        throw new Error(
          `[baseline-snapshot] update-index failed for ${t.rel}: ${updateIdx.stderr}`,
        );
      }
    }

    // Write the staged tree.
    const writeTree = runGit(['write-tree'], env);
    if (writeTree.status !== 0) {
      throw new Error(
        `[baseline-snapshot] write-tree failed: ${writeTree.stderr}`,
      );
    }
    const newTreeSha = writeTree.stdout;

    // Compare against the parent tree — skip the commit when nothing moved.
    const parentTreeRes = runGit(['rev-parse', `${parentSha}^{tree}`]);
    if (parentTreeRes.status === 0 && parentTreeRes.stdout === newTreeSha) {
      return { committed: false, reason: 'no-change' };
    }

    // Author the commit and attach it to the Epic branch ref.
    const commitRes = runGit([
      'commit-tree',
      newTreeSha,
      '-p',
      parentSha,
      '-m',
      message,
    ]);
    if (commitRes.status !== 0) {
      throw new Error(
        `[baseline-snapshot] commit-tree failed: ${commitRes.stderr}`,
      );
    }
    const newCommitSha = commitRes.stdout;

    const updateRef = runGit([
      'update-ref',
      `refs/heads/${epicBranch}`,
      newCommitSha,
      parentSha,
    ]);
    if (updateRef.status !== 0) {
      throw new Error(
        `[baseline-snapshot] update-ref failed: ${updateRef.stderr}`,
      );
    }

    logger.info?.(
      `[baseline-snapshot] committed ${targets.length} snapshot file(s) to ${epicBranch} (${newCommitSha.slice(0, 7)}).`,
    );
    return { committed: true, sha: newCommitSha };
  } finally {
    // Best-effort cleanup of the temp index file.
    try {
      if (fsImpl.existsSync(tmpIndex)) fsImpl.unlinkSync(tmpIndex);
    } catch {
      // ignore — temp file in OS tmpdir, not our problem long-term
    }
  }
}

/**
 * Re-score the main baselines from the current working tree and write the
 * result back to the tracked baseline paths.
 *
 * Story #2135 / Task #2145 — rewritten to route every write through the
 * shared `lib/baselines/writer.js` funnel. The legacy `saveMaintainabilityFn`
 * / `saveCrapFn` injection seams are gone — the writer is itself the seam
 * (`writeFn` + `writeFileFn`), and the on-disk envelopes are now the
 * canonical V2 shape that `lib/baselines/reader.js` schema-validates.
 *
 * Change detection now uses the writer's structural-equality short-circuit
 * rather than write-then-byte-compare: we read the prior envelope through
 * the reader, pass it to the writer as `priorEnvelope`, and inspect the
 * returned envelope's `generatedAt`. When the rows + rollup are
 * structurally equal to the prior, the writer returns the prior envelope
 * unchanged and `didChange` stays false — no `writeFile` is invoked, the
 * on-disk bytes are guaranteed identical.
 *
 * Returns `{ didChange, files }` so callers (epic-deliver-finalize) can decide
 * whether to author a `baseline-refresh: epic-<id>` commit. `didChange` is the
 * union of per-file change detection — if any baseline's bytes change, the
 * commit is needed.
 *
 * Coverage source for crap regeneration defaults to `coverage/coverage-final.json`
 * via `delivery.quality.gates.crap.coveragePath`. When coverage is missing and
 * `requireCoverage` is true, the crap regeneration is skipped (didChange stays
 * false for that file) and a warn is emitted — the operator is expected to run
 * `npm run test:coverage` before /deliver if a refresh is anticipated.
 *
 * @param {{
 *   cwd?: string,
 *   resolveConfig?: typeof defaultResolveConfig,
 *   getBaselines?: typeof defaultGetBaselines,
 *   getQuality?: typeof defaultGetQuality,
 *   logger?: { warn?: (m: string) => void, info?: (m: string) => void },
 *   fsImpl?: { existsSync: typeof fs.existsSync, readFileSync: typeof fs.readFileSync, writeFileSync: typeof fs.writeFileSync, mkdirSync: typeof fs.mkdirSync, renameSync?: typeof fs.renameSync },
 *   scanDirectoryFn?: typeof scanDirectory,
 *   calculateAllFn?: typeof calculateAll,
 *   scanAndScoreFn?: typeof scanAndScore,
 *   loadCoverageFn?: typeof loadCoverage,
 *   resolveEscomplexVersionFn?: typeof resolveEscomplexVersion,
 *   resolveTsTranspilerVersionFn?: typeof resolveTsTranspilerVersion,
 *   writeFn?: typeof defaultWriteBaseline,
 *   writeFileFn?: typeof defaultWriteBaselineFile,
 *   loadPriorFn?: (absPath: string, kind: string) => object | null,
 * }} [opts]
 * @returns {Promise<{
 *   didChange: boolean,
 *   files: Array<{ kind: 'maintainability'|'crap', path: string, didChange: boolean, reason?: 'no-coverage'|'unchanged'|'updated' }>,
 * }>}
 */
/**
 * Build the `files[]` entry for a baseline write, choosing between the
 * structural-equality short-circuit (no write, `reason: 'unchanged'`) and
 * the stamp-and-write path (`reason: 'updated'`). Story #4075 — collapses
 * the duplicated short-circuit branch shared by the MI and CRAP passes.
 *
 * @returns {{ entry: object, wrote: boolean }}
 */
function commitBaselineEnvelope({
  kind,
  abs,
  envelope,
  priorEnvelope,
  writeFileFn,
  fsImpl,
}) {
  if (priorEnvelope && envelope === priorEnvelope) {
    return {
      entry: { kind, path: abs, didChange: false, reason: 'unchanged' },
      wrote: false,
    };
  }
  writeFileFn(abs, envelope, { fsImpl });
  return {
    entry: { kind, path: abs, didChange: true, reason: 'updated' },
    wrote: true,
  };
}

/**
 * Regenerate the maintainability baseline from a fresh tree scan. Returns
 * `null` when no maintainability baseline path is configured. The scanned
 * source list is returned so the CRAP pass can reuse it when the two passes
 * target the same dirs (Story #3663). Story #4075 — extracted from
 * `regenerateMainFromTree`.
 */
async function regenerateMaintainability({
  cwd,
  baselines,
  quality,
  scanDirectoryFn,
  calculateAllFn,
  writeFn,
  writeFileFn,
  loadPriorFn,
  fsImpl,
}) {
  const miPath = baselines?.maintainability?.path;
  if (typeof miPath !== 'string' || miPath.length === 0) return null;

  const miTargetDirs = quality?.maintainability?.targetDirs ?? [];
  const miIgnoreGlobs = quality?.maintainability?.ignoreGlobs ?? [];
  const miAbs = path.isAbsolute(miPath) ? miPath : path.resolve(cwd, miPath);
  const miSourceList = [];
  for (const dir of miTargetDirs) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    scanDirectoryFn(abs, miSourceList, { cwd, ignoreGlobs: miIgnoreGlobs });
  }
  const scores = await calculateAllFn(miSourceList);

  // Project the scoring helper's `{path: mi}` map onto the writer's
  // canonical row shape. Story #2079 path-canon defence stays in place —
  // the writer would canonicalise again, but doing it here keeps any
  // pre-canonicalised comparison inside the function meaningful.
  const miRows = filterExcludedRows(
    Object.entries(scores).map(([key, mi]) => {
      const rel = path.isAbsolute(key) ? path.relative(cwd, key) : key;
      const posixRel = rel.split(path.sep).join('/');
      return { path: canonicalisePath(posixRel), mi };
    }),
  );

  const priorMi = loadPriorFn(miAbs, 'maintainability');
  const envelope = writeFn({
    kind: 'maintainability',
    rows: miRows,
    priorEnvelope: priorMi,
  });
  const { entry, wrote } = commitBaselineEnvelope({
    kind: 'maintainability',
    abs: miAbs,
    envelope,
    priorEnvelope: priorMi,
    writeFileFn,
    fsImpl,
  });
  return { entry, wrote, miSourceList, miTargetDirs, miIgnoreGlobs };
}

/**
 * Decide whether the CRAP pass can reuse the MI scan's file list — true only
 * when both passes target the same dirs with the same ignore globs
 * (Story #3663).
 */
function crapDirsMatchMi({
  miSourceList,
  crapTargetDirs,
  crapIgnoreGlobs,
  miTargetDirs,
  miIgnoreGlobs,
}) {
  return (
    miSourceList !== null &&
    crapTargetDirs.length === miTargetDirs.length &&
    crapTargetDirs.every((d, i) => d === miTargetDirs[i]) &&
    crapIgnoreGlobs.length === miIgnoreGlobs.length &&
    crapIgnoreGlobs.every((g, i) => g === miIgnoreGlobs[i])
  );
}

/**
 * Config-only sibling of `crapDirsMatchMi` (Story #4192): decide — before any
 * tree scan — whether the MI and CRAP passes target the same dirs with the
 * same ignore globs. When true, `regenerateMainFromTree` collapses the two
 * escomplex passes into a single combined `analyzeOnce` scan; when false it
 * falls back to the independent two-pass path. Pure array compare, no scan
 * list required.
 */
function crapConfigMatchesMi({
  crapTargetDirs,
  crapIgnoreGlobs,
  miTargetDirs,
  miIgnoreGlobs,
}) {
  return (
    crapTargetDirs.length === miTargetDirs.length &&
    crapTargetDirs.every((d, i) => d === miTargetDirs[i]) &&
    crapIgnoreGlobs.length === miIgnoreGlobs.length &&
    crapIgnoreGlobs.every((g, i) => g === miIgnoreGlobs[i])
  );
}

/**
 * Run the combined MI + CRAP single-pass scan once and project it into the
 * `{ calculateAllFn, scanDirectoryFn, scanAndScoreFn, loadCoverageFn }`
 * injection seams that `regenerateMaintainability` / `regenerateCrap` already
 * consume. Returns `null` when the combined path is NOT eligible (either
 * baseline unconfigured, dirs/globs differ, or coverage is required but
 * missing) — the caller then falls back to the two independent passes.
 *
 * Eligibility deliberately requires coverage to be present under
 * `requireCoverage`: when coverage is missing, the two-pass path takes a
 * dedicated `no-coverage` short-circuit for CRAP (no scan at all), and
 * reproducing that precise envelope is cleaner by deferring to the existing
 * `regenerateCrap` branch than by routing through the combined scanner.
 *
 * Story #4192 — collapses the duplicate escomplex AST parse on the full-tree
 * baseline path (2 parses/file → 1 parse/file). Byte-for-byte equivalent to
 * the two-pass path: the combined scan returns the same MI score map and the
 * same CRAP rows the separate passes would, and the downstream projection +
 * writer logic is shared verbatim.
 *
 * @returns {Promise<null | {
 *   calculateAllFn: () => Promise<Record<string, number>>,
 *   scanDirectoryFn: (dir: string, list: string[]) => string[],
 *   scanAndScoreFn: () => Promise<{ rows: Array<object> }>,
 *   loadCoverageFn: () => object,
 * }>}
 */
async function buildCombinedScanSeams({
  cwd,
  baselines,
  quality,
  loadCoverageFn,
  scanAndScoreCombinedFn,
}) {
  const miPath = baselines?.maintainability?.path;
  const crapPath = baselines?.crap?.path;
  if (
    typeof miPath !== 'string' ||
    miPath.length === 0 ||
    typeof crapPath !== 'string' ||
    crapPath.length === 0
  ) {
    return null; // both baselines must be configured to combine
  }

  const miTargetDirs = quality?.maintainability?.targetDirs ?? [];
  const miIgnoreGlobs = quality?.maintainability?.ignoreGlobs ?? [];
  const crapCfg = quality?.crap ?? {};
  const crapTargetDirs = Array.isArray(crapCfg.targetDirs)
    ? crapCfg.targetDirs
    : [];
  const crapIgnoreGlobs = Array.isArray(crapCfg.ignoreGlobs)
    ? crapCfg.ignoreGlobs
    : [];

  if (
    !crapConfigMatchesMi({
      crapTargetDirs,
      crapIgnoreGlobs,
      miTargetDirs,
      miIgnoreGlobs,
    })
  ) {
    return null; // dirs/globs differ → two-pass fallback
  }

  const requireCoverage = crapCfg.requireCoverage !== false;
  const coveragePath = crapCfg.coveragePath ?? 'coverage/coverage-final.json';
  const coverageAbs = path.isAbsolute(coveragePath)
    ? coveragePath
    : path.resolve(cwd, coveragePath);
  const coverage = loadCoverageFn(coverageAbs);

  if (!coverage && requireCoverage) {
    return null; // no coverage → let the two-pass CRAP short-circuit run
  }

  const { miScores, crap } = await scanAndScoreCombinedFn({
    targetDirs: miTargetDirs,
    coverage,
    requireCoverage,
    cwd,
    ignoreGlobs: miIgnoreGlobs,
  });

  return {
    // MI consumes the precomputed score map directly; the scanDirectory seam
    // is short-circuited to a no-op list (the combined scan already walked
    // the tree), so regenerateMaintainability's projection runs unchanged.
    calculateAllFn: async () => miScores,
    scanDirectoryFn: (_dir, list = []) => list,
    // CRAP consumes the precomputed scan result; coverage is already loaded
    // so its loadCoverage seam returns the same object without re-reading.
    scanAndScoreFn: async () => crap,
    loadCoverageFn: () => coverage,
  };
}

/**
 * Regenerate the CRAP baseline from a fresh tree scan + coverage map.
 * Returns `null` when no CRAP baseline path is configured. Story #4075 —
 * extracted from `regenerateMainFromTree`.
 */
async function regenerateCrap({
  cwd,
  baselines,
  quality,
  logger,
  miScan,
  scanAndScoreFn,
  loadCoverageFn,
  resolveEscomplexVersionFn,
  resolveTsTranspilerVersionFn,
  writeFn,
  writeFileFn,
  loadPriorFn,
  fsImpl,
}) {
  const crapPath = baselines?.crap?.path;
  if (typeof crapPath !== 'string' || crapPath.length === 0) return null;

  const crapCfg = quality?.crap ?? {};
  const crapTargetDirs = Array.isArray(crapCfg.targetDirs)
    ? crapCfg.targetDirs
    : [];
  const crapIgnoreGlobs = Array.isArray(crapCfg.ignoreGlobs)
    ? crapCfg.ignoreGlobs
    : [];
  const requireCoverage = crapCfg.requireCoverage !== false;
  const coveragePath = crapCfg.coveragePath ?? 'coverage/coverage-final.json';
  const crapAbs = path.isAbsolute(crapPath)
    ? crapPath
    : path.resolve(cwd, crapPath);
  const coverageAbs = path.isAbsolute(coveragePath)
    ? coveragePath
    : path.resolve(cwd, coveragePath);
  const coverage = loadCoverageFn(coverageAbs);

  if (!coverage && requireCoverage) {
    logger.warn?.(
      `[baseline-snapshot] ⚠ no coverage at ${coveragePath} — skipping crap regeneration (refresh stays clean for this file).`,
    );
    return {
      entry: {
        kind: 'crap',
        path: crapAbs,
        didChange: false,
        reason: 'no-coverage',
      },
      wrote: false,
    };
  }

  const reusePreScan = crapDirsMatchMi({
    miSourceList: miScan?.miSourceList ?? null,
    crapTargetDirs,
    crapIgnoreGlobs,
    miTargetDirs: miScan?.miTargetDirs ?? [],
    miIgnoreGlobs: miScan?.miIgnoreGlobs ?? [],
  });
  const { rows } = await scanAndScoreFn({
    targetDirs: crapTargetDirs,
    coverage,
    requireCoverage,
    cwd,
    ignoreGlobs: crapIgnoreGlobs,
    ...(reusePreScan && { preScannedFiles: miScan.miSourceList }),
  });
  // scanAndScore yields rows keyed by `file:`; the per-kind crap module's
  // `projectRow` handles `path ?? file`, so the writer takes either.
  // Filter to actually-scored rows here (crap is nullable for trivial
  // methods); the writer's `assertEnvelope` would reject otherwise.
  const crapRows = (rows ?? []).filter(
    (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
  );

  // CRAP gates need the running scorer's versions present on the
  // envelope-adjacent shape; the V2 envelope itself only carries
  // `kernelVersion`, so we stamp escomplex/tsTranspiler via the writer's
  // `kernelVersion` override and let the existing per-kind module resolve
  // the rest. We also resolve them eagerly so a test stub can pin them
  // deterministically.
  resolveEscomplexVersionFn(cwd);
  resolveTsTranspilerVersionFn();

  const priorCrap = loadPriorFn(crapAbs, 'crap');
  const envelope = writeFn({
    kind: 'crap',
    rows: crapRows,
    priorEnvelope: priorCrap,
  });
  return commitBaselineEnvelope({
    kind: 'crap',
    abs: crapAbs,
    envelope,
    priorEnvelope: priorCrap,
    writeFileFn,
    fsImpl,
  });
}

export async function regenerateMainFromTree({
  cwd = process.cwd(),
  resolveConfig = defaultResolveConfig,
  getBaselines = defaultGetBaselines,
  getQuality = defaultGetQuality,
  logger = console,
  fsImpl = fs,
  scanDirectoryFn = scanDirectory,
  calculateAllFn = calculateAll,
  scanAndScoreFn = scanAndScore,
  scanAndScoreCombinedFn = scanAndScoreCombined,
  loadCoverageFn = loadCoverage,
  resolveEscomplexVersionFn = resolveEscomplexVersion,
  resolveTsTranspilerVersionFn = resolveTsTranspilerVersion,
  writeFn = defaultWriteBaseline,
  writeFileFn = defaultWriteBaselineFile,
  loadPriorFn = defaultLoadPriorEnvelope,
} = {}) {
  const config = resolveConfig({ cwd });
  const baselines = getBaselines(config);
  const quality = getQuality(config);

  const files = [];
  let didChange = false;

  // Story #4192 — when MI and CRAP target the same dirs/globs (and coverage
  // is present), collapse the two escomplex passes into a single combined
  // `analyzeOnce` scan. The combined scan is projected into the same scan
  // seams the two passes consume, so the MI/CRAP envelope projection + writer
  // logic below runs byte-for-byte identically either way. When the combined
  // path is not eligible, `combined` is `null` and the original two
  // independent passes run.
  //
  // The combined path is an internal optimization of the *production-default*
  // scan seams. A caller that injects its own `calculateAllFn` or
  // `scanAndScoreFn` is explicitly opting into the two independent passes
  // (the DI contract: "use my seam"), so the combined path defers to those
  // injected seams rather than silently bypassing them. In production neither
  // seam is overridden, so the optimization is always taken.
  const usingDefaultScanSeams =
    calculateAllFn === calculateAll && scanAndScoreFn === scanAndScore;
  const combined = usingDefaultScanSeams
    ? await buildCombinedScanSeams({
        cwd,
        baselines,
        quality,
        loadCoverageFn,
        scanAndScoreCombinedFn,
      })
    : null;

  const miCalculateAllFn = combined ? combined.calculateAllFn : calculateAllFn;
  const miScanDirectoryFn = combined
    ? combined.scanDirectoryFn
    : scanDirectoryFn;
  const crapScanAndScoreFn = combined
    ? combined.scanAndScoreFn
    : scanAndScoreFn;
  const crapLoadCoverageFn = combined
    ? combined.loadCoverageFn
    : loadCoverageFn;

  const miScan = await regenerateMaintainability({
    cwd,
    baselines,
    quality,
    scanDirectoryFn: miScanDirectoryFn,
    calculateAllFn: miCalculateAllFn,
    writeFn,
    writeFileFn,
    loadPriorFn,
    fsImpl,
  });
  if (miScan) {
    files.push(miScan.entry);
    didChange = didChange || miScan.wrote;
  }

  const crapResult = await regenerateCrap({
    cwd,
    baselines,
    quality,
    logger,
    miScan,
    scanAndScoreFn: crapScanAndScoreFn,
    loadCoverageFn: crapLoadCoverageFn,
    resolveEscomplexVersionFn,
    resolveTsTranspilerVersionFn,
    writeFn,
    writeFileFn,
    loadPriorFn,
    fsImpl,
  });
  if (crapResult) {
    files.push(crapResult.entry);
    didChange = didChange || crapResult.wrote;
  }

  return { didChange, files };
}

/**
 * Story #2135 / Task #2145 — load the prior envelope for the structural-
 * equality short-circuit. Reads the file through `reader.loadFile` (which
 * schema-validates against the per-kind envelope) and synthesises an
 * envelope object the writer can compare against. Returns `null` when the
 * file is missing, unreadable, or fails schema validation — in which case
 * the writer falls through to the normal stamp-and-write path.
 *
 * Exported as the default `loadPriorFn` so tests can replace it without
 * monkey-patching the module surface.
 */
function defaultLoadPriorEnvelope(absPath, kind) {
  try {
    const parsed = readerLoadFile(absPath, { kind });
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    // Synthesise the envelope shape the writer's short-circuit expects.
    return {
      $schema: `.agents/schemas/baselines/${kind}.schema.json`,
      kernelVersion: parsed.kernelVersion,
      generatedAt: parsed.generatedAt,
      rollup: parsed.rollup,
      rows: parsed.rows,
    };
  } catch {
    return null;
  }
}

/**
 * Story #1396 (re-targeted by Story #1467; relocated by Story #1585):
 * fork the tracked main baselines into `temp/epic/<id>/baselines/` and
 * commit the snapshots onto the Epic branch. Originally lived in
 * `epic-plan-spec.js`; relocated to the lower-level module so callers
 * (notably `lib/story-init/branch-initializer.js`) do not need to import
 * the heavy CLI script.
 *
 * `epic-plan-spec.js` re-exports this symbol to preserve the historic
 * import path and the existing test suite.
 *
 * Failure modes are non-fatal: a missing source baseline downgrades to a
 * `--full-scope` warning, an unresolvable Epic branch is logged and
 * skipped, and the helper never throws into the caller. Idempotent: the
 * downstream `commitSnapshotsToEpicBranch` returns `no-change` when the
 * staged tree matches the Epic branch tip, so subsequent invocations on
 * the same Epic produce no new commit.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   baseBranch?: string,
 *   logger?: object,
 *   forkFn?: typeof forkMainToEpic,
 *   commitFn?: typeof commitSnapshotsToEpicBranch,
 *   ensureEpicBranchRefFn?: typeof defaultEnsureEpicBranchRef,
 * }} opts
 * @returns {{ fork: object, commit: object }}
 */
export function forkAndCommitEpicSnapshot({
  epicId,
  cwd = PROJECT_ROOT,
  baseBranch = 'main',
  logger = console,
  forkFn = forkMainToEpic,
  commitFn = commitSnapshotsToEpicBranch,
  ensureEpicBranchRefFn = defaultEnsureEpicBranchRef,
} = {}) {
  const epicBranch = `epic/${epicId}`;
  try {
    ensureEpicBranchRefFn(epicBranch, baseBranch, cwd, {
      progress: () => {},
    });
  } catch (err) {
    logger.warn?.(
      `[baseline-snapshot] snapshot-fork: failed to ensure ${epicBranch}: ${err?.message ?? err}. Skipping fork.`,
    );
    return {
      fork: { epicId, results: [] },
      commit: { committed: false, reason: 'epic-missing' },
    };
  }
  const fork = forkFn({ epicId, cwd, logger });
  const commit = commitFn({
    epicId,
    cwd,
    epicBranch,
    files: fork.results.filter((r) => r.written || r.reason === 'idempotent'),
    logger,
  });
  return { fork, commit };
}
