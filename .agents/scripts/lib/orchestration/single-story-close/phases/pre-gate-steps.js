/**
 * phases/pre-gate-steps.js — the self-heal steps the standalone close runs on
 * the Story branch *before* the check-only gate chain scores it.
 *
 * Two steps live here, and they share one contract that is the reason they
 * share a module: each may author a commit on `story-<id>`, each must run
 * ahead of the gates so its commit is part of what the gates score and part of
 * the branch's own PR, and **neither may ever fail the close**. Downstream
 * there is always an authoritative gate — `biome ci` for formatting,
 * `check-baselines` for the ratchet — so a failure here is a missed
 * opportunity to self-heal, never a verdict.
 *
 *   1. **Scoped format-autofix** (Story #4250) — run the formatter over the
 *      `baseBranch...storyBranch` diff and fold any rewrite into a
 *      `fix(story-close):` commit, so benign JSON/YAML drift that lint-staged
 *      does not glob never reaches the check-only format gate.
 *   2. **Upward baseline write-back** (Story #5224) — persist the
 *      maintainability rows this branch improved on files it touched, as a
 *      `baseline-refresh:` commit, so the committed baseline stops falling
 *      behind the tree in the upward direction.
 *   3. **Context-budget write-back** (Story #5313) — persist the lower
 *      documentation-tier totals this branch measured, so a trimmed tier's
 *      gain locks in without `check-context-budget.js` ever going red on it.
 *
 * Extracted from `close-validation.js` when the second step landed. The phase
 * module's job is the gate chain, the evidence keyspace and the gate-log sink;
 * carrying two multi-branch best-effort wrappers inline alongside that was the
 * mass that made it the file it was. Both collaborators stay injectable — the
 * parent CLI's cache-busted bindings must win in tests that mock the upstream
 * module URLs — and are threaded through from the phase unchanged.
 */

import { Logger } from '../../../Logger.js';
import { runBaselineUpwardWriteback as defaultRunBaselineUpwardWriteback } from '../../story-close/baseline-upward-writeback.js';
import { runContextBudgetWriteback as defaultRunContextBudgetWriteback } from '../../story-close/context-budget-writeback.js';
import { runScopedFormatAutofix as defaultRunScopedFormatAutofix } from '../../story-close/format-autofix.js';

/**
 * Run the scoped formatter self-heal.
 *
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
 * Run one of the two baseline write-backs and report it on one progress line.
 *
 * Both steps (Story #5224's maintainability rows, Story #5313's context-budget
 * totals) take the same context and answer in the same shape — `committed`
 * with a `sha`, or a named `reason` — so one wrapper serves both; `describe`
 * renders the committed outcome in the step's own words.
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
 * Run one step, absorbing any throw into a progress line.
 *
 * The absorption is the point, not laziness about error handling: every step
 * here is the *refresh* half of a loop whose *enforcement* half runs
 * immediately afterwards. A step that could abort the close would convert a
 * self-heal opportunity into an outage, and would do it on the path with the
 * least operator attention.
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
 * Run every pre-gate self-heal step for a standalone Story close.
 *
 * Both steps commit to `story-<id>`, so both are skipped — with a log line, not
 * a throw — when the caller has no `storyBranch`. That is the resume/legacy
 * path, which has no branch to commit onto and must not trip an exception for
 * saying so.
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
