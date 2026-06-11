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
 * `/deliver` reaps `temp/epic/<id>/` on merge, so the ratchet snapshots
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

const BASELINE_FILE_RE = /^(maintainability|crap)\.json$/;
const LOOSE_FILE_RE = /^epic-(\d+)-(maintainability|crap)\.json$/;

/**
 * Move a single snapshot file to its temp-namespace target. When the target
 * already holds a canonical copy, the source is discarded instead of
 * overwriting.
 */
function moveOneSnapshot({ from, to, label, moves }) {
  if (fs.existsSync(to)) {
    fs.rmSync(from);
    moves.push({ from, to, action: 'discarded-superseded' });
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  moves.push({ from, to, action: label });
}

/**
 * Drop a directory if it exists on disk and is empty.
 */
function dropEmptyDir(absDir) {
  if (fs.existsSync(absDir) && fs.readdirSync(absDir).length === 0) {
    fs.rmdirSync(absDir);
  }
}

/**
 * Walk a per-Epic source directory (`<srcRoot>/<id>/*.json`) and migrate
 * each baseline file into `<tempEpicRoot>/<id>/baselines/`. Returns the
 * Epic dirs that were touched so the caller can run per-Epic cleanup
 * (e.g. `git rm` for the committed shape).
 */
function migrateEpicDir({ srcRoot, tempEpicRoot, label, moves }) {
  const touched = [];
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    return touched;
  }
  for (const epicEnt of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (!epicEnt.isDirectory() || !/^\d+$/.test(epicEnt.name)) continue;
    const epicId = epicEnt.name;
    const fromDir = path.join(srcRoot, epicId);
    const toDir = path.join(tempEpicRoot, epicId, 'baselines');
    for (const fileEnt of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (!fileEnt.isFile() || !BASELINE_FILE_RE.test(fileEnt.name)) continue;
      moveOneSnapshot({
        from: path.join(fromDir, fileEnt.name),
        to: path.join(toDir, fileEnt.name),
        label,
        moves,
      });
    }
    dropEmptyDir(fromDir);
    touched.push({ epicId, fromDir });
  }
  return touched;
}

/**
 * Migrate shape 1: loose per-Epic snapshots at the root of `baselines/`.
 */
function migrateLooseShape({ baselinesDir, tempEpicRoot, moves }) {
  for (const ent of fs.readdirSync(baselinesDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(LOOSE_FILE_RE);
    if (!m) continue;
    const [, epicId, gate] = m;
    moveOneSnapshot({
      from: path.join(baselinesDir, ent.name),
      to: path.join(tempEpicRoot, epicId, 'baselines', `${gate}.json`),
      label: 'relocated-loose',
      moves,
    });
  }
}

/**
 * Stage the prune of a now-empty committed `baselines/epic/<id>/` via
 * `git rm -r --quiet --ignore-unmatch`. `--ignore-unmatch` keeps the call
 * safe when the path is not tracked (fresh-clone case).
 */
function pruneCommittedEpic({ fromDir, repoRoot, spawnSync, prunedDirs }) {
  const epicRelPath = path
    .relative(repoRoot, fromDir)
    .split(path.sep)
    .join('/');
  const rm = spawnSync(
    'git',
    ['rm', '-r', '--quiet', '--ignore-unmatch', '--', epicRelPath],
    { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe', shell: false },
  );
  prunedDirs.push({ path: epicRelPath, gitStatus: rm.status ?? null });
}

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
  migrateLooseShape({ baselinesDir, tempEpicRoot, moves });

  // Shape 2: prototype `baselines/snapshots/<id>/` tree.
  const protoRoot = path.join(baselinesDir, 'snapshots');
  migrateEpicDir({
    srcRoot: protoRoot,
    tempEpicRoot,
    label: 'relocated-prototype',
    moves,
  });
  dropEmptyDir(protoRoot);

  // Shape 3: committed `baselines/epic/<id>/` subdirectory layout (the
  // shape Story #1396 introduced; superseded by the temp-namespace
  // contract in Story #1467). Move snapshots OUT to temp, prune each
  // committed per-Epic dir via `git rm`, then drop the parent.
  const committedEpicRoot = path.join(baselinesDir, 'epic');
  const touched = migrateEpicDir({
    srcRoot: committedEpicRoot,
    tempEpicRoot,
    label: 'relocated-committed',
    moves,
  });
  for (const { fromDir } of touched) {
    pruneCommittedEpic({ fromDir, repoRoot, spawnSync, prunedDirs });
  }
  dropEmptyDir(committedEpicRoot);

  return {
    action:
      moves.length > 0 || prunedDirs.length > 0 ? 'migrated' : 'no-change',
    moves,
    prunedDirs,
  };
}
