#!/usr/bin/env node

/**
 * single-story-confirm-merge.js — confirm a standalone Story's PR merged
 * and flip `agent::closing → agent::done` (closing the issue).
 *
 * Story #3385 — the post-merge half of the standalone close path.
 * `single-story-close.js` rests the Story at `agent::closing` with its
 * GitHub issue OPEN while the PR is open with auto-merge armed. GitHub
 * auto-merge completes *asynchronously* after the close script exits, so
 * the `agent::done` flip (which closes the issue) is deferred to this
 * confirmation step, invoked by the CI-watch loop in
 * `single-story-deliver.md` Step 5 once `pr-watch-with-update.js` exits.
 *
 * The script:
 *   1. Resolves the PR number (`--pr <n>`, or probes
 *      `gh pr list --head story-<id> --state all`).
 *   2. Reads the live PR state via `gh pr view --json state,mergedAt`.
 *   3. When the PR is MERGED → flips `agent::closing → agent::done`
 *      (issue closes via the canonical mutator) and fires the
 *      `story-merged` notify.
 *   4. When the PR is still open / closed-without-merge → leaves the Story
 *      at `agent::closing` and exits cleanly (recoverable; re-run after
 *      the merge lands).
 *
 * Idempotent: re-running on an already-done / already-closed Story
 * short-circuits to a `noop` envelope.
 *
 * Usage:
 *   node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>]
 *                                      [--cwd <main-repo>]
 *
 * Exit codes: 0 ok (merged, pending, or noop), 1 error.
 *
 * @see .agents/workflows/helpers/single-story-deliver.md § Step 5
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gh as defaultGh } from './lib/gh-exec.js';
import { getStoryBranch } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { parsePrNumber } from './lib/orchestration/single-story-close/phases/code-review.js';
import { parseCloseOptions } from './lib/orchestration/single-story-close/phases/options.js';
import { createProvider } from './lib/provider-factory.js';
import { confirmStoryMerged } from './lib/single-story/confirm-merge.js';

const progress = Logger.createProgress('single-story-confirm-merge', {
  stderr: true,
});

/**
 * Read the `--pr <n>` flag from `process.argv` for the direct-CLI path.
 * Injection callers pass `pr` directly and never reach this. Returns the
 * raw string value or `undefined` when the flag is absent.
 *
 * @returns {string|undefined}
 */
function readPrFlag() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { pr: { type: 'string' } },
      strict: false,
    });
    return values.pr;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the PR number for the Story branch when one was not passed on
 * the CLI. Probes `gh pr list --head <branch> --state all` (the merged PR
 * is no longer `open`, so `--state all` is required). Returns `null` when
 * no PR is found.
 *
 * @param {{ cwd: string, storyBranch: string, gh: object }} args
 * @returns {Promise<number|null>}
 */
async function resolvePrNumber({ cwd, storyBranch, gh }) {
  try {
    void cwd;
    const rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['number', 'url'],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (Number.isInteger(row?.number) && row.number > 0) return row.number;
    return parsePrNumber(String(row?.url ?? ''));
  } catch (err) {
    Logger.warn(
      `[single-story-confirm-merge] ⚠️ \`gh pr list\` probe failed: ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Confirm a standalone Story's merge. Exported for testing.
 */
export async function runConfirmMerge({
  storyId: storyIdParam,
  cwd: cwdParam,
  pr: prParam,
  injectedProvider,
  injectedConfig,
  injectedGh,
  injectedNotify,
  injectedReadPrMergeState,
} = {}) {
  const { storyId, cwd } = parseCloseOptions({
    storyIdParam,
    cwdParam,
  });

  if (!storyId) {
    throw new Error(
      'Usage: node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>] [--cwd <main-repo>]',
    );
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);
  const gh = injectedGh ?? defaultGh;
  const storyBranch = getStoryBranch(0, storyId);

  progress('INIT', `Confirming merge for standalone Story #${storyId}...`);

  // Resolve the PR number: explicit injection wins; otherwise read the
  // `--pr` CLI flag; otherwise probe `gh pr list`.
  const rawPr = prParam ?? readPrFlag();
  let prNumber = Number.parseInt(String(rawPr ?? ''), 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    prNumber = await resolvePrNumber({ cwd, storyBranch, gh });
  }

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    progress(
      'CONFIRM',
      `⚠️ No PR found for ${storyBranch}; cannot confirm merge. Story stays at agent::closing.`,
    );
    const result = {
      storyId,
      standalone: true,
      action: 'pending',
      reason: 'no-pr',
      merged: false,
    };
    Logger.info(
      `\n--- CONFIRM MERGE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
    );
    return { success: true, result };
  }

  const confirmation = await confirmStoryMerged({
    provider,
    storyId,
    prNumber,
    prUrl: `${storyBranch} PR #${prNumber}`,
    cwd,
    config,
    progress,
    injectedGh: gh,
    injectedNotify,
    readPrMergeStateFn: injectedReadPrMergeState,
  });

  const result = { standalone: true, prNumber, ...confirmation };
  Logger.info(
    `\n--- CONFIRM MERGE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  if (result.action === 'done') {
    progress('DONE', `✅ Standalone Story #${storyId} → agent::done (merged).`);
  }
  return { success: true, result };
}

runAsCli(import.meta.url, runConfirmMerge, {
  source: 'single-story-confirm-merge',
});
