/**
 * phases/pre-gate-steps.js — self-heal steps run on the Story branch before
 * the gates: scoped format-autofix, the upward maintainability baseline
 * write-back, and the context-budget write-back. Each may commit on
 * `story-<id>` (so the gates score it) and none may ever fail the close — an
 * authoritative gate for each runs right after.
 */

import { Logger } from '../../../Logger.js';
import { runBaselineUpwardWriteback as defaultRunBaselineUpwardWriteback } from '../../story-close/baseline-upward-writeback.js';
import { runContextBudgetWriteback as defaultRunContextBudgetWriteback } from '../../story-close/context-budget-writeback.js';
import { runScopedFormatAutofix as defaultRunScopedFormatAutofix } from '../../story-close/format-autofix.js';

/**
 * @param {object} ctx the shared step context (see {@link runPreGateSteps})
 * @returns {void}
 */
function formatAutofixStep({
  cwd,
  worktreePath,
  storyId,
  baseBranch,
  storyBranch,
  config,
  progress,
  runScopedFormatAutofix,
}) {
  progress(
    'FORMAT',
    `Running scoped format-autofix on ${baseBranch}...${storyBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
  const autofix = runScopedFormatAutofix({
    cwd,
    worktreePath,
    storyId,
    baseBranch,
    storyBranch,
    config,
    logger: Logger,
  });
  progress(
    'FORMAT',
    autofix?.committed
      ? `✅ Auto-applied format fix committed as ${autofix.sha} on ${storyBranch}.`
      : `⏭ No format-autofix commit (${autofix?.reason ?? 'clean'}).`,
  );
}

/**
 * Serves both write-backs, which share an input and result shape.
 *
 * @param {object} ctx the shared step context (see {@link runPreGateSteps})
 * @param {{ tag: string, run: Function, describe: (w: object) => string, noun: string }} step
 * @returns {Promise<void>}
 */
async function writebackStep(
  { cwd, worktreePath, storyId, baseBranch, storyBranch, config, progress },
  { tag, run, describe, noun },
) {
  const writeback = await run({
    cwd,
    worktreePath,
    storyId,
    baseBranch,
    storyBranch,
    config,
    logger: Logger,
  });
  progress(
    tag,
    writeback?.committed
      ? `✅ ${describe(writeback)} as ${writeback.sha} on ${storyBranch}.`
      : `⏭ No ${noun} (${writeback?.reason ?? 'nothing to write'}).`,
  );
}

/**
 * Absorbs any throw: these are refresh halves; enforcement runs right after.
 *
 * @param {{ tag: string, label: string, progress: Function, run: () => Promise<void>|void }} opts
 * @returns {Promise<void>}
 */
async function bestEffort({ tag, label, progress, run }) {
  try {
    await run();
  } catch (err) {
    progress(
      tag,
      `⚠️ ${label} failed (close continues; the gate chain is authoritative): ${err?.message ?? err}`,
    );
  }
}

/**
 * Without a `storyBranch` there is nothing to commit onto: skip with a log line.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   storyId: number,
 *   baseBranch: string,
 *   storyBranch?: string,
 *   config: object,
 *   progress: (tag: string, msg: string) => void,
 *   runScopedFormatAutofix?: typeof defaultRunScopedFormatAutofix,
 *   runBaselineUpwardWriteback?: typeof defaultRunBaselineUpwardWriteback,
 *   runContextBudgetWriteback?: typeof defaultRunContextBudgetWriteback,
 * }} args
 * @returns {Promise<void>}
 */
export async function runPreGateSteps({
  runScopedFormatAutofix = defaultRunScopedFormatAutofix,
  runBaselineUpwardWriteback = defaultRunBaselineUpwardWriteback,
  runContextBudgetWriteback = defaultRunContextBudgetWriteback,
  ...ctx
}) {
  const { storyBranch, progress } = ctx;
  if (!storyBranch) {
    progress('FORMAT', '⏭ Skipped scoped format-autofix (no story branch).');
    progress('BASELINE', '⏭ Skipped baseline write-back (no story branch).');
    progress(
      'BUDGET',
      '⏭ Skipped context-budget write-back (no story branch).',
    );
    return;
  }
  await bestEffort({
    tag: 'FORMAT',
    label: 'scoped format-autofix',
    progress,
    run: () => formatAutofixStep({ ...ctx, runScopedFormatAutofix }),
  });
  await bestEffort({
    tag: 'BASELINE',
    label: 'baseline write-back',
    progress,
    run: () =>
      writebackStep(ctx, {
        tag: 'BASELINE',
        run: runBaselineUpwardWriteback,
        noun: 'baseline write-back',
        describe: (w) =>
          `Wrote back ${w.improvedPaths?.length ?? 0} improved maintainability row(s)`,
      }),
  });
  await bestEffort({
    tag: 'BUDGET',
    label: 'context-budget write-back',
    progress,
    run: () =>
      writebackStep(ctx, {
        tag: 'BUDGET',
        run: runContextBudgetWriteback,
        noun: 'context-budget write-back',
        describe: (w) =>
          `Wrote back lower context-budget totals (${w.tiers?.join(', ')})`,
      }),
  });
}
