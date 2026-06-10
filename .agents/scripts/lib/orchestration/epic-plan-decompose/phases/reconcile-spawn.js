/**
 * reconcile-spawn.js — helper for `persist.js` (Story #2466).
 *
 * Owns the bridge between the decomposer pipeline and the structural
 * reconciler entry script (`epic-reconcile.js`). Two pieces are split
 * out so `persist.js` stays under Story #2466's 200-LOC ceiling:
 *
 *   - `RECONCILE_CLI` — the canonical path to `epic-reconcile.js` resolved
 *     against the phases-module location (this file lives four levels
 *     below `.agents/scripts/`).
 *   - `spawnReconcilerApply({ spawnSync, reconcileCli, epicId, cwd,
 *     explicitDelete })` — invokes the reconciler in `--apply --yes` mode
 *     (appending `--explicit-delete` when `explicitDelete` is true),
 *     surfaces stdout + stderr to the parent stream, and throws when the
 *     child exits non-zero. Returns the same `{ status, stdout, stderr }`
 *     envelope the legacy in-line invocation produced.
 *
 * Story #3905 — a `--force` re-plan with a changed ticket set produces a
 * plan that carries close ops (the slugs the new plan drops). The
 * reconciler hard-exits 2 on close ops unless `--explicit-delete` is
 * passed. The persist phase therefore threads `--force` through to this
 * helper as `explicitDelete` so a force re-decompose can actually close
 * the dropped children instead of failing after the spec was already
 * overwritten.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/reconcile-spawn
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// phases/ → epic-plan-decompose/ → orchestration/ → lib/ → scripts/ →
// repo-relative `epic-reconcile.js` entry point.
export const RECONCILE_CLI = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'epic-reconcile.js',
);

/**
 * Run `epic-reconcile.js --apply --yes` against `epicId`, surface stdout
 * and stderr to the parent stream, and throw when the child exits
 * non-zero. Returns the `{ status, stdout, stderr }` envelope used by
 * the persist phase's return contract.
 *
 * When `explicitDelete` is true, `--explicit-delete` is appended so a
 * plan carrying close ops (the common shape of a `--force` re-plan that
 * dropped slugs) applies instead of hard-exiting 2 (Story #3905).
 *
 * @param {{ spawnSync: Function, reconcileCli: string, epicId: number, cwd: string, explicitDelete?: boolean }} args
 */
export function spawnReconcilerApply({
  spawnSync,
  reconcileCli,
  epicId,
  cwd,
  explicitDelete = false,
}) {
  const reconcileArgs = [reconcileCli, String(epicId), '--apply', '--yes'];
  if (explicitDelete) reconcileArgs.push('--explicit-delete');
  const reconcileResult = spawnSync(process.execPath, reconcileArgs, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: { ...process.env, EPIC_RECONCILE_INVOKER: 'epic-plan-decompose' },
  });
  const reconcile = {
    status: reconcileResult.status ?? 1,
    stdout: reconcileResult.stdout ?? '',
    stderr: reconcileResult.stderr ?? '',
  };
  if (reconcile.stdout) process.stdout.write(reconcile.stdout);
  if (reconcile.stderr) process.stderr.write(reconcile.stderr);
  if (reconcile.status !== 0) {
    throw new Error(
      `[epic-plan-decompose] epic-reconcile.js exited with status ${reconcile.status}. See stderr above.`,
    );
  }
  return reconcile;
}
