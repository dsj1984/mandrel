/**
 * close-inputs.js — argument parsing + cwd / epic / branch resolution for
 * the story-close CLI. Extracted from story-close.js (Story #956, Theme A
 * finishing touch) so the close orchestrator becomes a thin CLI shell.
 *
 * `resolveCloseInputs` folds the three pre-merge resolutions that
 * `runStoryClose` does up-front into a single helper:
 *
 *   - parse the CLI argv (or normalize the parameter object passed to
 *     `runStoryClose(...)` from a test/programmatic caller),
 *   - resolve the main-repo cwd (explicit param > --cwd flag > env >
 *     PROJECT_ROOT),
 *   - run the cd-out guard before any git/filesystem mutation,
 *   - fetch the Story ticket and resolve `epicId` from the body when not
 *     passed via --epic,
 *   - derive `epicBranch` + `storyBranch` from the canonical helpers.
 *
 * The helper does NOT touch the merge lock, the post-merge pipeline, or
 * the phase timer — those stay in the orchestrator.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from '../../cli-args.js';
import { PROJECT_ROOT, resolveConfig } from '../../config-resolver.js';
import { getEpicBranch, getStoryBranch } from '../../git-utils.js';
import { createProvider as defaultCreateProvider } from '../../provider-factory.js';
import { resolveStoryHierarchy } from '../../story-lifecycle.js';
import { checkCdOutGuard } from './cd-out-guard.js';

/**
 * Resolve the path of the Story's worktree given the resolved main `cwd` and
 * `storyId`. Returns the absolute worktree path when `<cwd>/<root>/story-<id>`
 * exists on disk; returns `null` otherwise (single-tree mode, or the worktree
 * was reaped earlier in the close flow). Used by `runStoryClose` to thread
 * the worktree directory into pre-merge gate spawns so close-validation runs
 * against the Story branch's post-rebase tree (Story #1120).
 *
 * Pure-ish (modulo `fs.existsSync`) — exported so tests can pin the
 * "what counts as a usable worktree" contract without mocking filesystem
 * state.
 */
export function resolveWorktreePath({ cwd, storyId, worktreeRoot }) {
  if (!cwd || !storyId) return null;
  const root = worktreeRoot ?? '.worktrees';
  const candidate = path.resolve(cwd, root, `story-${storyId}`);
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   storyIdParam?: number|string,
 *   epicIdParam?: number|string,
 *   skipDashboardParam?: boolean,
 *   skipValidationParam?: boolean,
 *   cwdParam?: string|null,
 *   resumeParam?: boolean,
 *   restartParam?: boolean,
 *   injectedProvider?: object,
 *   createProvider?: typeof defaultCreateProvider,
 * }} args
 */
export async function resolveCloseInputs({
  storyIdParam,
  epicIdParam,
  skipDashboardParam,
  skipValidationParam,
  cwdParam,
  resumeParam,
  restartParam,
  injectedProvider,
  createProvider = defaultCreateProvider,
}) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          epicId: epicIdParam,
          skipDashboard: !!skipDashboardParam,
          skipValidation: !!skipValidationParam,
          cwd: cwdParam ?? null,
          resume: !!resumeParam,
          restart: !!restartParam,
        }
      : parseSprintArgs();
  const cwd = path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT);

  if (!parsed.storyId) {
    throw new Error(
      'Usage: node story-close.js --story <STORY_ID> [--epic <EPIC_ID>]',
    );
  }

  const config = resolveConfig({ cwd });
  const worktreeRoot = config.delivery?.worktreeIsolation?.root;

  const guard = checkCdOutGuard({
    cwdExplicit: parsed.cwd != null,
    mainCwd: cwd,
    storyId: parsed.storyId,
    worktreeRoot,
  });
  if (!guard.ok) throw new Error(guard.message);

  const provider = injectedProvider || createProvider(config);
  const story = await provider.getTicket(parsed.storyId);
  let epicId = parsed.epicId;
  if (!epicId) {
    const resolved = resolveStoryHierarchy(story.body);
    if (!resolved.epicId) {
      throw new Error(
        `Story #${parsed.storyId} has no "Epic: #N" reference. Pass --epic <id> explicitly.`,
      );
    }
    epicId = resolved.epicId;
  }

  return {
    storyId: parsed.storyId,
    epicId,
    cwd,
    worktreePath: resolveWorktreePath({
      cwd,
      storyId: parsed.storyId,
      worktreeRoot,
    }),
    skipDashboard: parsed.skipDashboard,
    skipValidation: !!parsed.skipValidation,
    resumeFlag: parsed.resume,
    restartFlag: parsed.restart,
    noEvidenceFlag: parsed.noEvidence,
    config,
    provider,
    story,
    epicBranch: getEpicBranch(epicId),
    storyBranch: getStoryBranch(epicId, parsed.storyId),
  };
}
