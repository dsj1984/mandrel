/**
 * phase-drivers.js — per-phase orchestrators for git-cleanup (Story #2466).
 *
 * Each export drives one of the four cleanup phases (fast-forward-main,
 * prune-remotes, branches, stashes) — wraps the corresponding
 * `plan`/`execute` pair, applies the `--dry-run` / `--yes` semantics,
 * and emits the operator-facing log lines.
 *
 * ## Decide / Execute split (Story #2994)
 *
 * `runBranchPhase`, `runFastForwardPhase`, and `runStashPhase` each
 * delegate to a pure `decideXPhase(state)` that returns a plain action
 * record `{ kind, args }`, and an impure `executeXPhase(action, ctx)`
 * that performs I/O. The `runXPhase` sequencer composes the two,
 * inserting the interactive prompt between them when the action's
 * `kind` is `'prompt-then-execute'`. The split keeps the branching
 * logic unit-testable without spinning up git or stdin.
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
  renderDeferredLine,
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
 * Pure: decide what the fast-forward phase should do given the plan.
 *
 * Returns an action record:
 *  - `{ kind: 'skip', result }`               — base branch can't FF
 *  - `{ kind: 'dry-run', result }`            — dry-run mode
 *  - `{ kind: 'prompt-then-execute', promptMessage, declinedResult, executeArgs }`
 *  - `{ kind: 'execute', executeArgs }`       — --yes mode, run immediately
 *
 * @param {object} state
 * @param {object} state.plan        Output of `planFastForward`.
 * @param {object} state.opts        CLI options (`dryRun`, `yes`).
 * @param {string} state.baseBranch  Base branch name.
 * @param {string} state.cwd         Working directory (for execute args).
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

/**
 * Impure: perform the fast-forward action returned by
 * `decideFastForwardPhase`. Returns the phase result.
 */
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
// Prune phase (unchanged — low CRAP, kept for parity)
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
 * Count of a plan's *actionable* candidates — the ones `executeCleanup`
 * will actually delete given the current `--remote` setting. Story #4395
 * always enumerates remote-only candidates in `plan.candidates` (so the
 * operator sees them in the dry-run list), but their deletion still
 * requires `--remote`; without it, `executeCleanup` no-ops on every
 * `localExists: false` candidate. Counting only the actionable subset
 * keeps the "no-candidates" short-circuit and the confirmation prompt's
 * "Reap N" count honest about what will actually happen.
 */
function countActionableCandidates(candidates, remote) {
  return remote
    ? candidates.length
    : candidates.filter((c) => c.localExists !== false).length;
}

/**
 * Pure: decide what the branch-reap phase should do given the plan.
 *
 * Returns an action record:
 *  - `{ kind: 'no-candidates', result }`       — empty plan, nothing to reap
 *  - `{ kind: 'dry-run', result }`             — dry-run mode (plan only)
 *  - `{ kind: 'prompt-then-execute', promptMessage, declinedResult, executeArgs, plan }`
 *  - `{ kind: 'execute', executeArgs, plan }`  — --yes mode
 *
 * @param {object} state
 * @param {object} state.plan         Output of `planCleanup`.
 * @param {object} state.opts         CLI options (`dryRun`, `yes`, `remote`).
 * @param {string} state.cwd          Working directory.
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
  return { kind: 'execute', plan, executeArgs };
}

/**
 * Impure: perform the branch-reap action returned by `decideBranchPhase`.
 * Returns the phase result `{ plan, result, declined? }`.
 */
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
  // Story #4395: always enumerate remote-only merged branches so the
  // dry-run / prompt shows them without requiring `--remote`. Deletion of
  // a remote-only candidate still requires `--remote` — `executeCleanup`
  // no-ops on `localExists: false` candidates otherwise (unchanged).
  const plan = planCleanup({
    cwd,
    baseBranch,
    filter,
    includeRemoteOnly: true,
  });
  emitDryRunHuman(plan, baseBranch);
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
 * Pure: decide what the stash-triage phase should do given the plan.
 *
 * Returns an action record:
 *  - `{ kind: 'no-stashes', result }`        — nothing to triage
 *  - `{ kind: 'dry-run', result, stashes }`  — dry-run mode
 *  - `{ kind: 'execute-allowlist', executeArgs }` — --yes / --json mode
 *  - `{ kind: 'execute-interactive', executeArgs }` — interactive prompt
 *
 * @param {object} state
 * @param {Array}  state.stashes  Output of `planStashes().stashes`.
 * @param {object} state.opts     CLI options (`dryRun`, `yes`, `json`,
 *                                `dropStashes`).
 * @param {string} state.cwd     Working directory.
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

/**
 * Impure: perform the stash-triage action returned by `decideStashPhase`.
 * Returns the phase result.
 */
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
  }
  const action = decideStashPhase({ stashes, opts, cwd });
  return executeStashPhase(action);
}
