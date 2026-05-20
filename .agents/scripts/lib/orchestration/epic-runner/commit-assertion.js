/**
 * CommitAssertion — post-wave check that every "done" Story has at least one
 * new commit on `origin/story-<id>` relative to `origin/epic/<epicId>`.
 *
 * Stories that report `done` with zero new commits are reclassified as
 * `failed` with `commit-assertion: zero-delta` before the wave-end structured
 * comment is emitted, so the Epic's telemetry matches reality.
 *
 * The git read is performed by an **injected adapter** so the module is
 * testable without a real repo or subprocess:
 *
 *   async gitAdapter({ epicId, storyId }) => number  // new commit count
 *
 * A default adapter backed by `git rev-list --count` is exported for the
 * runtime wiring site.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { concurrentMap } from '../../util/concurrent-map.js';
import { DEFAULT_CONCURRENCY } from '../concurrency.js';

const execFile = promisify(execFileCb);

export class CommitAssertion {
  /**
   * @param {{
   *   ctx?: { gitAdapter?: Function, logger?: { warn?: Function }, concurrency?: { commitAssertion?: number } },
   *   gitAdapter?: (args: { epicId: number, storyId: number }) => Promise<number>,
   *   logger?: { warn?: Function },
   *   concurrency?: number,
   * }} opts
   */
  constructor(opts = {}) {
    const ctx = opts.ctx;
    const gitAdapter = opts.gitAdapter ?? ctx?.gitAdapter;
    if (typeof gitAdapter !== 'function') {
      throw new TypeError('CommitAssertion requires a gitAdapter function');
    }
    this.gitAdapter = gitAdapter;
    this.logger = opts.logger ?? ctx?.logger ?? console;
    const cap =
      opts.concurrency ??
      ctx?.concurrency?.commitAssertion ??
      DEFAULT_CONCURRENCY.commitAssertion;
    this.concurrency =
      Number.isInteger(cap) && cap >= 1
        ? cap
        : DEFAULT_CONCURRENCY.commitAssertion;
  }

  /**
   * Count new commits on each story branch relative to the epic base.
   *
   * @param {number[]} storyIds
   * @param {{ epicId: number }} opts
   * @returns {Promise<Array<{ storyId: number, newCommitCount: number | null, error?: string }>>}
   */
  async check(storyIds, { epicId } = {}) {
    if (!Number.isInteger(epicId)) {
      throw new TypeError('CommitAssertion.check requires a numeric epicId');
    }
    const ids = Array.isArray(storyIds) ? storyIds : [];
    // concurrentMap preserves input order in the output array, so wave-end
    // row ordering is stable regardless of which git reads resolve first.
    // The mapper catches adapter failures and turns them into per-row error
    // records, so one bad story cannot short-circuit the batch.
    return concurrentMap(
      ids,
      async (raw) => {
        const storyId = Number(raw);
        if (!Number.isInteger(storyId)) {
          return {
            storyId: raw,
            newCommitCount: null,
            error: 'invalid storyId',
          };
        }
        try {
          const count = await this.gitAdapter({ epicId, storyId });
          const n = Number(count);
          return {
            storyId,
            newCommitCount: Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0,
          };
        } catch (err) {
          const msg = err?.message ?? String(err);
          this.logger?.warn?.(
            `[CommitAssertion] git lookup for #${storyId} failed: ${msg}`,
          );
          return { storyId, newCommitCount: null, error: msg };
        }
      },
      { concurrency: this.concurrency },
    );
  }
}

/**
 * Default git adapter — runs `git rev-list --count
 * origin/epic/<epicId>..origin/story-<storyId>` in `cwd` and returns the
 * integer count.
 *
 * If the story branch is missing (story-close deletes both the local
 * and remote story branch after a successful merge — by the time the
 * iterate-waves phase invokes the assertion, `origin/story-<storyId>`
 * is gone),
 * the adapter falls back to counting commits on the epic branch whose
 * message matches `resolves #<storyId>`. A non-zero fallback is treated as
 * proof the story's work landed on the epic branch. A zero-result fallback
 * surfaces the original `unknown revision` error so CommitAssertion.check
 * still records it as a row-level error.
 *
 * @param {{
 *   cwd?: string,
 *   execFileImpl?: typeof execFileCb,
 *   storyBranchPattern?: (storyId: number) => string,
 *   epicBranchPattern?: (epicId: number) => string,
 * }} opts
 */
export function buildDefaultGitAdapter(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const runner = opts.execFileImpl ? promisify(opts.execFileImpl) : execFile;
  const storyBranchPattern =
    opts.storyBranchPattern ?? ((id) => `origin/story-${id}`);
  const epicBranchPattern =
    opts.epicBranchPattern ?? ((id) => `origin/epic/${id}`);

  return async function defaultGitAdapter({ epicId, storyId }) {
    const range = `${epicBranchPattern(epicId)}..${storyBranchPattern(storyId)}`;
    try {
      const { stdout } = await runner('git', ['rev-list', '--count', range], {
        cwd,
        windowsHide: true,
      });
      const n = Number(String(stdout).trim());
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`unexpected rev-list output: "${stdout}"`);
      }
      return Math.trunc(n);
    } catch (err) {
      const count = await countResolvesOnEpic({
        runner,
        cwd,
        epicRef: epicBranchPattern(epicId),
        storyId,
      });
      if (count > 0) return count;
      throw err;
    }
  };
}

async function countResolvesOnEpic({ runner, cwd, epicRef, storyId }) {
  try {
    const { stdout } = await runner(
      'git',
      [
        'log',
        epicRef,
        '-E',
        `--grep=resolves #${storyId}( |\\)|$)`,
        '--format=%H',
      ],
      { cwd, windowsHide: true },
    );
    return String(stdout).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export const COMMIT_ASSERTION_ZERO_DELTA_DETAIL =
  'commit-assertion: zero-delta';
