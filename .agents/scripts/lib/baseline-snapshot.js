import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalise as canonicalisePath } from './baselines/path-canon.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
  resolveConfig as defaultResolveConfig,
  PROJECT_ROOT,
} from './config-resolver.js';
import { loadCoverage } from './coverage-utils.js';
import {
  buildBaselineEnvelope,
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  saveCrapBaseline,
  scanAndScore,
} from './crap-utils.js';
import { ensureEpicBranchRef as defaultEnsureEpicBranchRef } from './git-branch-lifecycle.js';
import {
  calculateAll,
  saveBaseline as saveMaintainabilityBaseline,
  scanDirectory,
} from './maintainability-utils.js';

/**
 * baseline-snapshot.js — per-Epic baseline lifecycle helpers.
 *
 * Story #1396 (Epic #1386). The Epic-snapshot scheme freezes the maintainability
 * and crap baselines at /epic-plan time and reconciles them back to `main`
 * at /epic-deliver time. Two helpers, both pure-ish (deterministic given the
 * working tree + injected I/O):
 *
 *   - forkMainToEpic({ epicId, cwd }) — copies the tracked main baselines
 *     under `temp/epic-<id>/baselines/`. Idempotent: re-running with the same
 *     source content produces the same destination bytes (no fs churn). When
 *     the source baseline is missing, emits a warn through the injected
 *     logger and returns `{ written: false, reason: 'source-missing' }` for
 *     that file — callers (e.g. /epic-plan Phase 7) treat the absence as
 *     non-fatal and stay in `--full-scope` mode.
 *
 *   - regenerateMainFromTree({ cwd }) — re-scores maintainability + crap
 *     against the current working tree and writes the result to the tracked
 *     main baseline paths. Returns `{ didChange, paths }` where `didChange`
 *     is true iff any baseline file's content differs from what's already on
 *     disk. Callers in /epic-deliver use `didChange === false` to skip the
 *     `baseline-refresh: epic-<id>` commit.
 *
 * Lifecycle note (Story #1467): per-epic ratchet snapshots are ephemeral
 * scratch state under the `temp/epic-<id>/baselines/` namespace, NOT committed
 * artifacts. They inherit the existing per-epic temp-tree cleanup contract —
 * `/epic-deliver` reaps the parent `temp/epic-<id>/` directory on merge, so
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
 * relocates its baselines (`agentSettings.quality.baselines.{maintainability,crap}.path`)
 * is honoured. Destination layout is fixed at `temp/epic-<id>/baselines/<kind>.json`
 * so the close-validation gate's `--epic-ref` resolution stays predictable, and
 * the per-epic temp-tree cleanup reaps them on Story merge with no extra wiring.
 *
 * Failure modes:
 *   - Source baseline missing → returned per-file `{ written: false,
 *     reason: 'source-missing' }`. Logger warn fires once per missing file.
 *     Caller stays in `--full-scope` mode.
 *   - Source unreadable / not parseable → throws. Re-running /epic-plan
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

  const { agentSettings } = resolveConfig({ cwd });
  const baselines = getBaselines({ agentSettings });
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
 * Returns `{ didChange, files }` so callers (epic-deliver-finalize) can decide
 * whether to author a `baseline-refresh: epic-<id>` commit. `didChange` is the
 * union of per-file change detection — if any baseline's bytes change, the
 * commit is needed.
 *
 * Coverage source for crap regeneration defaults to `coverage/coverage-final.json`
 * via `agentSettings.quality.crap.coveragePath`. When coverage is missing and
 * `requireCoverage` is true, the crap regeneration is skipped (didChange stays
 * false for that file) and a warn is emitted — the operator is expected to run
 * `npm run test:coverage` before /epic-deliver if a refresh is anticipated.
 *
 * @param {{
 *   cwd?: string,
 *   resolveConfig?: typeof defaultResolveConfig,
 *   getBaselines?: typeof defaultGetBaselines,
 *   getQuality?: typeof defaultGetQuality,
 *   logger?: { warn?: (m: string) => void, info?: (m: string) => void },
 *   fsImpl?: { existsSync: typeof fs.existsSync, readFileSync: typeof fs.readFileSync, writeFileSync: typeof fs.writeFileSync, mkdirSync: typeof fs.mkdirSync },
 *   scanDirectoryFn?: typeof scanDirectory,
 *   calculateAllFn?: typeof calculateAll,
 *   saveMaintainabilityFn?: typeof saveMaintainabilityBaseline,
 *   scanAndScoreFn?: typeof scanAndScore,
 *   buildBaselineEnvelopeFn?: typeof buildBaselineEnvelope,
 *   saveCrapFn?: typeof saveCrapBaseline,
 *   loadCoverageFn?: typeof loadCoverage,
 *   resolveEscomplexVersionFn?: typeof resolveEscomplexVersion,
 *   resolveTsTranspilerVersionFn?: typeof resolveTsTranspilerVersion,
 * }} [opts]
 * @returns {Promise<{
 *   didChange: boolean,
 *   files: Array<{ kind: 'maintainability'|'crap', path: string, didChange: boolean, reason?: 'no-coverage'|'unchanged'|'updated' }>,
 * }>}
 */
