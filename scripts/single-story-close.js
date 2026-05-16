#!/usr/bin/env node

/**
 * single-story-close.js — Close a standalone Story (no parent Epic).
 *
 * Counterpart to `story-close.js` for the `/single-story-execute` workflow.
 * The framework's main `story-close.js` runs pre-merge gates with
 * baseline-attribution wiring, merges into `epic/<id>` --no-ff, pushes the
 * Epic branch, cascades to the parent Feature/Epic, regenerates the
 * dispatch manifest, and refreshes the dashboard. None of that applies to
 * a standalone Story — its target is `main`, its merge mechanism is a
 * human-approved PR, and there is no parent to cascade to.
 *
 * What this script does:
 *   1. Resolve the worktree path (if worktree isolation is enabled).
 *   2. Run the canonical close-validation gate chain (typecheck, lint,
 *      test, format, maintainability, coverage, crap) against
 *      `agentSettings.baseBranch` as the baseline ref. `--skip-validation`
 *      bypasses this step.
 *   3. Push the Story branch to `origin`.
 *   4. Open (or reuse) a PR against `baseBranch` via `gh pr create`. The
 *      PR body carries `Closes #<storyId>` so the GitHub merge auto-closes
 *      the issue when the operator merges.
 *   5. Flip the Story to `agent::done` (PR merge handles the issue close).
 *   6. Reap the worktree when `reapOnSuccess` is enabled.
 *
 * What this script does NOT do (and why):
 *   - Skips the epic-merge-lock — no concurrent Stories to serialize.
 *   - Skips `dispatchRecovery` — no resume-from-conflict state machine.
 *   - Skips `runAutoRefresh` — bounded-baseline drift is an Epic concern.
 *   - Skips `runPostMergePipeline` — no cascade, no dashboard, no manifest.
 *   - Does NOT merge to `main` directly — the PR is the human gate. The
 *     Story branch stays alive until the operator merges; the worktree is
 *     reaped after the PR opens because the branch is no longer needed
 *     locally.
 *
 * Usage:
 *   node single-story-close.js --story <STORY_ID> [--cwd <main-repo>]
 *                              [--skip-validation]
 *
 * Exit codes: 0 ok, 1 error.
 *
 * @see .agents/workflows/single-story-execute.md
 */

import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  buildDefaultGates,
  runCloseValidation,
} from './lib/close-validation.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { getStoryBranch, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { clearActiveStoryEnv } from './lib/observability/active-story-env.js';
import { createProvider } from './lib/provider-factory.js';
import { flipLabelAndNotify } from './lib/single-story/story-merged-notify.js';
import { WorktreeManager } from './lib/worktree-manager.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Close a standalone Story. Exported for testing.
 */
