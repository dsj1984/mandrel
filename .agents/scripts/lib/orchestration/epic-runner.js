/**
 * EpicRunner — thin coordinator composing a collaborator factory and four
 * sequential phase modules.
 *
 * Public API: `runEpic({ epicId, provider, config, fetchImpl, ... })`
 * or `runEpic({ ctx })` with a pre-built `EpicRunnerContext`.
 *
 * Flow:
 *   1. snapshot       — fetch Epic, snapshot `epic::auto-close`.
 *   2. build-wave-dag — filter child Stories, compute waves.
 *   3. iterate-waves  — flip label, init checkpoint, run wave loop,
 *                       delegate blocker halts.
 *   4. finalize       — flip to review + run bookends (completed) or
 *                       settle blocked column sync (halted).
 */

import { EpicRunnerContext } from './context.js';
import { createEpicRunnerCollaborators } from './epic-runner/factory.js';
import { runBuildWaveDagPhase } from './epic-runner/phases/build-wave-dag.js';
import { runFinalizePhase } from './epic-runner/phases/finalize.js';
import { runIterateWavesPhase } from './epic-runner/phases/iterate-waves.js';
import { runSnapshotPhase } from './epic-runner/phases/snapshot.js';
import { ErrorJournal } from './error-journal.js';

/**
 * Entry point. Accepts either a pre-built `EpicRunnerContext` on `opts.ctx`
 * (preferred) or the legacy flat opts-bag (kept as a one-patch-release compat
 * shim — it is translated to a context internally before anything runs).
 *
 * @param {{
 *   ctx?: EpicRunnerContext,
 *   epicId?: number,
 *   provider?: import('../ITicketingProvider.js').ITicketingProvider,
 *   config?: object,
 *   dispatch?: (args: { stories: Array<{ storyId: number, modelTier?: string, worktree?: string }>, signal?: AbortSignal }) => Promise<Array<{ storyId: number, status: string, detail?: string }>>,
 *   worktreeResolver?: (storyId: number) => string,
 *   fetchImpl?: typeof fetch,
 *   runSkill?: Function,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   errorJournal?: { record: Function, finalize: Function, path: string },
 * }} args
 */
export async function runEpic(args = {}) {
  const ctx =
    args.ctx instanceof EpicRunnerContext
      ? args.ctx
      : new EpicRunnerContext(args);
  return runEpicWithContext(ctx);
}

export async function runEpicWithContext(ctx) {
  const { epicId, errorJournal } = ctx;
  const journal = errorJournal ?? new ErrorJournal({ epicId });
  const collaborators = createEpicRunnerCollaborators(ctx, {
    errorJournal: journal,
  });

  let state = {};
  state = await runSnapshotPhase(ctx, collaborators, state);
  state = await runBuildWaveDagPhase(ctx, collaborators, state);
  state = await runIterateWavesPhase(ctx, collaborators, state);
  return runFinalizePhase(ctx, collaborators, state);
}
