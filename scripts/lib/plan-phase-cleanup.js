/**
 * plan-phase-cleanup.js — Post-phase temp-file cleanup for `/epic-plan`.
 *
 * The spec and decompose phases write several Epic-scoped temp files under
 * `temp/` (e.g., `planner-context-epic-441.json`, `prd-epic-441.md`). The
 * workflow .md previously told the operator to `Remove-Item` those files by
 * name at the end of each phase, which rots: adding a new temp file in the
 * script required a synchronized markdown edit, and missed edits left
 * orphaned files accumulating in `temp/`.
 *
 * The wrapper scripts now call `cleanupPhaseTempFiles()` directly. The set
 * of paths a phase creates is the contract of this module — when a new temp
 * file is introduced, extend `PHASE_TEMP_PATHS` here and both the spec and
 * decompose wrappers delete it automatically.
 *
 * Cleanup is best-effort: missing files are fine (`ENOENT` is ignored),
 * unexpected errors are swallowed with a console warning so a failed rm
 * never sinks a successful phase.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './config-resolver.js';

/**
 * Map of phase → temp path templates (relative to the repo root).
 * `{id}` is substituted with the Epic ID at resolution time.
 */
export const PHASE_TEMP_PATHS = Object.freeze({
  spec: Object.freeze([
    'temp/planner-context-epic-{id}.json',
    'temp/prd-epic-{id}.md',
    'temp/techspec-epic-{id}.md',
  ]),
  decompose: Object.freeze([
    'temp/decomposer-context-epic-{id}.json',
    'temp/tickets-epic-{id}.json',
  ]),
});

/**
 * Resolve the concrete paths a phase owns for a given Epic.
 *
 * @param {'spec'|'decompose'} phase
 * @param {number} epicId
 * @param {string} [repoRoot]
 * @returns {string[]} Absolute paths.
 */
export function resolvePhaseTempPaths(phase, epicId, repoRoot = PROJECT_ROOT) {
  const templates = PHASE_TEMP_PATHS[phase];
  if (!templates) {
    throw new Error(
      `[plan-phase-cleanup] Unknown phase "${phase}". Expected one of: ${Object.keys(PHASE_TEMP_PATHS).join(', ')}.`,
    );
  }
  return templates.map((tpl) =>
    path.join(repoRoot, tpl.replace('{id}', String(epicId))),
  );
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
