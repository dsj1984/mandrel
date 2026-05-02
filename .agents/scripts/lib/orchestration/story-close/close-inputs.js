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

import path from 'node:path';
import { parseSprintArgs } from '../../cli-args.js';
import { PROJECT_ROOT, resolveConfig } from '../../config-resolver.js';
import { getEpicBranch, getStoryBranch } from '../../git-utils.js';
import { createProvider as defaultCreateProvider } from '../../provider-factory.js';
import { resolveStoryHierarchy } from '../../story-lifecycle.js';
import { checkCdOutGuard } from './cd-out-guard.js';

/**
 * @param {{
 *   storyIdParam?: number|string,
 *   epicIdParam?: number|string,
 *   skipDashboardParam?: boolean,
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

  const { orchestration, settings } = resolveConfig({ cwd });

  const guard = checkCdOutGuard({
    cwdExplicit: parsed.cwd != null,
    mainCwd: cwd,
    storyId: parsed.storyId,
    worktreeRoot: orchestration?.worktreeIsolation?.root,
  });
  if (!guard.ok) throw new Error(guard.message);

  const provider = injectedProvider || createProvider(orchestration);
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
    skipDashboard: parsed.skipDashboard,
    resumeFlag: parsed.resume,
    restartFlag: parsed.restart,
    noEvidenceFlag: parsed.noEvidence,
    orchestration,
    settings,
    provider,
    story,
    epicBranch: getEpicBranch(epicId),
    storyBranch: getStoryBranch(epicId, parsed.storyId),
  };
}
