/**
 * ManualDispatchAdapter — HITL Reference Implementation
 *
 * This is the v5.0.0 reference adapter. It does NOT launch automated agents.
 * Instead, it renders rich dispatch instructions that the human operator reads
 * then executes manually in their agentic IDE (Antigravity, Claude Code, etc.).
 *
 * The adapter maintains an in-memory dispatch registry for the lifetime of one
 * `dispatcher.js` run. Status is tracked locally; there is no persistence.
 * Operators signal completion by re-running `/epic-execute [Epic ID]`.
 *
 * Extending to an automated adapter:
 *   Subclass this and override `dispatchTask()` to launch the agent
 *   programmatically, and `getTaskStatus()` to poll its state.
 *
 * @see docs/v5-implementation-plan.md Sprint 3A — ManualDispatchAdapter
 */

import { randomUUID } from 'node:crypto';
import { IExecutionAdapter } from '../lib/IExecutionAdapter.js';

/** @typedef {'pending'|'executing'|'done'|'failed'|'blocked'} DispatchStatus */

export class ManualDispatchAdapter extends IExecutionAdapter {
  /**
   * @param {object|null} orchestration - The orchestration block from .agentrc.json.
   * @param {object} [opts] - Optional overrides.
   */
  constructor(orchestration, opts = {}) {
    super();
    this.orchestration = orchestration;
    this.opts = opts;

    /**
     * In-memory dispatch registry: dispatchId → dispatch record.
     *
     * NOTE (M-9): This registry is **ephemeral** — it does not persist across
     * process restarts. This is intentional for the Manual adapter: the
     * Dispatcher re-evaluates ticket labels (the durable state) on each
     * re-invocation, so the registry serves only as an intra-process
     * convenience for `getTaskStatus()`. Future automated adapters that need
     * durable dispatch tracking should persist this externally.
     *
     * @type {Map<string, { taskId: number, status: DispatchStatus, dispatchedAt: string, taskDispatch: object }>}
     */
    this._registry = new Map();
  }

  get executorId() {
    return 'manual';
  }

  /**
   * Renders a dispatch instruction block for human execution.
   * Prints a formatted, copy-paste-ready prompt to stdout and registers
   * the dispatch as "pending" in the local registry.
   *
   * @param {Parameters<import('../lib/IExecutionAdapter.js').IExecutionAdapter['dispatchTask']>[0]} taskDispatch
   * @returns {Promise<{ dispatchId: string, status: 'dispatched' }>}
   */
  async dispatchTask(taskDispatch) {
    const dispatchId = randomUUID();
    const { taskId, epicId, branch, persona, mode, cwd } = taskDispatch;

    const cwdPart = cwd ? ` cwd=${cwd}` : '';
    console.log(
      `[manual] dispatch task=#${taskId} epic=#${epicId} branch=${branch} persona=${persona} mode=${mode} id=${dispatchId}${cwdPart}`,
    );

    this._registry.set(dispatchId, {
      taskId,
      status: 'pending',
      dispatchedAt: new Date().toISOString(),
      taskDispatch,
    });

    return { dispatchId, status: 'dispatched' };
  }

  /**
   * Returns the locally tracked status for a dispatchId.
   * For `manual`, all dispatches stay "pending" until the operator signals
   * completion externally (via ticket state). The dispatcher's re-evaluation
   * loop reads ticket labels—not this registry—for actual completion detection.
   *
   * @param {string} dispatchId
   * @returns {Promise<{ dispatchId: string, status: DispatchStatus, message?: string }>}
   */
  async getTaskStatus(dispatchId) {
    const record = this._registry.get(dispatchId);
    if (!record) {
      return {
        dispatchId,
        status: 'failed',
        message: `[ManualDispatchAdapter] Unknown dispatchId: ${dispatchId}`,
      };
    }
    return { dispatchId, status: record.status };
  }

  /**
   * Cancel is a no-op for the manual adapter — the human simply doesn't
   * execute the dispatched prompt.
   *
   * @param {string} dispatchId
   * @returns {Promise<void>}
   */
  async cancelTask(dispatchId) {
    const record = this._registry.get(dispatchId);
    if (record) {
      record.status = 'failed';
    }
  }

  /**
   * Expose the dispatch registry for testing.
   * @returns {Map<string, object>}
   */
  getRegistry() {
    return new Map(this._registry);
  }

  describe() {
    return `[ManualDispatchAdapter] executor=manual (HITL — human executes prompts)`;
  }
}
