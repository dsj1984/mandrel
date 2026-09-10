/**
 * `tests/helpers/projected-commands.js` — a deterministic `.claude/commands/`
 * projection for the structural rename/retirement guards.
 *
 * ## Why this exists
 *
 * `.claude/commands/` is a **generated** mirror of `.agents/workflows/`, and
 * it is gitignored (`.gitignore:53`). It is materialized by the `prepare`
 * lifecycle script (`npm run sync:commands`), so it is present after an
 * `npm install` / `npm ci` — and **absent** in a freshly materialized git
 * worktree, which inherits `node_modules/` by clone and therefore never runs
 * `prepare`. Every worktree-based delivery that ran the full suite hit that
 * empty directory and had to diagnose it by hand.
 *
 * Guards that asserted on the on-disk mirror were therefore asserting two
 * different things at once:
 *
 *   - "the rename/retirement is correctly reflected in the projection" — the
 *     real claim; and
 *   - "somebody has run `npm run sync:commands` in this checkout" — an
 *     environment fact, which is what actually broke.
 *
 * This helper separates them. It runs the **real** sync script against the
 * repository's **real** `.agents/workflows/` tree, projecting into a managed
 * temp directory via the script's own `SYNC_CLAUDE_COMMANDS_SRC` / `_DEST`
 * fixture seams. The resulting file set is a function of tracked source alone,
 * so the guards keep their full strength in any checkout — and gain some: they
 * now prove the projection the sync *would* produce, rather than trusting a
 * stale mirror somebody happened to have on disk.
 *
 * Setting `SYNC_CLAUDE_COMMANDS_DEST` also disables the script's
 * `reapPluginTree()` step, so a projection run never touches the real
 * `.claude/` tree.
 *
 * ## Why the sync runs from an empty scratch directory
 *
 * `SYNC_CLAUDE_COMMANDS_SRC` overrides the **payload** source only. The
 * second source — `.agents/local/workflows/`, the consumer-owned, sync-exempt
 * zone — is resolved from the script's `process.cwd()` and has no override.
 * Running the projection from the repository root therefore folded whatever
 * the developer happened to have in their own local zone into the file set
 * these guards assert over: a hand-authored `/scratch.md` would make a
 * structural rename guard pass or fail on a file that is not in the
 * repository and that CI will never see.
 *
 * Pointing `cwd` at an empty directory resolves `LOCAL_SRC` to a path that
 * does not exist, which the script already filters out. The projection is
 * then a function of tracked payload source alone — the property this helper
 * exists to provide.
 *
 * @see .agents/scripts/sync-claude-commands.js — the projector under test.
 * @see tests/sync-claude-commands-local.test.js — the same seams, driven with
 *      synthetic fixture workflows rather than the real payload.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);
const WORKFLOWS_SRC = path.join(REPO_ROOT, '.agents', 'workflows');

/**
 * List every projected file under `dir`, as destination-relative POSIX paths
 * (`qa-run.md`, `loops/<name>.md`) — matching the `rel` keys the sync script
 * itself projects and reaps on.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listProjected(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listProjected(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Project `.agents/workflows/` into a managed temp directory by running the
 * real sync script, and return what it wrote.
 *
 * @param {{ seedOrphans?: string[] }} [options]
 *   `seedOrphans` — destination-relative paths to plant in the destination
 *   *before* the sync runs, so a caller can assert the orphan-reap actually
 *   removes a stale generated command (rather than merely observing that one
 *   is absent from a tree it was never in).
 * @returns {{ dest: string, files: string[], has: (rel: string) => boolean }}
 */
export function projectCommands({ seedOrphans = [] } = {}) {
  const scratch = makeTempDir('projected-commands-');
  const dest = path.join(scratch, 'commands');
  fs.mkdirSync(dest, { recursive: true });
  // The sync's cwd: empty, so LOCAL_SRC resolves to a path that does not
  // exist and the developer's own local zone cannot enter the projection.
  const cwd = path.join(scratch, 'empty-cwd');
  fs.mkdirSync(cwd, { recursive: true });

  for (const rel of seedOrphans) {
    const abs = path.join(dest, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'stale generated command\n', 'utf8');
  }

  const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
    cwd,
    env: {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: WORKFLOWS_SRC,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `sync-claude-commands.js exited ${result.status} while projecting ${WORKFLOWS_SRC}\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }

  const files = listProjected(dest);
  return { dest, files, has: (rel) => files.includes(rel) };
}

/** Memoized default projection — one sync spawn per test process. */
let _cached = null;

/**
 * The default projection (no seeded orphans), computed once per process.
 * Use this for plain "is `<name>.md` projected?" assertions; call
 * {@link projectCommands} directly when a test needs seeded orphans.
 *
 * @returns {ReturnType<typeof projectCommands>}
 */
export function projectedCommands() {
  _cached ??= projectCommands();
  return _cached;
}
