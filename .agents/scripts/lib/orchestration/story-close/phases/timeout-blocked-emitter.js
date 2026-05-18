/**
 * phases/timeout-blocked-emitter.js — side-effecting half of the timeout
 * dispatch phase (Story #2460, Epic #2453 — CLI thinning pilot).
 *
 * Applies the `agent::blocked` transition + the friction comment + the
 * lifecycle-bus emit when one of the close-time bounded-timeout spawns
 * exits 124. All three side-effects are best-effort: a failure here
 * logs and falls through so the close-result envelope reaches the
 * operator regardless.
 *
 * Sibling: `timeout-blocked.js` (pure helpers — the descriptor table,
 * reason-token map, and body renderer). Split out so the side-effects
 * stay isolated and the pure half is trivially testable.
 */

import { Logger } from '../../../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';
import { emitStoryBlockedSafe } from '../merge-runner.js';
import {
  renderSpawnTimeoutFrictionBody,
  resolveSpawnTimeoutDescriptor,
  resolveSpawnTimeoutMs,
  resolveSpawnTimeoutReason,
} from './timeout-blocked.js';

/**
 * Apply the `agent::blocked` transition + friction comment when one of
 * the close-time spawns exits 124.
 *
 * @param {{
 *   storyId: number|string,
 *   epicId?: number|string|null,
 *   spawnName: string,
 *   spawnCmd?: string|null,
 *   timeoutMs?: number|null,
 *   exitCode?: number|null,
 *   agentSettings?: object,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   reason?: string,
 *   bus?: object|null,
 * }} input
 */
export async function emitSpawnTimeoutBlockedResult({
  storyId,
  epicId,
  spawnName,
  spawnCmd = null,
  timeoutMs: providedTimeoutMs = null,
  exitCode = 124,
  agentSettings,
  provider,
  progress: log,
  reason,
  bus = null,
}) {
  const timeoutMs =
    providedTimeoutMs ?? resolveSpawnTimeoutMs(spawnName, agentSettings);

  const body = renderSpawnTimeoutFrictionBody({
    storyId,
    epicId,
    timeoutMs,
    spawnName,
    spawnCmd,
  });

  let commentId = null;
  try {
    const res = await upsertStructuredComment(
      provider,
      storyId,
      'friction',
      body,
    );
    commentId = res?.commentId ?? null;
  } catch (err) {
    Logger.warn?.(
      `[story-close] failed to upsert ${spawnName}-timeout friction comment on #${storyId}: ${err?.message ?? err}`,
    );
  }

  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {
      cascade: false,
    });
  } catch (err) {
    Logger.warn?.(
      `[story-close] failed to transition Story #${storyId} → ${STATE_LABELS.BLOCKED}: ${err?.message ?? err}`,
    );
  }

  await emitStoryBlockedSafe({
    bus,
    storyId,
    reason: resolveSpawnTimeoutReason(spawnName),
    logger: Logger,
  });

  const descriptor = resolveSpawnTimeoutDescriptor(spawnName);
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: reason ?? `${spawnName}-timeout`,
    gateName: spawnName,
    exitCode: exitCode ?? 124,
    timeoutMs,
    commentId,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  log(
    'BLOCKED',
    `Story #${storyId} blocked: \`${spawnCmd || descriptor.defaultCmd}\` exceeded ${timeoutMs ?? 'configured'}ms — flipped to ${STATE_LABELS.BLOCKED}.`,
  );
  return result;
}
