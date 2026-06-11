/**
 * phases/close-validation.js — run the canonical close-validation gate
 * chain for a standalone Story.
 *
 * The standalone path uses the same `runCloseValidation` chain as
 * Epic-attached Stories so the experience matches — only the baseline
 * ref changes (`main`, not `epic/<id>`).
 *
 * Standalone Stories have no parent Epic, so there's no per-Epic path to
 * scope a `validation-evidence.json` under. Pass `epicId: null` (not `0`)
 * so the `evidenceActive` predicate in `runCloseValidation` short-circuits
 * cleanly. `0` is rejected downstream by `validation-evidence.evidencePath`
 * (which requires a positive integer epicId) and aborts the whole gate
 * chain.
 *
 * The trade-off is that re-runs of close on the same SHA don't hit the
 * evidence cache for standalone Stories; that's acceptable until/unless
 * the standalone path warrants its own evidence keyspace.
 *
 * `runCloseValidation` and `buildDefaultGates` are accepted as injected
 * dependencies so the parent CLI's cache-busted bindings win in tests
 * that mock the upstream module URLs.
 */

import { buildDefaultGates as defaultBuildDefaultGates } from '../../../close-validation/gates.js';
import { runCloseValidation as defaultRunCloseValidation } from '../../../close-validation/runner.js';
import { Logger } from '../../../Logger.js';

/**
 * Run the close-validation gate chain. Throws on first gate failure.
 *
 * Gates are built from the canonical resolved config (`buildDefaultGates`
 * reads `project.commands` and `delivery.quality.gates.crap.enabled`); the
 * `baseBranch` is forwarded as the gate `epicBranch` so the format gate's
 * changed-file scope anchors on it.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   config: object,
 *   baseBranch: string,
 *   storyId: number,
 *   progress: (tag: string, msg: string) => void,
 *   runCloseValidation?: typeof defaultRunCloseValidation,
 *   buildDefaultGates?: typeof defaultBuildDefaultGates,
 * }} args
 */
export async function runCloseValidationPhase({
  cwd,
  worktreePath,
  config,
  baseBranch,
  storyId,
  progress,
  runCloseValidation = defaultRunCloseValidation,
  buildDefaultGates = defaultBuildDefaultGates,
}) {
  progress(
    'VALIDATE',
    `Running close-validation gates against baseline ${baseBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
  const validation = await runCloseValidation({
    cwd,
    worktreePath,
    gates: buildDefaultGates({ config, epicBranch: baseBranch }),
    log: (m) => Logger.info(m),
    storyId,
    epicId: null,
  });
  if (!validation.ok) {
    const [first] = validation.failed;
    const { gate, status, cwd: gateCwd } = first;
    throw new Error(
      `[single-story-close] Gate failed: ${gate.name} (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
        (gate.hint ? ` ${gate.hint}` : ''),
    );
  }
  progress('VALIDATE', '✅ All gates passed.');
}
