import nodeFs from 'node:fs';
import path from 'node:path';

/**
 * Detects "worktree residue" — stories that the ticket graph reports as done,
 * but whose `.worktrees/story-<id>/` directory is still on disk. This usually
 * means story-close failed to reap the worktree (see the Windows
 * partial-reap failure mode in friction memory), and a future run of the
 * same story id would collide with the stale directory.
 *
 * The detector is pure (aside from fs reads) and accepts an fs adapter so the
 * unit test can drive present/absent cases without touching disk.
 *
 * @param {{
 *   fs?: { existsSync: (p: string) => boolean },
 *   cwd?: string,
 * }} [opts]
 * @returns {(rows: Array<{id:number|string, state:string}>) => Promise<string[]>}
 */
export function createStalledWorktreeDetector(opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const cwd = opts.cwd ?? process.cwd();
  return async function detect(rows = []) {
    const bullets = [];
    for (const row of rows) {
      if (row?.state !== 'done') continue;
      const relPath = `.worktrees/story-${row.id}`;
      const absPath = path.join(cwd, relPath);
      if (fs.existsSync(absPath)) {
        bullets.push(
          `⚠️ Worktree residue: #${row.id} marked done but .worktrees/story-${row.id}/ still present`,
        );
      }
    }
    return bullets;
  };
}
