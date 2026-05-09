#!/usr/bin/env node

/**
 * .agents/scripts/epic-close.js — Final Epic Lifecycle Closure
 *
 * The operator-facing `/epic-close` workflow runs eight named phases.
 * This script owns Finalize (Phase 7) and Notify (Phase 8) end-to-end and
 * exposes the earlier phases as dedicated sister scripts
 * (`wave-gate.js`, `hierarchy-gate.js`,
 * `validate-docs-freshness.js`, `epic-code-review.js`) that the workflow
 * invokes before the merge.
 *
 * Finalize (Phase 7):
 *   1. Close auxiliary tickets (PRD, Tech Spec).
 *   2. Close the Epic issue with a notification comment.
 *   3. Reap stale worktrees and delete local + remote Epic/Story branches.
 *
 * Notify (Phase 8):
 *   4. Emit the terminal banner (success or warning summary) and honour
 *      `--skip-retro` / `--skip-code-review` / `--full-retro` by logging
 *      the override so the operator has an audit trail.
 *
 * The merge-to-main and version bump (Phase 5) remain high-visibility
 * manual steps in the workflow; this script is deliberately agnostic about
 * them so a failed release never corrupts the Epic closure state.
 *
 * `--full-retro` is an advisory flag: epic-close.js does not compose the
 * retro itself (the retro helper does that, invoked from `/epic-close`
 * Phase 6). The flag is logged here so the operator sees the override in
 * the close audit trail, and the `/epic-close` workflow is responsible
 * for propagating it into the retro helper invocation so the compact-retro
 * heuristic is bypassed.
 *
 * Usage:
 *   node .agents/scripts/epic-close.js --epic <EPIC_ID>
 *     [--no-cleanup] [--skip-retro] [--skip-code-review] [--full-retro]
 *     [--no-reap-discard-after-merge]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { deleteBranchesBatched } from './lib/git-branch-cleanup.js';
import * as gitUtils from './lib/git-utils.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { toDone } from './lib/orchestration/label-transitions.js';
import { postStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';
import { forceDrainPendingCleanup } from './lib/worktree/lifecycle/force-drain.js';
import { WorktreeManager } from './lib/worktree-manager.js';

const progress = Logger.createProgress('epic-close', { stderr: false });

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      cleanup: { type: 'boolean', default: true },
      'skip-retro': { type: 'boolean', default: false },
      'skip-code-review': { type: 'boolean', default: false },
      'full-retro': { type: 'boolean', default: false },
      'no-reap-discard-after-merge': { type: 'boolean', default: false },
    },
    strict: false,
  });

  const epicId = Number.parseInt(values.epic ?? '', 10);

  if (Number.isNaN(epicId) || epicId <= 0) {
    Logger.fatal('Usage: node epic-close.js --epic <EPIC_ID>');
  }

  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);

  progress('INIT', `Starting formal closure for Epic #${epicId}...`);

  logSkipOverrides({
    skipRetro: values['skip-retro'] === true,
    skipCodeReview: values['skip-code-review'] === true,
    fullRetro: values['full-retro'] === true,
  });

  const warnings = [];

  // Phase 6.0 — Epic Perf Report --------------------------------------------
  // Run the analyzer in Epic mode so the `<!-- ap:structured-comment
  // type="epic-perf-report" -->` comment lands on the Epic ticket before
  // the retro composer (which runs from the workflow side, not this
  // script) reads it. Best-effort per Story #1123 — a non-zero exit is
  // logged as a warning and never blocks close. Skipped when the operator
  // passed `--skip-retro` (the perf-report exists for the retro; if the
  // operator opted out of the retro, posting it is wasted work).
  if (values['skip-retro'] !== true) {
    phasePostEpicPerfReport(epicId, warnings);
  } else {
    progress('PERF', '⏭️ Skipping epic-perf-report (--skip-retro)');
  }

  // Finalize phase ----------------------------------------------------------
  await phaseFinalizeAuxiliaryTickets(provider, epicId, warnings);
  await phaseFinalizeEpicClosure(provider, epicId, warnings);
  if (values.cleanup) {
    await phaseFinalizeBranchCleanup(
      provider,
      orchestration,
      epicId,
      warnings,
      {
        discardAfterMerge: values['no-reap-discard-after-merge'] !== true,
      },
    );
  }

  // Notify phase ------------------------------------------------------------
  phaseNotifyBanner(epicId, warnings);
}

/**
 * Record `--skip-*` / `--full-retro` overrides so the audit trail shows why
 * a pre-close gate was bypassed or which retro shape the operator forced.
 * Logging is intentionally best-effort — the flags never halt close, they
 * only narrate what the operator chose. `skipRetro` and `fullRetro` are
 * mutually meaningful only when passed together (skip wins); if both are
 * set, both lines log so the intent is visible.
 */
