/**
 * Per-phase drivers for git-cleanup. Each `runXPhase` composes a pure
 * `decideXPhase` (returns an action record) with an impure `executeXPhase`,
 * prompting in between for `prompt-then-execute`.
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
  renderCandidateList,
  renderDeferredLine,
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
function emitCandidateList(plan, opts, baseBranch) {
  for (const l of renderCandidateList({ plan, opts, baseBranch }))
    Logger.info(l);
}

/* node:coverage ignore next */
function emitExecutionHuman(result) {
  for (const r of result.worktrees) {
    Logger.info(renderExecutionLine(r, 'worktree'));
  }
  for (const r of result.local) Logger.info(renderExecutionLine(r, 'local'));
  for (const r of result.remote) Logger.info(renderExecutionLine(r, 'remote'));
  for (const d of result.deferred ?? []) {
    Logger.warn(renderDeferredLine(d));
  }
  const pruneLine = renderPruneLine(result.prune);
  if (pruneLine) Logger.info(pruneLine);
  const summary = renderExecutionSummary(result);
  if (result.ok) Logger.info(summary);
  else Logger.error(summary);
}

// =====================================================================
// Fast-forward phase
// =====================================================================

/**
 * @param {object} state
 * @param {object} state.plan
 * @param {object} state.opts
 * @param {string} state.baseBranch
 * @param {string} state.cwd
 */
export function decideFastForwardPhase(state) {
  const { plan, opts, baseBranch, cwd } = state;
  if (!plan.runnable) {
    return {
      kind: 'skip',
      result: {
        ok: true,
        applied: false,
        skipped: true,
        reason: plan.reason,
        behind: plan.behind ?? 0,
      },
      logMessage: `${TAG} ⏭️  ${baseBranch} skipped: ${plan.reason}`,
    };
  }
  if (opts.dryRun) {
    return {
      kind: 'dry-run',
      result: {
        ok: true,
        applied: false,
        skipped: true,
        reason: 'dry-run',
        behind: plan.behind,
      },
      logMessage: `${TAG} DRY RUN — would fast-forward ${baseBranch} by ${plan.behind} commit(s)`,
    };
  }
  const executeArgs = { cwd, baseBranch, plan };
  if (!opts.yes) {
    return {
      kind: 'prompt-then-execute',
      promptMessage: `${TAG} Fast-forward ${baseBranch} by ${plan.behind} commit(s)?`,
      declinedResult: {
        ok: true,
        applied: false,
        skipped: true,
        reason: 'declined',
        behind: plan.behind,
      },
      executeArgs,
    };
  }
  return { kind: 'execute', executeArgs };
}

export async function executeFastForwardPhase(action) {
  if (action.kind === 'skip' || action.kind === 'dry-run') {
    if (action.logMessage) Logger.info(action.logMessage);
    return action.result;
  }
  if (action.kind === 'execute') {
    return executeFastForward(action.executeArgs);
  }
  throw new Error(
    `executeFastForwardPhase: unsupported action kind '${action.kind}'`,
  );
}

