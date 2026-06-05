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
import { emitBlockedCloseResult } from '../merge-runner.js';
import {
  renderSpawnTimeoutFrictionBody,
  resolveSpawnTimeoutDescriptor,
  resolveSpawnTimeoutMs,
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
 *   config?: object,
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
  config,
  provider,
  progress: log,
  reason,
  bus = null,
}) {
  const timeoutMs =
    providedTimeoutMs ?? resolveSpawnTimeoutMs(spawnName, config);

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

  const descriptor = resolveSpawnTimeoutDescriptor(spawnName);
  return emitBlockedCloseResult({
    storyId,
    phase: 'closing',
    reason: reason ?? `${spawnName}-timeout`,
    extra: {
      gateName: spawnName,
      exitCode: exitCode ?? 124,
      timeoutMs,
      commentId,
    },
    bus,
    progress: log,
    blockedMessage: `Story #${storyId} blocked: \`${spawnCmd || descriptor.defaultCmd}\` exceeded ${timeoutMs ?? 'configured'}ms — flipped to ${STATE_LABELS.BLOCKED}.`,
    logger: Logger,
  });
}
