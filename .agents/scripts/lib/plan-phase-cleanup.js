/**
 * plan-phase-cleanup.js — Post-phase temp-file cleanup for `/plan`.
 *
 * The spec and decompose phases write several Epic-scoped temp files under
 * the per-Epic tree (`temp/epic-<id>/planner-context.json`,
 * `temp/epic-<id>/techspec.md`, etc. — see `lib/config/temp-paths.js`). The
 * workflow .md previously told the operator to `Remove-Item` those files by
 * name at the end of each phase, which rots: adding a new temp file in the
 * script required a synchronized markdown edit, and missed edits left
 * orphaned files accumulating in `temp/`.
 *
 * The wrapper scripts now call `cleanupPhaseTempFiles()` directly. The set
 * of artifact basenames a phase creates is the contract of this module —
 * when a new temp file is introduced, extend `PHASE_TEMP_BASENAMES` here
 * and both the spec and decompose wrappers delete it automatically.
 *
 * Cleanup is best-effort: missing files are fine (`ENOENT` is ignored),
 * unexpected errors are swallowed with a console warning so a failed rm
 * never sinks a successful phase.
 *
 * Migration note (Epic #1030 Story #1040): the legacy flat layout
 * (`temp/planner-context-epic-<id>.json` etc.) has been retired. The
 * resolver now delegates to `epicArtifactPath` from
 * `lib/config/temp-paths.js`, which yields `temp/epic-<id>/<basename>`
 * under the configured `tempRoot`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { epicArtifactPath } from './config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './config-resolver.js';

/**
 * Map of phase → artifact basenames (no path components). The per-Epic
 * directory prefix is supplied by `epicArtifactPath` at resolution time.
 */
export const PHASE_TEMP_BASENAMES = Object.freeze({
  spec: Object.freeze([
    'planner-context.json',
    'techspec.md',
    'acceptance-spec.md',
  ]),
  decompose: Object.freeze(['decomposer-context.json', 'tickets.json']),
  // Epic #4474 (PR3) — the collapsed `plan-persist.js` surface owns every
  // plan-phase artifact and deletes them ONLY at terminal success (after
  // the `agent::ready` flip), fixing the mid-pipeline deletion defect where
  // per-phase cleanup removed artifacts a `--force`/`--resume` re-persist
  // was still entitled to reuse. `risk-verdict.json` joins the set here:
  // the split-phase cleanup never owned it, which orphaned it in temp/.
  // `plan-metrics.json` stays deliberately excluded (PR1) — the ledger
  // must survive cleanup so the whole plan run is visible in one stream.
  persist: Object.freeze([
    'planner-context.json',
    'techspec.md',
    'acceptance-spec.md',
    'risk-verdict.json',
    'decomposer-context.json',
    'tickets.json',
  ]),
});

/**
 * Resolve the concrete paths a phase owns for a given Epic.
 *
 * @param {'spec'|'decompose'} phase
 * @param {number} epicId
 * @param {string} [repoRoot]
 * @returns {string[]} Absolute paths under `<repoRoot>/<tempRoot>/epic-<id>/`.
 */
export function resolvePhaseTempPaths(phase, epicId, repoRoot = PROJECT_ROOT) {
  const basenames = PHASE_TEMP_BASENAMES[phase];
  if (!basenames) {
    throw new Error(
      `[plan-phase-cleanup] Unknown phase "${phase}". Expected one of: ${Object.keys(PHASE_TEMP_BASENAMES).join(', ')}.`,
    );
  }
  // Thread the resolved config so we honour `project.paths.tempRoot`
  // overrides; fall back to the helper's default when the resolver itself
  // throws (zero-config callers — unit tests).
  let config;
  try {
    config = resolveConfig({ cwd: repoRoot });
  } catch {
    config = undefined;
  }
  return basenames.map((basename) => {
    const rel = epicArtifactPath(epicId, basename, config);
    // `epicArtifactPath` yields a path under `tempRoot` (relative when
    // tempRoot is itself relative — the framework default). Rebase
    // relative paths against `repoRoot` so callers always receive an
    // absolute path — matches the pre-migration contract that
    // downstream `fs.unlink` relies on. Already-absolute results pass
    // through untouched.
    return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  });
}

/**
 * Delete the temp files a phase owns for the given Epic. Idempotent:
 * missing files are ignored; other errors are logged but do not throw.
 *
 * @param {{
 *   phase: 'spec'|'decompose',
 *   epicId: number,
 *   repoRoot?: string,
 *   unlink?: (p: string) => Promise<void>,
 *   logger?: { warn: Function },
 * }} opts
 * @returns {Promise<{ deleted: string[], missing: string[], failed: Array<{ path: string, reason: string }> }>}
 */
export async function cleanupPhaseTempFiles({
  phase,
  epicId,
  repoRoot = PROJECT_ROOT,
  unlink = fs.unlink,
  logger = console,
}) {
  const paths = resolvePhaseTempPaths(phase, epicId, repoRoot);
  const deleted = [];
  const missing = [];
  const failed = [];

  for (const p of paths) {
    try {
      await unlink(p);
      deleted.push(p);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        missing.push(p);
        continue;
      }
      failed.push({ path: p, reason: err?.message ?? String(err) });
      logger?.warn?.(
        `[plan-phase-cleanup] ⚠️  Failed to delete ${p}: ${err?.message ?? err}`,
      );
    }
  }

  return { deleted, missing, failed };
}
