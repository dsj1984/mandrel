import { Logger } from '../../../Logger.js';
import { discardHeldReview, startHeldReview } from '../review-overlap.js';
import { runBaseSyncPhase } from './base-sync.js';
import { runCloseValidationPhase } from './close-validation.js';
import { runWrongTreeGuardPhase } from './wrong-tree-guard.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * wrong-tree guard → base-sync → close-validation. Validation runs last so
 * the validated tree is the pushed tree (base-sync's merge commit included),
 * and a cheap conflict is found before the expensive gates.
 *
 * @param {object} ctx
 * @param {object} deps
 * @returns {Promise<{
 *   validationGates: Record<string, string>|null,
 *   lockWait: { waitedSeconds: number, expired: boolean }|null,
 *   suiteTimings: object|null,
 *   pending: boolean,
 * }>} `validationGates` is null when skipped; `pending` means a full-suite
 *   lock wait expired and the gates deferred.
 */
export async function runPrePushPhases(ctx, deps) {
  const { options, worktreePath, baseBranch, storyBranch, storyId, setPhase } =
    ctx;
  const { cwd } = options;
  setPhase('wrong-tree-guard');
  await runWrongTreeGuardPhase({
    cwd,
    worktreePath,
    baseBranch,
    storyId,
    provider: deps.provider,
    progress,
    gitSpawn: deps.gitSpawn,
  });
  if (!options.skipSync) {
    setPhase('base-sync');
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      baseConfirmed: ctx.baseConfirmed,
      storyBranch,
      storyId,
      provider: deps.provider,
      injectedSync: deps.sync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }
  if (options.skipValidation) {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
    return {
      validationGates: null,
      lockWait: null,
      suiteTimings: null,
      pending: false,
    };
  }
  setPhase('close-validation');
  let validation;
  try {
    validation = await runCloseValidationPhase({
      cwd,
      worktreePath,
      config: deps.config,
      baseBranch,
      storyBranch,
      storyId,
      progress,
      runCloseValidation: deps.runCloseValidation,
      buildDefaultGates: deps.buildDefaultGates,
      onPreGateStepsDone: () => {
        ctx.heldReview = startHeldReview({
          cwd,
          storyId,
          storyBranch,
          baseBranch,
          provider: deps.provider,
          runCodeReviewFn: deps.runCodeReview,
          gitSpawnFn: deps.git.gitSpawn,
          progress,
          config: deps.config,
        });
      },
    });
  } catch (err) {
    discardHeldReview(ctx.heldReview, 'validation failed', progress);
    // The gate that died is all this run observed; the envelope claims no more.
    if (typeof err?.closeGate === 'string') {
      ctx.setObservedGates({ [err.closeGate]: 'failed' });
    }
    throw err;
  }
  const gates = validation?.gates ?? null;
  ctx.setObservedGates(gates);
  return {
    validationGates: gates,
    lockWait: validation?.lockWait ?? null,
    suiteTimings: validation?.suiteTimings ?? null,
    pending: validation?.pending === true,
  };
}
