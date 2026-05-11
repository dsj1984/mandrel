/**
 * bootstrap/baselines-layout-migration — Story #1401 (Epic #1386)
 *
 * Idempotent helper that brings a project's `baselines/` tree into the
 * `baselines/epic/<id>/` subdirectory contract Story #1396 introduced. Two
 * legacy shapes are recognised and migrated:
 *
 *   1. Loose per-Epic snapshots at the baselines root
 *      (`baselines/epic-<id>-{maintainability,crap}.json`) — relocated
 *      under `baselines/epic/<id>/{maintainability,crap}.json`.
 *   2. A flat `baselines/snapshots/<id>/` directory the early prototypes
 *      used — re-keyed under `baselines/epic/<id>/`.
 *
 * The main-tracked `baselines/{maintainability,crap}.json` files are NOT
 * touched — they remain at the root as the `main`-baseline contract
 * specifies.
 *
 * The helper reports the per-Epic outcome so the workflow can summarise
 * exactly which snapshots moved and which were already in the target
 * shape. Re-running on an already-migrated tree produces zero mutations.
 *
 * @module bootstrap/baselines-layout-migration
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Detect and migrate a single legacy snapshot path into the
 * `baselines/epic/<id>/` shape. Pure side-effect: filesystem moves only.
 * Returns one of three actions per discovered snapshot.
 *
 * @param {object} args
 * @param {string} args.baselinesDir - Absolute path to the project's
 *   `baselines/` directory.
 */
export function migrateBaselinesLayout(args) {
  const baselinesDir = args.baselinesDir;
  const moves = [];
  if (!fs.existsSync(baselinesDir)) {
    return { action: 'no-baselines-dir', moves };
  }

  const entries = fs.readdirSync(baselinesDir, { withFileTypes: true });

  // Shape 1: loose per-Epic snapshots at the root.
  const looseRe = /^epic-(\d+)-(maintainability|crap)\.json$/;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(looseRe);
    if (!m) continue;
    const [, epicId, gate] = m;
    const from = path.join(baselinesDir, ent.name);
    const toDir = path.join(baselinesDir, 'epic', epicId);
    const to = path.join(toDir, `${gate}.json`);
    if (fs.existsSync(to)) {
      // Target already populated by an earlier migration or the
      // /epic-plan fork. Discard the legacy file rather than overwriting
      // the canonical snapshot — the canonical one is the source of
      // truth for the Epic.
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
      const toDir = path.join(baselinesDir, 'epic', epicId);
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

  return {
    action: moves.length > 0 ? 'migrated' : 'no-change',
    moves,
  };
}
