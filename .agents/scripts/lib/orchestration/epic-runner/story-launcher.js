/**
 * StoryLauncher — produces the per-wave dispatch plan and (optionally)
 * delegates execution to an injected `dispatch` adapter.
 *
 * After Story #908, in-session Agent-tool fan-out replaces the subprocess
 * spawn pipeline. The launcher's primary responsibility is `planWave(stories)`:
 * given a wave's Story tickets it returns a stable list of
 * `{ storyId, worktree }` entries. The `/deliver` skill consumes that
 * list (one wave at a time) to format one assistant turn containing N
 * parallel `Agent` tool calls (subagent_type `general-purpose`), each of
 * which drives `/deliver <storyId>` for one Story.
 *
 * `launchWave(stories)` is a convenience for callers that already hold a
 * concrete dispatch adapter (tests, future programmatic harnesses). It calls
 * `planWave` and forwards the plan to `dispatch({ plan, concurrencyCap, signal })`,
 * returning the adapter's result list. The CLI does not provide a default
 * dispatch adapter — invoking the engine without one is an explicit error.
 */

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export class StoryLauncher {
  /**
   * @param {{
   *   ctx?: { dispatch?: Function, concurrencyCap?: number, worktreeResolver?: (storyId: number) => string, logger?: object },
   *   concurrencyCap?: number,
   *   dispatch?: (args: { plan: Array<{ storyId: number, worktree?: string }>, concurrencyCap: number, signal?: AbortSignal }) => Promise<Array<{ storyId: number, status: string, detail?: string }>>,
   *   worktreeResolver?: (storyId: number) => string,
   *   timeoutMs?: number,
   *   logger?: { info: Function, warn: Function, error: Function }
   * }} opts
   */
  constructor(opts = {}) {
    const ctx = opts?.ctx;
    const dispatch = opts?.dispatch ?? ctx?.dispatch ?? null;
    const concurrencyCap = opts?.concurrencyCap ?? ctx?.concurrencyCap;
    if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
      throw new RangeError('concurrencyCap must be a positive integer');
    }
    this.concurrencyCap = concurrencyCap;
    this.dispatch = dispatch;
    this.worktreeResolver = opts?.worktreeResolver ?? ctx?.worktreeResolver;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts?.logger ?? ctx?.logger ?? console;
  }

  /**
   * Produce the dispatch plan for a wave. Pure: no side effects, no IO. The
   * caller (the `/deliver` skill's wave loop, or `launchWave` below)
   * decides what to do with the plan.
   *
   * @param {Array<number|{id?:number,storyId?:number,number?:number}>} stories
   * @returns {Array<{ storyId: number, worktree?: string }>}
   */
  planWave(stories) {
    return (stories ?? []).map((s) => {
      const storyId =
        typeof s === 'object' && s !== null
          ? (s.id ?? s.storyId ?? s.number)
          : s;
      const id = Number(storyId);
      return {
        storyId: id,
        worktree: this.worktreeResolver?.(id),
      };
    });
  }

  /**
   * Plan + dispatch the wave through the injected adapter. Returns one result
   * entry per input Story preserving input order. Throws when no dispatch
   * adapter was injected — the engine is no longer callable without one.
   *
   * @param {object[]} stories
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{ storyId: number, status: string, detail?: string }>>}
   */
  async launchWave(stories, signal) {
    if (typeof this.dispatch !== 'function') {
      throw new TypeError(
        'StoryLauncher.launchWave requires a dispatch adapter (in-session Agent-tool fan-out is the responsibility of the /deliver skill).',
      );
    }
    const plan = this.planWave(stories);
    if (plan.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`wave timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const onParentAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', onParentAbort, { once: true });
    try {
      const results = await this.dispatch({
        plan,
        concurrencyCap: this.concurrencyCap,
        signal: controller.signal,
      });
      return this.#alignResults(plan, results);
    } catch (err) {
      return plan.map((p) => ({
        storyId: p.storyId,
        status: 'failed',
        detail: err?.message ?? String(err),
      }));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onParentAbort);
    }
  }

  #alignResults(plan, results) {
    const list = Array.isArray(results) ? results : [];
    const byId = new Map(list.map((r) => [Number(r.storyId), r]));
    return plan.map((p) => {
      const r = byId.get(p.storyId);
      if (r) return { storyId: p.storyId, ...r };
      return {
        storyId: p.storyId,
        status: 'failed',
        detail: 'dispatch returned no result for this story',
      };
    });
  }
}