function logSkipOverrides({ skipRetro, skipCodeReview, fullRetro }) {
  if (skipCodeReview) {
    progress(
      'REVIEW',
      '⚠️ code review skipped by operator override (--skip-code-review)',
    );
  }
  if (skipRetro) {
    progress('NOTIFY', '⚠️ retro skipped by operator override (--skip-retro)');
  }
  if (fullRetro) {
    progress(
      'NOTIFY',
      'ℹ️ full retro forced by operator override (--full-retro) — compact-retro heuristic bypassed',
    );
  }
}

/**
 * Close `context::prd` and `context::tech-spec` tickets that belong to the
 * Epic. Per-ticket failures are isolated so a misbehaving auxiliary ticket
 * never discards progress on its siblings.
 */
export async function phaseFinalizeAuxiliaryTickets(
  provider,
  epicId,
  warnings,
) {
  try {
    progress('CONTEXT', 'Searching for PRD and Tech Spec tickets...');
    const subTickets = await provider.getSubTickets(epicId);

    const auxiliaryTickets = subTickets.filter(
      (t) =>
        t.labels.includes('context::prd') ||
        t.labels.includes('context::tech-spec'),
    );

    if (auxiliaryTickets.length === 0) {
      progress('CONTEXT', 'No open PRD / Tech Spec tickets found.');
      return;
    }

    // Bound the auxiliary-ticket close burst at 3 so a wide PRD / Tech Spec
    // fan-out at Epic close does not race the GitHub secondary rate limit.
    // Per-item failures still land in `warnings[]` — concurrentMap only
    // short-circuits on a thrown rejection, and the catch-block above
    // swallows individual failures into warnings.
    await concurrentMap(
      auxiliaryTickets,
      async (ticket) => {
        if (ticket.state === 'closed') return;

        const kind =
          ticket.labels.find((l) => l.startsWith('context::')) ?? 'auxiliary';

        progress('CONTEXT', `Closing ${kind} #${ticket.id}...`);
        try {
          await toDone(provider, [ticket.id]);
          progress('CONTEXT', `✅ #${ticket.id} closed.`);
        } catch (err) {
          warnings.push(
            `auxiliary ticket #${ticket.id} (${kind}): ${err.message}`,
          );
          Logger.warn(
            `⚠️ Warning: Failed to close ${kind} #${ticket.id}: ${err.message}`,
          );
        }
      },
      { concurrency: 3 },
    );
  } catch (err) {
    warnings.push(`auxiliary ticket enumeration: ${err.message}`);
    Logger.warn(`⚠️ Warning: Failed to fetch auxiliary tickets: ${err.message}`);
  }
}

/**
 * Post the shipping notification comment on the Epic, then close it. An
 * Epic-close failure is recorded as a warning so downstream exit-code
 * handling can reflect partial success instead of silently announcing 🎉.
 */
async function phaseFinalizeEpicClosure(provider, epicId, warnings) {
  try {
    progress('EPIC', `Closing Epic #${epicId}...`);

    const epic = await provider.getTicket(epicId);
    if (epic.state !== 'closed') {
      await postStructuredComment(
        provider,
        epicId,
        'notification',
        `🎉 Epic #${epicId} has been successfully shipped. All tasks merged to main and context tickets closed.`,
      );

      await provider.updateTicket(epicId, {
        state: 'closed',
        state_reason: 'completed',
      });
      progress('EPIC', `✅ Epic #${epicId} closed.`);
    } else {
      progress('EPIC', `Epic #${epicId} is already closed.`);
    }
  } catch (err) {
    warnings.push(`epic #${epicId} close: ${err.message}`);
    Logger.error(`❌ Error: Failed to close Epic #${epicId}: ${err.message}`);
  }
}