export async function runSingleStoryClose({
  storyId: storyIdParam,
  cwd: cwdParam,
  skipValidation: skipValidationParam,
  noAutoMerge: noAutoMergeParam,
  noFullScopeCrap: noFullScopeCrapParam,
  injectedProvider,
  injectedConfig,
  injectedNotify,
} = {}) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          cwd: cwdParam ?? null,
          skipValidation: !!skipValidationParam,
          noAutoMerge: !!noAutoMergeParam,
          noFullScopeCrap: !!noFullScopeCrapParam,
        }
      : parseSprintArgs();
  const { storyId } = parsed;
  const skipValidation = skipValidationParam ?? parsed.skipValidation ?? false;
  const noAutoMerge = noAutoMergeParam ?? parsed.noAutoMerge ?? false;
  const noFullScopeCrap =
    noFullScopeCrapParam ?? parsed.noFullScopeCrap ?? false;
  const cwd = path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT);

  if (!storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--no-auto-merge] [--no-full-scope-crap]',
    );
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const { agentSettings, orchestration } = config;
  const provider = injectedProvider || createProvider(orchestration);

  const baseBranch = agentSettings.baseBranch ?? 'main';
  const storyBranch = getStoryBranch(0, storyId);

  progress('INIT', `Closing standalone Story #${storyId}...`);

  const story = await provider.getTicket(storyId);
  if (story.state === 'closed') {
    progress('NOOP', `Story #${storyId} is already closed. Nothing to do.`);
    return {
      success: true,
      result: {
        storyId,
        standalone: true,
        action: 'noop',
        reason: 'already-closed',
      },
    };
  }

  // Resolve worktree path (read-only check — does the dir exist on disk?).
  const worktreeRoot = orchestration?.worktreeIsolation?.root ?? '.worktrees';
  const worktreePathCandidate = path.resolve(
    cwd,
    worktreeRoot,
    `story-${storyId}`,
  );
  const worktreePath = nodeFs.existsSync(worktreePathCandidate)
    ? worktreePathCandidate
    : null;

  // Step 1: gates. The standalone path uses the canonical close-validation
  // chain so the experience matches Epic-attached Stories — only the
  // baseline ref changes (main, not epic/<id>).
  if (!skipValidation) {
    progress(
      'VALIDATE',
      `Running close-validation gates against baseline ${baseBranch}${worktreePath ? ` in ${worktreePath}` : ''}...`,
    );
    const validation = await runCloseValidation({
      cwd,
      worktreePath,
      gates: buildDefaultGates({
        agentSettings,
        epicBranch: baseBranch,
        fullScopeCrap: !noFullScopeCrap,
      }),
      log: (m) => Logger.info(m),
      storyId,
      // Standalone Stories have no parent Epic, so there's no per-Epic
      // path to scope a `validation-evidence.json` under. Pass `null`
      // (not `0`) so the `evidenceActive` predicate in
      // `runCloseValidation` short-circuits cleanly. `0` is rejected
      // downstream by `validation-evidence.evidencePath` (which
      // requires a positive integer epicId) and aborts the whole gate
      // chain.
      // The trade-off is that re-runs of close on the same SHA don't
      // hit the evidence cache for standalone Stories; that's
      // acceptable until/unless the standalone path warrants its own
      // evidence keyspace.
      epicId: null,
    });
    if (!validation.ok) {
      const [first] = validation.failed;
      const { gate, status, cwd: gateCwd } = first;
      throw new Error(
        `[single-story-close] Gate failed: ${gate.name} (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
          (gate.hint ? ` ${gate.hint}` : ''),
      );
    }
    progress('VALIDATE', '✅ All gates passed.');
  } else {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
  }

  // Step 2: push the Story branch. `git push -u` makes the local branch
  // track origin/story-<id> so subsequent fetches are cheap.
  progress('GIT', `Pushing ${storyBranch} to origin...`);
  try {
    gitSync(cwd, 'push', '--no-verify', '-u', 'origin', storyBranch);
    progress('GIT', `✅ Pushed ${storyBranch}.`);
  } catch (err) {
    throw new Error(
      `[single-story-close] git push failed for ${storyBranch}: ${err?.message ?? err}`,
    );
  }

  // Step 3: open (or reuse) a PR to `baseBranch`. `gh pr view --head` is
  // not available on all gh versions, so we probe with `gh pr list
  // --head <branch>` and fall back to `gh pr create`.
  const prUrl = ensurePullRequest({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBranch,
    baseBranch,
  });

  // Step 3a: enable GitHub native auto-merge so the PR squash-merges itself
  // when required checks pass. Mirrors `epic-deliver-finalize.js`. Default
  // is on for the standalone path because a single-story PR has no
  // intermediate review surface; opt-out via `--no-auto-merge` when the
  // operator wants to inspect the diff before clicking merge. Failures are
  // non-fatal — the operator retains the manual merge path through the
  // GitHub UI.
  const prNumber = parsePrNumber(prUrl);
  let autoMergeEnabled = false;
  let autoMergeReason = null;
  if (noAutoMerge) {
    autoMergeReason = 'disabled-by-flag';
    progress('PR', '⏭  Auto-merge disabled (--no-auto-merge).');
  } else if (prNumber == null) {
    autoMergeReason = 'pr-number-unparseable';
    progress(
      'PR',
      `⚠️ Auto-merge skipped: could not parse PR number from URL ${prUrl}.`,
    );
  } else {
    const result = enableAutoMerge({ cwd, prNumber });
    if (result.enabled) {
      autoMergeEnabled = true;
      progress(
        'PR',
        `✅ Auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
      );
    } else {
      autoMergeReason = result.reason;
      progress(
        'PR',
        `⚠️ Auto-merge enablement failed (${result.reason}) — operator can merge manually.`,
      );
    }
  }

  // Step 4: flip Story label to agent::done and fire story-merged notify.
  await flipLabelAndNotify({
    provider,
    notifyFn: injectedNotify,
    storyId,
    story,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    orchestration,
    progress,
  });

  // Step 5: reap worktree. The branch is still alive on origin so the PR
  // can land; the local worktree is no longer needed.
  let worktreeReaped = false;
  const reapEnabled = orchestration?.worktreeIsolation?.reapOnSuccess !== false;
  if (worktreePath && reapEnabled) {
    try {
      const wm = new WorktreeManager({
        repoRoot: cwd,
        config: orchestration?.worktreeIsolation,
        logger: {
          info: (m) => progress('WORKTREE', m),
          warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
          error: (m) => Logger.error(`[single-story-close] ${m}`),
        },
      });
      await wm.reap(storyId);
      worktreeReaped = true;
      progress('WORKTREE', `🧹 Reaped worktree for story-${storyId}.`);
    } catch (err) {
      Logger.error(
        `[single-story-close] ⚠️ Failed to reap worktree: ${err?.message ?? err}`,
      );
    }
  }

  // Clear the trace-hook env vars so subsequent tooling falls back to the
  // no-op branch instead of pointing at a (now-reaped) worktree.
  try {
    clearActiveStoryEnv({
      logger: { warn: (m) => progress('ENV', `⚠️ ${m}`) },
    });
  } catch {
    // Non-fatal.
  }

  const result = {
    storyId,
    standalone: true,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    pushed: true,
    autoMergeEnabled,
    autoMergeReason,
    worktreeReaped,
    note: autoMergeEnabled
      ? 'PR open against baseBranch with auto-merge enabled. GitHub will squash-merge when required checks pass; the Closes #<id> footer auto-closes the issue.'
      : 'PR open against baseBranch. Operator merges via GitHub UI to close the issue (Closes #<id> auto-close).',
  };

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress('DONE', `✅ Standalone Story #${storyId}: PR ready → ${prUrl}`);
  return { success: true, result };
}

/**
 * Probe for an existing open PR with `head = storyBranch`; create one if
 * none exists. Returns the PR URL. Exported for testing.
 */
export function ensurePullRequest({
  cwd,
  storyId,
  storyTitle,
  storyBranch,
  baseBranch,
}) {
  const ghEnv = { ...process.env };
  try {
    // `gh pr list --head <branch> --state open --json url -q .[0].url`
    // returns the PR URL or an empty string when no PR matches.
    const existing = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        storyBranch,
        '--state',
        'open',
        '--json',
        'url',
        '-q',
        '.[0].url // empty',
      ],
      { cwd, encoding: 'utf8', env: ghEnv },
    ).trim();
    if (existing) {
      progress('PR', `Reusing existing PR: ${existing}`);
      return existing;
    }
  } catch (err) {
    // `gh pr list` failure is recoverable — fall through to create. Log
    // the error so an auth issue surfaces visibly.
    Logger.warn?.(
      `[single-story-close] ⚠️ \`gh pr list\` probe failed (continuing to create): ${err?.message ?? err}`,
    );
  }

  progress('PR', `Opening PR for ${storyBranch} → ${baseBranch}...`);
  const title = storyTitle?.trim()
    ? `${storyTitle} (#${storyId})`
    : `Story #${storyId}`;
  const body = [
    `Closes #${storyId}`,
    '',
    `_Auto-opened by \`/single-story-execute\`._`,
  ].join('\n');
  try {
    const url = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        storyBranch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd, encoding: 'utf8', env: ghEnv },
    ).trim();
    progress('PR', `✅ Opened: ${url}`);
    return url;
  } catch (err) {
    throw new Error(
      `[single-story-close] \`gh pr create\` failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Extract the numeric PR ID from a `gh pr create` URL. The CLI returns a
 * URL like `https://github.com/<owner>/<repo>/pull/<n>`; we want `<n>`.
 * Returns `null` when the URL doesn't match. Exported for testing.
 *
 * @param {string|null|undefined} prUrl
 * @returns {number|null}
 */
export function parsePrNumber(prUrl) {
  if (typeof prUrl !== 'string') return null;
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Enable GitHub native auto-merge on the PR. Mirrors the call in
 * `epic-deliver-finalize.js`: squash strategy, delete the branch on merge.
 * Non-fatal — returns `{ enabled: false, reason }` on any failure so the
 * caller can fall back to the operator-merges-button path.
 *
 * Exported for testing; the injection seam lets tests stub the `gh`
 * invocation without touching the network.
 *
 * @param {{ cwd: string, prNumber: number, runner?: (args: string[], opts: object) => { status: number, stdout?: string, stderr?: string } }} opts
 * @returns {{ enabled: boolean, reason?: string }}
 */
export function enableAutoMerge({ cwd, prNumber, runner }) {
  const exec = runner ?? defaultGhAutoMergeRunner;
  try {
    const result = exec(
      [
        'pr',
        'merge',
        String(prNumber),
        '--auto',
        '--squash',
        '--delete-branch',
      ],
      { cwd },
    );
    if (result.status === 0) return { enabled: true };
    return {
      enabled: false,
      reason: `gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`,
    };
  } catch (err) {
    return { enabled: false, reason: `gh-spawn-error: ${err?.message ?? err}` };
  }
}

function defaultGhAutoMergeRunner(args, { cwd }) {
  try {
    const stdout = execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? String(err?.message ?? err),
    };
  }
}

runAsCli(import.meta.url, runSingleStoryClose, {
  source: 'single-story-close',
});