export async function regenerateMainFromTree({
  cwd = process.cwd(),
  resolveConfig = defaultResolveConfig,
  getBaselines = defaultGetBaselines,
  getQuality = defaultGetQuality,
  logger = console,
  fsImpl = fs,
  scanDirectoryFn = scanDirectory,
  calculateAllFn = calculateAll,
  saveMaintainabilityFn = saveMaintainabilityBaseline,
  scanAndScoreFn = scanAndScore,
  buildBaselineEnvelopeFn = buildBaselineEnvelope,
  saveCrapFn = saveCrapBaseline,
  loadCoverageFn = loadCoverage,
  resolveEscomplexVersionFn = resolveEscomplexVersion,
  resolveTsTranspilerVersionFn = resolveTsTranspilerVersion,
} = {}) {
  const { agentSettings } = resolveConfig({ cwd });
  const baselines = getBaselines({ agentSettings });
  const quality = getQuality({ agentSettings });

  const files = [];
  let didChange = false;

  // ── maintainability ──────────────────────────────────────────────────────
  const miPath = baselines?.maintainability?.path;
  const miTargetDirs = quality?.maintainability?.targetDirs ?? [];
  if (typeof miPath === 'string' && miPath.length > 0) {
    const miAbs = path.isAbsolute(miPath) ? miPath : path.resolve(cwd, miPath);
    const sourceList = [];
    for (const dir of miTargetDirs) {
      const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
      scanDirectoryFn(abs, sourceList);
    }
    const scores = await calculateAllFn(sourceList);
    // Make scores cwd-relative so the on-disk shape matches the existing
    // baseline. saveBaseline sorts keys for determinism; mirror that here so
    // the byte-equality check below is meaningful.
    // Story #2079: route every key through path-canon so a worktree-relative
    // resolution (e.g. cwd = main checkout, scanned files inside a worktree)
    // cannot leak `.worktrees/<workspace>/` into the on-disk baseline.
    const relScores = Object.create(null);
    for (const key of Object.keys(scores)) {
      const rel = path.isAbsolute(key) ? path.relative(cwd, key) : key;
      const posixRel = rel.split(path.sep).join('/');
      relScores[canonicalisePath(posixRel)] = scores[key];
    }
    const sortedScores = Object.keys(relScores)
      .sort()
      .reduce((acc, k) => {
        acc[k] = relScores[k];
        return acc;
      }, Object.create(null));

    let existing = null;
    if (fsImpl.existsSync(miAbs)) {
      try {
        existing = fsImpl.readFileSync(miAbs, 'utf8');
      } catch {
        existing = null;
      }
    }
    // Write through the canonical writer first, then byte-compare against
    // the prior content so the diff matches what's actually persisted —
    // saveBaseline applies its own key-sort + trailing newline that this
    // module is not the authoritative source for.
    saveMaintainabilityFn(sortedScores, miAbs);
    const after = fsImpl.readFileSync(miAbs, 'utf8');
    if (existing === after) {
      files.push({
        kind: 'maintainability',
        path: miAbs,
        didChange: false,
        reason: 'unchanged',
      });
    } else {
      didChange = true;
      files.push({
        kind: 'maintainability',
        path: miAbs,
        didChange: true,
        reason: 'updated',
      });
    }
  }

  // ── crap ─────────────────────────────────────────────────────────────────
  const crapPath = baselines?.crap?.path;
  const crapCfg = quality?.crap ?? {};
  const crapTargetDirs = Array.isArray(crapCfg.targetDirs)
    ? crapCfg.targetDirs
    : [];
  const requireCoverage = crapCfg.requireCoverage !== false;
  const coveragePath = crapCfg.coveragePath ?? 'coverage/coverage-final.json';
  if (typeof crapPath === 'string' && crapPath.length > 0) {
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
      files.push({
        kind: 'crap',
        path: crapAbs,
        didChange: false,
        reason: 'no-coverage',
      });
    } else {
      const { rows } = await scanAndScoreFn({
        targetDirs: crapTargetDirs,
        coverage,
        requireCoverage,
        cwd,
      });
      const escomplexVersion = resolveEscomplexVersionFn(cwd);
      const tsTranspilerVersion = resolveTsTranspilerVersionFn();
      const envelope = buildBaselineEnvelopeFn({
        rows,
        escomplexVersion,
        tsTranspilerVersion,
      });
      let existing = null;
      if (fsImpl.existsSync(crapAbs)) {
        try {
          existing = fsImpl.readFileSync(crapAbs, 'utf8');
        } catch {
          existing = null;
        }
      }
      // Same write-then-compare strategy as the maintainability branch:
      // saveCrapBaseline canonicalizes the envelope before writing, so we
      // cannot pre-compute the byte-for-byte equivalent without re-implementing
      // its row-sort + key-order rules.
      saveCrapFn(envelope, { baselinePath: crapAbs });
      const after = fsImpl.readFileSync(crapAbs, 'utf8');
      if (existing === after) {
        files.push({
          kind: 'crap',
          path: crapAbs,
          didChange: false,
          reason: 'unchanged',
        });
      } else {
        didChange = true;
        files.push({
          kind: 'crap',
          path: crapAbs,
          didChange: true,
          reason: 'updated',
        });
      }
    }
  }

  return { didChange, files };
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