/**
 * Predicate: does `branchName` belong to the Epic identified by the
 * legacy patterns + the resolved descendant ID set? Two acceptance
 * paths:
 *   1. Legacy pre-v5.29 namespaced patterns (`story/epic-<id>/...`,
 *      `task/epic-<id>/...`) — matched by substring.
 *   2. Modern `story-<numericId>` names where the numeric id is in the
 *      authoritative descendant set returned by `getSubTickets`.
 *
 * Module-level (was an inner closure inside phaseFinalizeBranchCleanup)
 * so the orchestrator's CRAP score reflects only its own branching and
 * so the predicate is independently testable.
 */
export function matchesEpicBranch(
  branchName,
  { storyLegacyPattern, taskLegacyPattern, validTicketIds },
) {
  if (
    branchName.includes(storyLegacyPattern) ||
    branchName.includes(taskLegacyPattern)
  ) {
    return true;
  }
  const match = branchName.match(/^story-(\d+)$/);
  if (match && validTicketIds.has(Number.parseInt(match[1], 10))) {
    return true;
  }
  return false;
}

function makeWorktreeLogger(logger) {
  return {
    info: (m) => logger('WORKTREE', m),
    warn: (m) => logger('WORKTREE', `⚠️ ${m}`),
    error: (m) => Logger.error(`[epic-close] ${m}`),
  };
}

function applyDrainResult(drainResult, logger, warnings) {
  if (drainResult.drained.length > 0) {
    logger(
      'CLEANUP',
      `Drained ${drainResult.drained.length} pending-cleanup entry(ies): ${drainResult.drained.map((id) => `story-${id}`).join(', ')}`,
    );
  }
  if (drainResult.escalated.length > 0) {
    logger(
      'CLEANUP',
      `Escalation killed holders for: ${drainResult.escalated.map((id) => `story-${id}`).join(', ')}`,
    );
  }
  if (drainResult.persistent.length > 0) {
    warnings.push(
      `pending-cleanup persistent-lock: ${drainResult.persistent.map((id) => `story-${id}`).join(', ')}`,
    );
  }
}

async function applyGcResult(gcResult, provider, logger, warnings) {
  if (gcResult.reaped.length > 0) {
    logger('CLEANUP', `Reaped ${gcResult.reaped.length} worktree(s).`);
    await emitDiscardFrictionComments(provider, gcResult.reaped, warnings);
  }
  if (gcResult.skipped.length > 0) {
    logger(
      'CLEANUP',
      `⚠️ ${gcResult.skipped.length} worktree(s) could not be reaped (dirty/unmerged):`,
    );
    for (const s of gcResult.skipped) {
      logger('CLEANUP', `   - story-${s.storyId}: ${s.reason}`);
    }
  }
}

async function drainAndReapWorktrees(
  wm,
  provider,
  wtConfig,
  epicId,
  opts,
  { logger, projectRoot, warnings },
) {
  const worktreeRoot = path.resolve(projectRoot, wtConfig.root ?? '.worktrees');
  logger('CLEANUP', 'Draining pending-cleanup manifest (with escalation)...');
  const drainResult = await forceDrainPendingCleanup({
    repoRoot: projectRoot,
    worktreeRoot,
    git: gitUtils,
    logger: makeWorktreeLogger(logger),
  });
  applyDrainResult(drainResult, logger, warnings);

  logger('CLEANUP', 'Reaping stale worktrees...');
  await wm.sweepStaleLocks();
  const gcResult = await wm.gc([], {
    epicBranch: `epic/${epicId}`,
    discardAfterMerge: opts.discardAfterMerge !== false,
  });
  await applyGcResult(gcResult, provider, logger, warnings);
}

