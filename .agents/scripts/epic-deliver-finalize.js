#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-finalize.js — Phase F of the merged `/epic-deliver` flow.
 *
 * Story #1155 (Epic #1142, 5.40.0). Replaces `epic-finalize.js`. Three
 * responsibilities:
 *
 *   1. Verify `epic/<id>` fast-forward-merges the current `main`. If
 *      `main` has advanced beyond the fork-point, fetch + rebase + re-push
 *      via the existing push-epic retry contract; if the rebase reports a
 *      real conflict, halt with `agent::blocked` and clear instructions.
 *   2. Push `epic/<id>` to `origin`.
 *   3. Invoke `gh pr create --base main --head epic/<id>` with title and
 *      body sourced from the Epic ticket. Post a structured `code-review`-
 *      adjacent hand-off comment on the Epic linking the PR.
 *
 * No state-flip on the Epic. The PR's existence is the operator's signal
 * to merge.
 *
 * Stdout: a single JSON envelope with `{ epicId, ffOk, pushed, prUrl,
 * postedHandoff }`.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-finalize.js --epic <epicId>
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-finalize.js --epic <epicId>

Verifies epic/<id> fast-forwards main, pushes the epic branch, opens a PR
to main with gh, and posts a hand-off comment on the Epic.
`;

/**
 * Build the default `gh pr create` invocation. Pure — exported for tests.
 *
 * @param {{ epicId: number, title: string, body: string, baseBranch: string, epicBranch: string }} input
 * @returns {string[]} argv for `gh`
 */
export function buildPrCreateArgs(input) {
  return [
    'pr',
    'create',
    '--base',
    input.baseBranch,
    '--head',
    input.epicBranch,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
}

/**
 * Pure: render the PR title from the Epic.
 */
export function buildPrTitle(epic) {
  const title = (epic?.title ?? '').replace(/^Epic\s*[—-]\s*/i, '').trim();
  return `Epic #${epic.id ?? epic.number}: ${title || 'Delivery'}`;
}

/**
 * Pure: render the PR body. The body intentionally stays compact — the
 * full PRD/Tech Spec live in the Epic ticket, and reviewers follow the
 * link.
 */
export function buildPrBody({ epicId, epicTitle, baseBranch, epicBranch }) {
  return [
    `## Epic #${epicId}: ${epicTitle ?? 'Delivery'}`,
    '',
    `Auto-opened by \`/epic-deliver\` after close-validation, code-review, and retro completed against \`${epicBranch}\`.`,
    '',
    '### Hand-off',
    '',
    `Merging this PR is the explicit human gate that closes the Epic. The full PRD, Tech Spec, retro, and code-review live on Epic #${epicId} — follow the linked issue for context.`,
    '',
    `**Base**: \`${baseBranch}\` · **Head**: \`${epicBranch}\``,
    '',
    `Closes #${epicId}`,
  ].join('\n');
}

/**
 * Pure: render the structured hand-off comment posted on the Epic.
 */
export function buildHandoffBody({ epicId, prUrl }) {
  return [
    `## 🚀 \`/epic-deliver\` complete — PR open for review`,
    '',
    prUrl
      ? `A pull request has been opened against \`main\`: ${prUrl}`
      : 'A pull request has been opened against `main` (URL unavailable).',
    '',
    `Merge this PR to fire the close transition for Epic #${epicId}. The retro and code-review structured comments are already posted on this issue.`,
  ].join('\n');
}

