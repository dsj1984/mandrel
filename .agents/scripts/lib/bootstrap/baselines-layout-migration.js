/**
 * bootstrap/baselines-layout-migration — Story #1401 (Epic #1386),
 * re-targeted by Story #1467 (Epic #1179).
 *
 * Idempotent helper that brings a project's per-Epic ratchet snapshots into
 * the `temp/epic/<id>/baselines/` namespace. Three legacy shapes are
 * recognised and migrated:
 *
 *   1. Loose per-Epic snapshots at the baselines root
 *      (`baselines/epic-<id>-{maintainability,crap}.json`).
 *   2. The flat prototype `baselines/snapshots/<id>/` tree.
 *   3. The committed `baselines/epic/<id>/` subdirectory shape that the
 *      original Story #1396 introduced (now superseded — committed snapshots
 *      accumulated obsolete entries forever because nothing pruned them).
 *
 * All three shapes are relocated under `<repoRoot>/temp/epic/<id>/baselines/`,
 * where they inherit the existing per-epic temp-tree cleanup contract:
 * `/epic-deliver` reaps `temp/epic/<id>/` on merge, so the ratchet snapshots
 * are ephemeral scratch state — never committed, no manual prune.
 *
 * The main-tracked `baselines/{maintainability,crap}.json` files are NOT
 * touched — they remain at the root as the `main`-baseline contract
 * specifies.
 *
 * Pruning committed leftovers
 * ---------------------------
 * When the legacy `baselines/epic/<id>/` subdirectory shape is detected, the
 * helper invokes `git rm -r --quiet baselines/epic/<id>` (with
 * `--ignore-unmatch` for the untracked case) so the now-empty committed tree
 * is removed in the same operation. Callers commit the resulting working-tree
 * delta; on a clean repo (no committed `baselines/epic/`) the helper is a
 * filesystem-only no-op.
 *
 * The helper reports the per-Epic outcome so the workflow can summarise
 * exactly which snapshots moved and which were already in the target
 * shape. Re-running on an already-migrated tree produces zero mutations.
 *
 * @module bootstrap/baselines-layout-migration
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Detect and migrate any legacy per-Epic snapshot under `baselinesDir` into
 * the `temp/epic/<id>/baselines/` shape under `repoRoot`. Returns one of
 * three actions per discovered snapshot.
 *
 * @param {object} args
 * @param {string} args.baselinesDir - Absolute path to the project's
 *   `baselines/` directory (the legacy source-of-snapshots locator).
 * @param {string} [args.repoRoot] - Absolute path to the project root.
 *   Defaults to `path.dirname(baselinesDir)` so existing callers that only
 *   pass `baselinesDir` continue to work for repos where `baselines/` sits
 *   directly under the repo root (the canonical layout).
 * @param {typeof defaultSpawnSync} [args.spawnSync] - Injected for tests.
 */