function pruneWorktreeRegistrations(wm, logger) {
  logger('CLEANUP', 'Pruning stale worktree registrations...');
  const pruneResult = wm.prune();
  if (!pruneResult.pruned) {
    Logger.warn(
      `⚠️ Warning: git worktree prune failed (non-fatal): ${pruneResult.reason}`,
    );
    return;
  }
  logger('CLEANUP', '✅ Worktree registrations pruned.');
}

/**
 * Reap stale worktrees and prune dangling worktree registrations. The
 * pending-cleanup ledger is force-drained first so EBUSY survivors from
 * earlier story-closes don't pin worktrees across sprints. Pruning runs
 * unconditionally — even with `worktreeIsolation` disabled, stale
 * entries in `.git/worktrees/` can block subsequent branch deletes.
 *
 * @param {object} provider
 * @param {object} orchestration
 * @param {number} epicId
 * @param {{ discardAfterMerge?: boolean }} opts
 * @param {{ logger?: typeof progress, projectRoot?: string }} [deps]
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function phaseReapWorktrees(
  provider,
  orchestration,
  epicId,
  opts = {},
  deps = {},
) {
  const logger = deps.logger ?? progress;
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const warnings = [];
  const wtConfig = orchestration?.worktreeIsolation;
  const wm = new WorktreeManager({
    repoRoot: projectRoot,
    config: wtConfig,
    logger: makeWorktreeLogger(logger),
  });

  if (wtConfig?.enabled) {
    try {
      await drainAndReapWorktrees(wm, provider, wtConfig, epicId, opts, {
        logger,
        projectRoot,
        warnings,
      });
    } catch (err) {
      Logger.warn(
        `⚠️ Warning: Worktree cleanup failed (non-fatal): ${err.message}`,
      );
    }
  }

  pruneWorktreeRegistrations(wm, logger);
  return { warnings };
}

/**
 * Resolve the Epic's descendant ticket IDs and enumerate every local
 * and remote branch that should be deleted. Descendant-enumeration
 * failures are recorded as a warning and degrade gracefully — the
 * Epic branch and legacy `story/*` / `task/*` patterns still get
 * matched, but `story-<id>` branches are skipped to avoid accidentally
 * deleting live work whose parent is no longer reachable.
 *
 * @param {object} provider
 * @param {number} epicId
 * @param {{ logger?: typeof progress, projectRoot?: string }} [deps]
 * @returns {Promise<{
 *   warnings: string[],
 *   epicBranch: string,
 *   remoteToDelete: string[],
 *   localToDelete: string[],
 * }>}
 */
export async function phaseEnumerateEpicBranches(provider, epicId, deps = {}) {
  const logger = deps.logger ?? progress;
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const warnings = [];

  const epicBranch = `epic/${epicId}`;
  const storyLegacyPattern = `story/epic-${epicId}/`;
  const taskLegacyPattern = `task/epic-${epicId}/`;

  let validTicketIds = new Set();
  try {
    const descendantIds = await collectEpicDescendantIds(provider, epicId);
    validTicketIds = new Set(descendantIds);
    logger(
      'CLEANUP',
      `Resolved ${validTicketIds.size} descendant ticket ID(s) for branch matching.`,
    );
  } catch (err) {
    warnings.push(`descendant enumeration: ${err.message}`);
    Logger.warn(
      `⚠️ Warning: Could not enumerate Epic descendants (${err.message}). ` +
        `story-<id> branch deletion will be skipped to avoid accidentally keeping live work. ` +
        `Legacy story/*, task/* patterns will still be matched.`,
    );
  }

  const ctx = { storyLegacyPattern, taskLegacyPattern, validTicketIds };
  const remoteBranches = gitSpawn(projectRoot, 'branch', '-r').stdout ?? '';
  const remoteToDelete = [
    epicBranch,
    ...remoteBranches
      .split('\n')
      .map((line) => line.trim().replace('origin/', ''))
      .filter((b) => b && matchesEpicBranch(b, ctx)),
  ];

  const localBranches = gitSpawn(projectRoot, 'branch').stdout ?? '';
  const localToDelete = [
    epicBranch,
    ...localBranches
      .split('\n')
      .map((line) => line.trim().replace('* ', ''))
      .filter((b) => b && matchesEpicBranch(b, ctx)),
  ];

  return { warnings, epicBranch, remoteToDelete, localToDelete };
}

