/**
 * BlockerHandler — the single runtime pause point for the epic runner.
 *
 * When an executor reports an unresolvable blocker (or the poller observes
 * `agent::blocked` appear on the Epic), the handler:
 *   1. Flips the Epic to `agent::blocked` (authoritative label).
 *   2. Posts a structured friction comment describing the blocker.
 *   3. Fires the notification hook (fire-and-forget).
 *   4. Halts dispatch of the next wave but lets wave-N in-flight stories
 *      finish naturally.
 *   5. Waits for the Epic label to transition back to `agent::executing`
 *      before returning — the orchestrator then resumes.
 *
 * The wait loop polls via the injected `labelFetcher` so tests drive it
 * without real GitHub IO.
 */

import { AGENT_LABELS } from '../../label-constants.js';
import { pollUntil } from '../../util/poll-loop.js';

const BLOCKED_LABEL = AGENT_LABELS.BLOCKED;
const EXECUTING_LABEL = AGENT_LABELS.EXECUTING;

export class BlockerHandler {
  /**
   * @param {{
   *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
   *   epicId: number,
   *   notificationHook?: { fire: Function },
   *   labelFetcher?: (id: number) => Promise<string[]>,
   *   pollIntervalMs?: number,
   *   logger?: { info: Function, warn: Function, error: Function },
   *   postComment?: (ticketId: number, payload: object) => Promise<unknown>,
   *   errorJournal?: { record: Function, path: string },
   * }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const provider = opts.provider ?? ctx?.provider;
    const epicId = opts.epicId ?? ctx?.epicId;
    if (!provider) throw new TypeError('BlockerHandler requires a provider');
    this.provider = provider;
    this.epicId = epicId;
    this.notificationHook = opts.notificationHook ?? { fire: async () => {} };
    this.labelFetcher =
      opts.labelFetcher ??
      (async (id) => (await provider.getTicket(id)).labels ?? []);
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.logger = opts.logger ?? ctx?.logger ?? console;
    this.postComment =
      opts.postComment ??
      ((ticketId, payload) => provider.postComment(ticketId, payload));
    this.errorJournal = opts.errorJournal ?? ctx?.errorJournal ?? null;
  }

  #journalSuffix() {
    return this.errorJournal?.path ? ` (see ${this.errorJournal.path})` : '';
  }

  /**
   * Halt execution and wait for the operator to unblock.
   *
   * @param {{ reason: string, storyId?: number, detail?: string }} info
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ resumed: boolean, reasonToStop?: string }>}
   */
  async halt(info, signal) {
    await this.#markBlocked(info);
    try {
      const storyPart = info.storyId ? ` (story #${info.storyId})` : '';
      await this.notificationHook.fire({
        text: `[epic-blocked] Epic #${this.epicId}${storyPart}: ${info.reason}`,
      });
    } catch (err) {
      this.logger.warn?.(
        `[BlockerHandler] notification hook failed (swallowed): ${err?.message ?? err}${this.#journalSuffix()}`,
      );
      await this.errorJournal?.record({
        module: 'BlockerHandler',
        op: 'notificationHook.fire',
        error: err,
        recovery: 'swallowed',
      });
    }

    // Wait for operator to flip the label back. The outer orchestrator is
    // responsible for keeping in-flight wave-N stories running while we wait.
    const resumed = await pollUntil({
      fn: () => this.#safeLabels(this.epicId),
      predicate: (labels) =>
        labels.includes(EXECUTING_LABEL) && !labels.includes(BLOCKED_LABEL),
      intervalMs: this.pollIntervalMs,
      signal,
      logger: this.logger,
    });
    if (resumed) {
      this.logger.info?.(
        `[BlockerHandler] Epic #${this.epicId} resumed by operator.`,
      );
      return { resumed: true };
    }
    return { resumed: false, reasonToStop: 'aborted' };
  }

  async #markBlocked({ reason, storyId, detail }) {
    try {
      await this.provider.updateTicket(this.epicId, {
        labels: {
          add: [BLOCKED_LABEL],
          remove: [EXECUTING_LABEL],
        },
      });
    } catch (err) {
      this.logger.warn?.(
        `[BlockerHandler] could not flip Epic label: ${err?.message ?? err}${this.#journalSuffix()}`,
      );
      await this.errorJournal?.record({
        module: 'BlockerHandler',
        op: 'provider.updateTicket(labels)',
        error: err,
        recovery: 'swallowed',
      });
    }

    const body = [
      '### 🚧 Epic blocked',
      `Reason: \`${reason}\``,
      storyId ? `Story: #${storyId}` : null,
      detail ? `\n${detail}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await this.postComment(this.epicId, { type: 'friction', body });
    } catch (err) {
      this.logger.warn?.(
        `[BlockerHandler] friction comment failed: ${err?.message ?? err}${this.#journalSuffix()}`,
      );
      await this.errorJournal?.record({
        module: 'BlockerHandler',
        op: 'postComment(friction)',
        error: err,
        recovery: 'swallowed',
      });
    }
  }

  async #safeLabels(id) {
    try {
      return await this.labelFetcher(id);
    } catch (err) {
      this.logger.warn?.(
        `[BlockerHandler] poll error on #${id}: ${err?.message ?? err}${this.#journalSuffix()}`,
      );
      await this.errorJournal?.record({
        module: 'BlockerHandler',
        op: 'labelFetcher',
        error: err,
        recovery: 'returned-empty',
      });
      return [];
    }
  }
}
