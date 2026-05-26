/**
 * phases/temp-cleanup.js — remove the per-Story manifest pair under
 * `temp/epic-<eid>/stories/story-<sid>/manifest.{md,json}` (Epic #1030
 * Story #1040). Falls back to the legacy flat
 * `temp/story-manifest-<id>.{md,json}` layout when `epicId` is unknown
 * — both paths are tried so partial migrations don't leak files in
 * either layout. All deletes are idempotent; ENOENT is silently
 * absorbed.
 */

import path from 'node:path';
import { storyArtifactPath } from '../../../config/temp-paths.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function tempCleanupPhase(ctx) {
  const { storyId, epicId, projectRoot, progress, unlinkFn, config } = ctx;
  const log = reapPhaseLogger(progress);
  const unlink = unlinkFn ?? (await import('node:fs/promises')).unlink;

  // Per-Epic layout (Epic #1030 Story #1040): `temp/epic-<eid>/stories/story-<sid>/manifest.{md,json}`.
  // Legacy flat layout: `temp/story-manifest-<sid>.{md,json}`. The migration
  // tolerates both — try the per-Epic path first when `epicId` is known,
  // and always sweep the legacy path so a half-migrated cohort doesn't
  // leave residue.
  const targets = [];
  if (epicId) {
    const eid = Number(epicId);
    const sid = Number(storyId);
    targets.push(
      {
        path: storyArtifactPath(eid, sid, 'manifest.md', config),
        label: `temp/epic-${epicId}/stories/story-${storyId}/manifest.md`,
      },
      {
        path: storyArtifactPath(eid, sid, 'manifest.json', config),
        label: `temp/epic-${epicId}/stories/story-${storyId}/manifest.json`,
      },
    );
  }
  // Legacy flat layout is rooted at the framework's projectRoot — this is
  // a half-migrated-cohort sweep, not a configured-tempRoot target. Once
  // the legacy paths can no longer exist on any live install, this block
  // can be deleted entirely.
  const legacyBase = path.join(
    projectRoot,
    'temp',
    `story-manifest-${storyId}`,
  );
  targets.push(
    { path: `${legacyBase}.md`, label: `temp/story-manifest-${storyId}.md` },
    {
      path: `${legacyBase}.json`,
      label: `temp/story-manifest-${storyId}.json`,
    },
  );

  for (const target of targets) {
    try {
      await unlink(target.path);
      log('CLEANUP', `🗑️  Deleted ${target.label}`);
    } catch {
      // File may not exist — deletion is idempotent.
    }
  }
}