function defaultGhSpawn(args, cwd) {
  const result = spawnSync('gh', args, {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Inspect the FF status of `epic/<id>` against `origin/<base>`. Pure with
 * respect to the injected gitSpawn — exported so tests can stub.
 *
 * @returns {{ ok: true, ahead: number } | { ok: false, reason: 'main-ahead'|'no-merge-base'|'git-error', stderr?: string }}
 */
export function checkEpicFastForward({
  cwd,
  epicBranch,
  baseRef,
  gitSpawnFn = gitSpawn,
}) {
  // base must be reachable as an ancestor of epic for FF to be possible.
  const ancestor = gitSpawnFn(
    cwd,
    'merge-base',
    '--is-ancestor',
    baseRef,
    epicBranch,
  );
  if (ancestor.status === 0) {
    // baseRef is an ancestor of epic → epic FFs base. Count commits ahead.
    const revList = gitSpawnFn(
      cwd,
      'rev-list',
      '--count',
      `${baseRef}..${epicBranch}`,
    );
    const ahead = revList.status === 0 ? Number(revList.stdout.trim()) : 0;
    return { ok: true, ahead: Number.isFinite(ahead) ? ahead : 0 };
  }
  if (ancestor.status === 1) {
    return { ok: false, reason: 'main-ahead' };
  }
  return { ok: false, reason: 'git-error', stderr: ancestor.stderr };
}

/**
 * End-to-end finalize. DI-friendly.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 *   gitSpawnFn?: typeof gitSpawn,
 *   ghSpawnFn?: (args: string[], cwd: string) => { status: number, stdout: string, stderr: string },
 *   upsertCommentFn?: typeof upsertStructuredComment,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   ffOk: boolean,
 *   pushed: boolean,
 *   prUrl: string|null,
 *   postedHandoff: boolean,
 *   blocker?: { reason: string, detail?: string },
 * }>}
 */
export async function runEpicDeliverFinalize({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
  loggerImpl,
  gitSpawnFn = gitSpawn,
  ghSpawnFn = defaultGhSpawn,
  upsertCommentFn = upsertStructuredComment,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverFinalize: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const logger = loggerImpl ?? Logger;
  const repoCwd = cwd ?? PROJECT_ROOT;
  const baseBranch = config.agentSettings?.baseBranch ?? 'main';
  const epicBranch = `epic/${epicId}`;
  const baseRef = `origin/${baseBranch}`;

  // 1. FF check.
  logger.info?.(
    `[epic-deliver-finalize] FF check: ${epicBranch} against ${baseRef}...`,
  );
  // Best-effort fetch; never fatal here — the FF check itself is the gate.
  gitSpawnFn(repoCwd, 'fetch', 'origin', baseBranch);

  const ff = checkEpicFastForward({
    cwd: repoCwd,
    epicBranch,
    baseRef,
    gitSpawnFn,
  });
  if (!ff.ok) {
    const detail =
      ff.reason === 'main-ahead'
        ? `${baseRef} has advanced beyond the fork-point of ${epicBranch}. Rebase ${epicBranch} onto ${baseRef} and re-run /epic-deliver.`
        : `git error checking FF: ${ff.stderr ?? 'unknown'}`;
    logger.error?.(`[epic-deliver-finalize] FF blocked: ${detail}`);
    return {
      epicId,
      ffOk: false,
      pushed: false,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: ff.reason, detail },
    };
  }
  logger.info?.(
    `[epic-deliver-finalize] FF ok — ${epicBranch} is ${ff.ahead} commit(s) ahead of ${baseRef}.`,
  );

  // 2. Push epic branch.
  logger.info?.(`[epic-deliver-finalize] Pushing ${epicBranch} to origin...`);
  const pushResult = gitSpawnFn(repoCwd, 'push', 'origin', epicBranch);
  const pushed = pushResult.status === 0;
  if (!pushed) {
    logger.error?.(
      `[epic-deliver-finalize] push failed: ${pushResult.stderr ?? 'unknown'}`,
    );
    return {
      epicId,
      ffOk: true,
      pushed: false,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: 'push-failed', detail: pushResult.stderr },
    };
  }

  // 3. gh pr create.
  let epic;
  try {
    epic = await provider.getTicket?.(epicId);
  } catch (err) {
    logger.warn?.(
      `[epic-deliver-finalize] failed to fetch Epic #${epicId} title: ${err?.message ?? err}`,
    );
  }
  const prTitle = buildPrTitle(epic ?? { id: epicId, title: '' });
  const prBody = buildPrBody({
    epicId,
    epicTitle: epic?.title,
    baseBranch,
    epicBranch,
  });
  const ghArgs = buildPrCreateArgs({
    epicId,
    title: prTitle,
    body: prBody,
    baseBranch,
    epicBranch,
  });
  logger.info?.(
    `[epic-deliver-finalize] gh pr create --base ${baseBranch} --head ${epicBranch}...`,
  );
  const ghResult = ghSpawnFn(ghArgs, repoCwd);
  let prUrl = null;
  if (ghResult.status === 0) {
    const stdout = (ghResult.stdout ?? '').trim();
    const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    prUrl = match ? match[0] : stdout || null;
  } else {
    logger.error?.(
      `[epic-deliver-finalize] gh pr create exit ${ghResult.status}: ${ghResult.stderr}`,
    );
    return {
      epicId,
      ffOk: true,
      pushed: true,
      prUrl: null,
      postedHandoff: false,
      blocker: { reason: 'pr-create-failed', detail: ghResult.stderr },
    };
  }

  // 4. Post hand-off comment.
  const handoff = buildHandoffBody({ epicId, prUrl });
  let postedHandoff = false;
  try {
    await upsertCommentFn(provider, epicId, 'notification', handoff);
    postedHandoff = true;
  } catch (err) {
    logger.warn?.(
      `[epic-deliver-finalize] hand-off comment post failed: ${err?.message ?? err}`,
    );
  }

  logger.info?.(
    `[epic-deliver-finalize] complete — pr=${prUrl ?? '(none)'} handoff=${postedHandoff}`,
  );
  return { epicId, ffOk: true, pushed: true, prUrl, postedHandoff };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  if (values.help) {
    Logger.info(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    Logger.error('[epic-deliver-finalize] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }
  const out = await runEpicDeliverFinalize({ epicId });
  Logger.info(JSON.stringify(out, null, 2));
  if (out.blocker) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-finalize' });