export function migrateBaselinesLayout(args) {
  const baselinesDir = args.baselinesDir;
  const repoRoot = args.repoRoot ?? path.dirname(baselinesDir);
  const spawnSync = args.spawnSync ?? defaultSpawnSync;
  const moves = [];
  const prunedDirs = [];

  if (!fs.existsSync(baselinesDir)) {
    return { action: 'no-baselines-dir', moves, prunedDirs };
  }

  const tempEpicRoot = path.join(repoRoot, 'temp', 'epic');

  // Shape 1: loose per-Epic snapshots at the root.
  const entries = fs.readdirSync(baselinesDir, { withFileTypes: true });
  const looseRe = /^epic-(\d+)-(maintainability|crap)\.json$/;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(looseRe);
    if (!m) continue;
    const [, epicId, gate] = m;
    const from = path.join(baselinesDir, ent.name);
    const toDir = path.join(tempEpicRoot, epicId, 'baselines');
    const to = path.join(toDir, `${gate}.json`);
    if (fs.existsSync(to)) {
      // Target already populated by an earlier migration or the /epic-plan
      // fork. Discard the legacy file rather than overwriting the canonical
      // snapshot.
      fs.rmSync(from);
      moves.push({ from, to, action: 'discarded-superseded' });
      continue;
    }
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(from, to);
    moves.push({ from, to, action: 'relocated-loose' });
  }

  // Shape 2: prototype `baselines/snapshots/<id>/` tree.
  const protoRoot = path.join(baselinesDir, 'snapshots');
  if (fs.existsSync(protoRoot) && fs.statSync(protoRoot).isDirectory()) {
    for (const epicEnt of fs.readdirSync(protoRoot, { withFileTypes: true })) {
      if (!epicEnt.isDirectory()) continue;
      if (!/^\d+$/.test(epicEnt.name)) continue;
      const epicId = epicEnt.name;
      const fromDir = path.join(protoRoot, epicId);
      const toDir = path.join(tempEpicRoot, epicId, 'baselines');
      for (const fileEnt of fs.readdirSync(fromDir, { withFileTypes: true })) {
        if (!fileEnt.isFile()) continue;
        if (!/^(maintainability|crap)\.json$/.test(fileEnt.name)) continue;
        const from = path.join(fromDir, fileEnt.name);
        const to = path.join(toDir, fileEnt.name);
        if (fs.existsSync(to)) {
          fs.rmSync(from);
          moves.push({ from, to, action: 'discarded-superseded' });
          continue;
        }
        fs.mkdirSync(toDir, { recursive: true });
        fs.renameSync(from, to);
        moves.push({ from, to, action: 'relocated-prototype' });
      }
      // Drop the now-empty prototype dir to keep the tree clean.
      const remaining = fs.readdirSync(fromDir);
      if (remaining.length === 0) fs.rmdirSync(fromDir);
    }
    // Drop the prototype root if it ends up empty.
    const remainingProto = fs.readdirSync(protoRoot);
    if (remainingProto.length === 0) fs.rmdirSync(protoRoot);
  }

  // Shape 3: committed `baselines/epic/<id>/` subdirectory layout (the
  // shape Story #1396 introduced; superseded by the temp-namespace contract
  // in Story #1467). Move snapshots OUT to temp and prune the committed
  // tree via `git rm -r`.
  const committedEpicRoot = path.join(baselinesDir, 'epic');
  if (
    fs.existsSync(committedEpicRoot) &&
    fs.statSync(committedEpicRoot).isDirectory()
  ) {
    for (const epicEnt of fs.readdirSync(committedEpicRoot, {
      withFileTypes: true,
    })) {
      if (!epicEnt.isDirectory()) continue;
      if (!/^\d+$/.test(epicEnt.name)) continue;
      const epicId = epicEnt.name;
      const fromDir = path.join(committedEpicRoot, epicId);
      const toDir = path.join(tempEpicRoot, epicId, 'baselines');
      for (const fileEnt of fs.readdirSync(fromDir, { withFileTypes: true })) {
        if (!fileEnt.isFile()) continue;
        if (!/^(maintainability|crap)\.json$/.test(fileEnt.name)) continue;
        const from = path.join(fromDir, fileEnt.name);
        const to = path.join(toDir, fileEnt.name);
        if (fs.existsSync(to)) {
          fs.rmSync(from);
          moves.push({ from, to, action: 'discarded-superseded' });
          continue;
        }
        fs.mkdirSync(toDir, { recursive: true });
        fs.renameSync(from, to);
        moves.push({ from, to, action: 'relocated-committed' });
      }
      // Drop the now-empty committed dir and stage the removal via git so
      // the next commit prunes the tracked tree. `--ignore-unmatch` keeps
      // the call safe when the path is not tracked (fresh-clone case).
      const remaining = fs.readdirSync(fromDir);
      if (remaining.length === 0) {
        fs.rmdirSync(fromDir);
      }
      const epicRelPath = path
        .relative(repoRoot, fromDir)
        .split(path.sep)
        .join('/');
      const rm = spawnSync(
        'git',
        ['rm', '-r', '--quiet', '--ignore-unmatch', '--', epicRelPath],
        { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe', shell: false },
      );
      prunedDirs.push({
        path: epicRelPath,
        gitStatus: rm.status ?? null,
      });
    }
    // Drop the committed root if it ends up empty on disk.
    const remainingCommitted = fs.existsSync(committedEpicRoot)
      ? fs.readdirSync(committedEpicRoot)
      : [];
    if (remainingCommitted.length === 0 && fs.existsSync(committedEpicRoot)) {
      fs.rmdirSync(committedEpicRoot);
    }
  }

  return {
    action:
      moves.length > 0 || prunedDirs.length > 0 ? 'migrated' : 'no-change',
    moves,
    prunedDirs,
  };
}
