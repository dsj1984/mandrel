/**
 * phases/lock-wait-pending.js — the ending of a close whose full-suite lock
 * wait expired (Story #5377).
 *
 * `pending`, not `failed`: nothing is wrong with the Story — another suite
 * held the host for longer than this close's wait budget, and the gate chain
 * deferred rather than run a second suite beside it. Nothing was spawned,
 * pushed or labelled, and the claim is kept, so the one next command is the
 * same close again.
 */
import {
  buildTerminalEnvelope,
  NEXT_COMMANDS,
} from '../../story-deliver-terminal.js';

/**
 * @param {{
 *   storyId: number,
 *   storyBranch: string,
 *   baseBranch: string,
 *   lockWait: { waitedSeconds: number, expired: boolean }|null,
 *   elapsedSeconds: number,
 * }} args
 * @returns {{ result: object, terminal: object, note: string }} The close
 *   result, the validated `pending` envelope, and the operator line.
 */
export function lockWaitPending({
  storyId,
  storyBranch,
  baseBranch,
  lockWait,
  elapsedSeconds,
}) {
  const nextCommand = NEXT_COMMANDS.close(storyId);
  return {
    result: {
      storyId,
      standalone: true,
      action: 'deferred',
      reason: 'full-suite-lock-wait-expired',
    },
    terminal: buildTerminalEnvelope({
      storyId,
      status: 'pending',
      phase: 'close-validation',
      storyBranch,
      baseBranch,
      lockWait,
      nextCommand,
      elapsedSeconds,
    }),
    note: `⏸  Story #${storyId}: another full suite held the host lock past the wait budget — resume with: ${nextCommand}`,
  };
}
