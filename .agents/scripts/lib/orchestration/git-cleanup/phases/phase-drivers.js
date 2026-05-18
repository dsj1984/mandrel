/**
 * phase-drivers.js — per-phase orchestrators for git-cleanup (Story #2466).
 *
 * Each export drives one of the four cleanup phases (fast-forward-main,
 * prune-remotes, branches, stashes) — wraps the corresponding
 * `plan`/`execute` pair, applies the `--dry-run` / `--yes` semantics,
 * and emits the operator-facing log lines.
 *
 * Split out of `cli.js` so each phase file stays under Story #2466's
 * 200-LOC ceiling.
 *
 * @module lib/orchestration/git-cleanup/phases/phase-drivers
 */

import { Logger } from '../../../Logger.js';
import { executeCleanup, planCleanup } from './branches.js';
import { executeFastForward, planFastForward } from './fast-forward.js';
import { buildGlobFilter } from './filters.js';
import { promptStashDecision, promptYesNo } from './prompts.js';
import { executePrune } from './prune.js';
import {
  renderDryRun,
  renderExecutionLine,
  renderExecutionSummary,
  renderPruneLine,
} from './render.js';
import {
  buildAllowlistDecider,
  executeStashes,
  planStashes,
} from './stashes.js';

const TAG = '[git-cleanup]';

/* node:coverage ignore next */
function emitDryRunHuman(plan, baseBranch) {
  for (const line of renderDryRun(plan, { baseBranch })) Logger.info(line);
}

/* node:coverage ignore next */
function emitExecutionHuman(result) {
  for (const r of result.worktrees) {
    Logger.info(renderExecutionLine(r, 'worktree'));
  }
  for (const r of result.local) Logger.info(renderExecutionLine(r, 'local'));
  for (const r of result.remote) Logger.info(renderExecutionLine(r, 'remote'));
  const pruneLine = renderPruneLine(result.prune);
  if (pruneLine) Logger.info(pruneLine);
  const summary = renderExecutionSummary(result);
  if (result.ok) Logger.info(summary);
  else Logger.error(summary);
}

/* node:coverage ignore next */
export async function runFastForwardPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: fast-forward-main ──`);
  const plan = planFastForward({ cwd, baseBranch });
  if (!plan.runnable) {
    Logger.info(`${TAG} ⏭️  ${baseBranch} skipped: ${plan.reason}`);
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: plan.reason,
      behind: plan.behind ?? 0,
    };
  }
  if (opts.dryRun) {
    Logger.info(
      `${TAG} DRY RUN — would fast-forward ${baseBranch} by ${plan.behind} commit(s)`,
    );
    return {
      ok: true,
      applied: false,
      skipped: true,
      reason: 'dry-run',
      behind: plan.behind,
    };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Fast-forward ${baseBranch} by ${plan.behind} commit(s)?`,
    );
    if (!go) {
      return {
        ok: true,
        applied: false,
        skipped: true,
        reason: 'declined',
        behind: plan.behind,
      };
    }
  }
  return executeFastForward({ cwd, baseBranch, plan });
}

/* node:coverage ignore next */
export async function runPrunePhase(opts, cwd) {
  Logger.info(`${TAG} ── phase: prune-remotes ──`);
  if (opts.dryRun) {
    Logger.info(`${TAG} DRY RUN — would run \`git fetch --prune origin\``);
    return { ok: true, attempted: false, remote: 'origin', pruned: [] };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Run \`git fetch --prune origin\` to drop stale tracking refs?`,
    );
    if (!go) {
      return {
        ok: true,
        attempted: false,
        remote: 'origin',
        pruned: [],
        reason: 'declined',
      };
    }
  }
  return executePrune({ cwd });
}

/* node:coverage ignore next */
export async function runBranchPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: branches ──`);
  const filter = buildGlobFilter({
    include: opts.include,
    exclude: opts.exclude,
  });
  const plan = planCleanup({
    cwd,
    baseBranch,
    filter,
    includeRemoteOnly: opts.remote === true,
  });
  emitDryRunHuman(plan, baseBranch);
  if (opts.dryRun || plan.candidates.length === 0) {
    return { plan, result: null };
  }
  if (!opts.yes) {
    const go = await promptYesNo(
      `${TAG} Reap ${plan.candidates.length} merged branch(es)${opts.remote ? ' (including origin)' : ''}?`,
    );
    if (!go) {
      return { plan, result: null, declined: true };
    }
  }
  const result = executeCleanup({
    candidates: plan.candidates,
    cwd,
    remote: opts.remote,
  });
  emitExecutionHuman(result);
  return { plan, result };
}

/* node:coverage ignore next */
export async function runStashPhase(opts, cwd) {
  Logger.info(`${TAG} ── phase: stashes ──`);
  const { stashes } = planStashes({ cwd });
  if (stashes.length === 0) {
    Logger.info(`${TAG} no stashes to triage`);
    return { ok: true, actions: [], failures: [] };
  }
  for (const s of stashes) {
    Logger.info(`${TAG}   • ${s.ref} (${s.createdAt}) ${s.message}`);
  }
  if (opts.dryRun) {
    Logger.info(
      `${TAG} DRY RUN — ${stashes.length} stash(es) listed; no drops applied`,
    );
    return {
      ok: true,
      actions: stashes.map((s) => ({ ref: s.ref, action: 'keep' })),
      failures: [],
    };
  }
  const decideFn =
    opts.yes || opts.json
      ? buildAllowlistDecider(opts.dropStashes)
      : promptStashDecision;
  return executeStashes({ cwd, stashes, decideFn });
}
