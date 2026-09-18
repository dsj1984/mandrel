/**
 * plan-phase-cleanup.js — delete a `/mandrel-plan` phase's run-scoped temp
 * files. `PHASE_TEMP_BASENAMES` is the contract: extend it when a phase adds
 * a temp file. Best-effort — ENOENT is ignored and other errors only warn,
 * so a failed rm never sinks a successful phase.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runArtifactPath } from './config/temp-paths.js';
import { PROJECT_ROOT, resolveConfig } from './config-resolver.js';

/** Phase → artifact basenames; `runArtifactPath` supplies the run dir. */
export const PHASE_TEMP_BASENAMES = Object.freeze({
  spec: Object.freeze([
    'planner-context.json',
    'techspec.md',
    'acceptance-spec.md',
  ]),
  decompose: Object.freeze(['decomposer-context.json', 'tickets.json']),
  // Deleted only at terminal persist success, so a `--force`/`--resume`
  // re-persist can still reuse them. `plan-metrics.json` is deliberately
  // excluded: the ledger must survive to show the whole run.
  persist: Object.freeze([
    'planner-context.json',
    'techspec.md',
    'acceptance-spec.md',
    'decomposer-context.json',
    'tickets.json',
  ]),
});

/**
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
  // Honour `tempRoot` overrides; zero-config callers fall back to defaults.
  let config;
  try {
    config = resolveConfig({ cwd: repoRoot });
  } catch {
    config = undefined;
  }
  return basenames.map((basename) => {
    const rel = runArtifactPath(epicId, basename, config);
    return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  });
}

/**
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