/**
 * Push out the actual deletes. One batched git call per side (remote
 * then local), with `deleteBranchesBatched` falling back to per-ref
 * deletes if the batch fails so a single bad ref does not abort the
 * whole pass. Failures land in `warnings`. Trailing
 * `git remote prune origin` runs only if at least one side had work.
 *
 * @param {string[]} remoteToDelete
 * @param {string[]} localToDelete
 * @param {{ logger?: typeof progress, projectRoot?: string }} [deps]
 * @returns {{ warnings: string[] }}
 */
export function phaseDeleteEpicBranches(
  remoteToDelete,
  localToDelete,
  deps = {},
) {
  const logger = deps.logger ?? progress;
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const warnings = [];

  if (remoteToDelete.length > 0) {
    logger(
      'CLEANUP',
      `Deleting ${remoteToDelete.length} remote branch(es): ${remoteToDelete.join(', ')}`,
    );
    const r = deleteBranchesBatched(remoteToDelete, {
      scope: 'remote',
      remote: 'origin',
      cwd: projectRoot,
    });
    for (const f of r.failed) {
      warnings.push(`remote branch ${f.name}: ${f.stderr ?? f.reason}`);
      Logger.warn(
        `⚠️ Warning: Could not delete remote branch ${f.name} (may not exist): ${f.stderr ?? f.reason}`,
      );
    }
  }

  if (localToDelete.length > 0) {
    logger(
      'CLEANUP',
      `Deleting ${localToDelete.length} local branch(es): ${localToDelete.join(', ')}`,
    );
    const r = deleteBranchesBatched(localToDelete, {
      scope: 'local',
      cwd: projectRoot,
      force: true,
    });
    for (const f of r.failed) {
      warnings.push(`local branch ${f.name}: ${f.stderr ?? f.reason}`);
      Logger.warn(
        `⚠️ Warning: Could not delete local branch ${f.name}: ${f.stderr ?? f.reason}`,
      );
    }
  }

  if (remoteToDelete.length > 0 || localToDelete.length > 0) {
    gitSpawn(projectRoot, 'remote', 'prune', 'origin');
  }

  return { warnings };
}

/**
 * Reap stale worktrees and delete every local + remote branch owned by
 * the Epic. Thin orchestrator over the three named sub-phases:
 * `phaseReapWorktrees`, `phaseEnumerateEpicBranches`, and
 * `phaseDeleteEpicBranches`. Each sub-phase returns
 * `{ warnings: string[], ... }` which this function merges into the
 * caller's `warnings` array — observable behaviour is unchanged from
 * the pre-refactor inline form.
 */
async function phaseFinalizeBranchCleanup(
  provider,
  orchestration,
  epicId,
  warnings,
  opts = {},
) {
  progress('CLEANUP', 'Starting branch cleanup...');

  const reap = await phaseReapWorktrees(provider, orchestration, epicId, opts);
  warnings.push(...reap.warnings);

  const enumerated = await phaseEnumerateEpicBranches(provider, epicId);
  warnings.push(...enumerated.warnings);

  const deleted = phaseDeleteEpicBranches(
    enumerated.remoteToDelete,
    enumerated.localToDelete,
  );
  warnings.push(...deleted.warnings);

  progress('CLEANUP', '✅ Branch cleanup complete.');
}

/**
 * For each reaped worktree whose dirty changes were discarded as part of the
 * force-reap-after-merge flow, post a `friction` structured comment on the
 * Story ticket listing the discarded paths so the signal is not lost. Best
 * effort — per-story failures are recorded as warnings so one misbehaving
 * ticket does not abort the rest of the close flow.
 */
