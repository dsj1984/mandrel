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
 * @param {{ status: string, reason?: string }|null} [args.boardSync] The
 *   executing flip's Projects v2 outcome; `null` under --dry-run.
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
  boardSync = null,
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
    // The board is best-effort, so a Status that did not move is reported,
    // never an init failure; the transition logged the remedy.
    boardSync,
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
    boardSync: summarizeBoardSync(boardSync),
  };
  return { result, summary };
}

/**
 * `synced`, or the status with its reason so the one stdout line says why
 * the board did not move.
 *
 * @param {{ status: string, reason?: string }|null} boardSync
 * @returns {string|null}
 */
function summarizeBoardSync(boardSync) {
  if (!boardSync) return null;
  if (!boardSync.reason) return boardSync.status;
  return `${boardSync.status} (${boardSync.reason})`;
}