/* node:coverage ignore next */
export async function runFastForwardPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: fast-forward-main ──`);
  const plan = planFastForward({ cwd, baseBranch });
  const action = decideFastForwardPhase({ plan, opts, baseBranch, cwd });
  if (action.kind === 'prompt-then-execute') {
    if (action.logMessage) Logger.info(action.logMessage);
    const go = await promptYesNo(action.promptMessage);
    if (!go) return action.declinedResult;
    return executeFastForward(action.executeArgs);
  }
  return executeFastForwardPhase(action);
}

// =====================================================================
// Prune phase
// =====================================================================

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

// =====================================================================
// Branch phase
// =====================================================================

/**
 * Remote-only candidates are listed but only deleted under `--remote`, so
 * count just what will actually be reaped.
 */
function countActionableCandidates(candidates, remote) {
  return remote
    ? candidates.length
    : candidates.filter((c) => c.localExists !== false).length;
}

/**
 * @param {object} state
 * @param {object} state.plan
 * @param {object} state.opts
 * @param {string} state.cwd
 */
export function decideBranchPhase(state) {
  const { plan, opts, cwd } = state;
  if (opts.dryRun) {
    return { kind: 'dry-run', plan, result: { plan, result: null } };
  }
  const actionableCount = countActionableCandidates(
    plan.candidates,
    opts.remote,
  );
  if (actionableCount === 0) {
    return { kind: 'no-candidates', plan, result: { plan, result: null } };
  }
  const executeArgs = {
    candidates: plan.candidates,
    cwd,
    remote: opts.remote,
  };
  if (!opts.yes) {
    const contentMergedCount = plan.candidates.filter(
      (c) => c.detectedBy === 'content-merged',
    ).length;
    const weakSignalNote =
      contentMergedCount > 0
        ? ` (${contentMergedCount} content-merged — weaker signal, verify before confirming)`
        : '';
    return {
      kind: 'prompt-then-execute',
      plan,
      promptMessage: `${TAG} Reap ${actionableCount} merged branch(es)${opts.remote ? ' (including origin)' : ''}${weakSignalNote}?`,
      declinedResult: { plan, result: null, declined: true },
      executeArgs,
    };
  }
  // Unattended: nobody saw the weak-signal note, so content-merged remote
  // refs are withheld unless `--include-content-merged`.
  return {
    kind: 'execute',
    plan,
    executeArgs: {
      ...executeArgs,
      skipWeakSignal: opts.includeContentMerged !== true,
    },
  };
}

export async function executeBranchPhase(action) {
  if (action.kind === 'dry-run' || action.kind === 'no-candidates') {
    return action.result;
  }
  if (action.kind === 'execute') {
    const result = executeCleanup(action.executeArgs);
    emitExecutionHuman(result);
    return { plan: action.plan, result };
  }
  throw new Error(
    `executeBranchPhase: unsupported action kind '${action.kind}'`,
  );
}

/* node:coverage ignore next */
export async function runBranchPhase(opts, cwd, baseBranch) {
  Logger.info(`${TAG} ── phase: branches ──`);
  const filter = buildGlobFilter({
    include: opts.include,
    exclude: opts.exclude,
  });
  // Always list remote-only candidates; deleting them still needs `--remote`.
  const plan = planCleanup({
    cwd,
    baseBranch,
    filter,
    includeRemoteOnly: true,
  });
  emitCandidateList(plan, opts, baseBranch);
  const action = decideBranchPhase({ plan, opts, cwd });
  if (action.kind === 'prompt-then-execute') {
    const go = await promptYesNo(action.promptMessage);
    if (!go) return action.declinedResult;
    const result = executeCleanup(action.executeArgs);
    emitExecutionHuman(result);
    return { plan, result };
  }
  return executeBranchPhase(action);
}

// =====================================================================
// Stash phase
// =====================================================================

/**
 * @param {object} state
 * @param {Array}  state.stashes
 * @param {object} state.opts
 * @param {string} state.cwd
 */
export function decideStashPhase(state) {
  const { stashes, opts, cwd } = state;
  if (stashes.length === 0) {
    return {
      kind: 'no-stashes',
      result: { ok: true, actions: [], failures: [] },
    };
  }
  if (opts.dryRun) {
    return {
      kind: 'dry-run',
      stashes,
      result: {
        ok: true,
        actions: stashes.map((s) => ({ ref: s.ref, action: 'keep' })),
        failures: [],
      },
    };
  }
  if (opts.yes || opts.json) {
    return {
      kind: 'execute-allowlist',
      executeArgs: { cwd, stashes, allowlist: opts.dropStashes },
    };
  }
  return {
    kind: 'execute-interactive',
    executeArgs: { cwd, stashes },
  };
}

export async function executeStashPhase(action) {
  if (action.kind === 'no-stashes' || action.kind === 'dry-run') {
    return action.result;
  }
  if (action.kind === 'execute-allowlist') {
    const { cwd, stashes, allowlist } = action.executeArgs;
    const decideFn = buildAllowlistDecider(allowlist);
    return executeStashes({ cwd, stashes, decideFn });
  }
  if (action.kind === 'execute-interactive') {
    const { cwd, stashes } = action.executeArgs;
    return executeStashes({ cwd, stashes, decideFn: promptStashDecision });
  }
  throw new Error(
    `executeStashPhase: unsupported action kind '${action.kind}'`,
  );
}

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
  }
  const action = decideStashPhase({ stashes, opts, cwd });
  return executeStashPhase(action);
}
