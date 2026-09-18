/**
 * phases/lock-wait-pending.js — a close whose full-suite lock wait expired
 * ends `pending`, not `failed`: nothing was spawned, pushed or labelled, so
 * the next command is the same close.
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
