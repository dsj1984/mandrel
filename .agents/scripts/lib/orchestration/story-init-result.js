/**
 * The `single-story-init.js` result envelope, composed in one place: the
 * fields the caller acts on (`workCwd`, `dependenciesInstalled`,
 * `remoteVerified`, `checklistPath`) plus the full detail the terse-result
 * log keeps.
 */

import { pinRunScopedConfig } from './run-scoped-config.js';

/** `installStatus.status` → the envelope's `dependenciesInstalled` string. */
const INSTALL_FLAGS = Object.freeze({ installed: 'true', failed: 'false' });

/**
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.storyBranch
 * @param {string} args.baseBranch
 * @param {object} args.config
 * @param {{ title?: string }} args.story
 * @param {{ worktreeEnabled: boolean }} args.runtime
 * @param {string} args.workCwd
 * @param {boolean} args.worktreeCreated
 * @param {{ status: string }} args.installStatus
 * @param {object|null} args.worktreeSweep
 * @param {boolean} args.dryRun
 * @param {{ remoteVerified: boolean, remoteUrl?: string, detail?: string }} args.remote
 * @param {string|null} args.checklistPath
 * @returns {{ result: object, summary: object }}
 */
export function composeStoryInitResult({
  storyId,
  storyBranch,
  baseBranch,
  config,
  story,
  runtime,
  workCwd,
  worktreeCreated,
  installStatus,
  worktreeSweep,
  dryRun,
  remote,
  checklistPath,
}) {
  const dependenciesInstalled =
    INSTALL_FLAGS[installStatus.status] ?? 'skipped';
  const result = {
    storyId,
    epicId: null,
    standalone: true,
    storyBranch,
    baseBranch,
    // Write half of the run-scoped config pin; `baseBranch` is close's fallback.
    runScopedConfig: pinRunScopedConfig(config),
    storyTitle: story.title,
    worktreeEnabled: runtime.worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    dependenciesInstalled,
    installFailed: installStatus.status === 'failed',
    // Closed-Story worktree sweep outcome; a failure degrades here, never
    // into an init failure. `null` under --dry-run.
    worktreeSweep: worktreeSweep ?? null,
    dryRun,
    remoteVerified: remote.remoteVerified,
    remoteProbe: { remoteUrl: remote.remoteUrl, detail: remote.detail },
    // Footprint-matched write-time checklist (null when no lens matches) —
    // the same Story-scoped path a multi-Story dispatch prompt names.
    checklistPath,
  };
  const summary = {
    storyId,
    storyBranch,
    workCwd,
    worktreeCreated,
    dependenciesInstalled,
    remoteVerified: remote.remoteVerified,
    checklistPath,
    dryRun,
  };
  return { result, summary };
}