async function emitDiscardFrictionComments(provider, reaped, warnings) {
  for (const entry of reaped) {
    if (!entry.discardedPaths || entry.discardedPaths.length === 0) continue;
    const body = [
      `⚠️ Force-reap discarded uncommitted changes in worktree \`story-${entry.storyId}\``,
      '',
      `The Story branch was already merged into \`epic/*\`, so \`/epic-close\` Phase 7 discarded the following post-merge drift to complete the reap (default behavior; pass \`--no-reap-discard-after-merge\` to preserve).`,
      '',
      'Discarded paths:',
      ...entry.discardedPaths.map((p) => `- \`${p}\``),
    ].join('\n');
    try {
      await postStructuredComment(provider, entry.storyId, 'friction', body);
    } catch (err) {
      warnings.push(`friction comment on #${entry.storyId}: ${err.message}`);
      Logger.warn(
        `⚠️ Warning: Failed to post reap-discard friction comment on Story #${entry.storyId}: ${err.message}`,
      );
    }
  }
}

function phaseNotifyBanner(epicId, warnings) {
  if (warnings.length === 0) {
    progress('DONE', `🎉 Formal closure for Epic #${epicId} finished.`);
    return;
  }
  progress(
    'DONE',
    `⚠️ Formal closure for Epic #${epicId} finished with ${warnings.length} warning(s):`,
  );
  for (const w of warnings) progress('DONE', `   - ${w}`);
  process.exitCode = 2;
}

/**
 * Recursively collect every descendant ticket ID under an Epic. Walks the
 * native sub-issue graph via `provider.getSubTickets` so Stories and Tasks
 * are captured even when their bodies only reference their immediate parent
 * (Feature or Story), not the Epic directly. Breadth-first with a visited
 * set so shared-ancestor cycles do not loop forever.
 *
 * @param {object} provider
 * @param {number} epicId
 * @returns {Promise<number[]>}
 */
async function collectEpicDescendantIds(provider, epicId) {
  const visited = new Set();
  const queue = [epicId];
  const out = [];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const children = await provider.getSubTickets(parentId);
    for (const child of children) {
      if (!visited.has(child.id)) {
        out.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return out;
}

/**
 * Phase 6.0 — spawn `analyze-execution.js --epic <eid>` so the Epic
 * perf-report structured comment lands on the Epic ticket before the
 * retro composer (Phase 6.1) consumes it.
 *
 * Best-effort per Story #1123: a non-zero exit is logged as a warning
 * and never blocks Phase 7 (Finalize). The retro helper falls back to
 * its baseline behaviour when the comment is absent, so a missing
 * perf-report is non-fatal but observably degraded.
 *
 * Exported for `tests/workflows/epic-close.phase-6.test.js`. The
 * `spawnFn` injection mirrors the pattern in
 * `post-merge-pipeline.js#perfSummaryPhase` so tests can pin args
 * without spawning a child process.
 *
 * @param {number} epicId
 * @param {string[]} warnings
 * @param {{
 *   spawnFn?: typeof execFileSync,
 *   projectRoot?: string,
 *   logger?: typeof progress,
 * }} [opts]
 * @returns {{ status: 'ok'|'failed', reason?: string }}
 */
export function phasePostEpicPerfReport(epicId, warnings, opts = {}) {
  const { spawnFn = execFileSync, projectRoot, logger = progress } = opts;
  const root = projectRoot ?? process.cwd();
  const analyzerPath = path.join(
    root,
    '.agents',
    'scripts',
    'analyze-execution.js',
  );
  const args = [analyzerPath, '--epic', String(epicId)];
  logger('PERF', `Running analyzer: analyze-execution.js --epic ${epicId}`);
  try {
    spawnFn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger('PERF', '✅ epic-perf-report posted');
    return { status: 'ok' };
  } catch (err) {
    const reason = err?.message ?? String(err);
    const message = `analyze-execution failed (non-fatal): ${reason}`;
    Logger.warn(`[epic-close] ⚠️ ${message}`);
    warnings.push(message);
    return { status: 'failed', reason };
  }
}

runAsCli(import.meta.url, main, { source: 'epic-close' });
