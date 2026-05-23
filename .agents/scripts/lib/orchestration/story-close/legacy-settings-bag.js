/**
 * legacy-settings-bag.js — narrow bridge for `story-close` helpers under
 * `lib/orchestration/story-close/**` that still consume the legacy
 * `agentSettings`-shape parameter (`{ baseBranch, paths, commands,
 * quality, planning }`).
 *
 * Story #2946 / Task #2951 sweeps the leaf `story-close.js` orchestrator
 * to canonical config (`{ project, github, planning, delivery }`). The
 * lib-level helpers still accept the legacy bag for the moment; this
 * file synthesizes the bag from the canonical config so the leaf
 * orchestrator never has to mention the legacy field names directly.
 *
 * When the lib-level helpers migrate to the canonical config in a
 * follow-on, this bridge is deleted in the same PR (hard-cutover
 * policy — `.agents/rules/git-conventions.md#contract-cutovers-—-no-shim-layer`).
 */

import { buildDefaultGates } from '../../close-validation.js';

/**
 * Build the legacy `{ baseBranch, paths, commands, quality, planning }`
 * bag from the canonical resolved config.
 *
 * @param {object} config Canonical config returned by `resolveConfig()`.
 * @returns {object} legacy-shape bag
 */
export function buildLegacySettingsBag(config) {
  return {
    baseBranch: config.project?.baseBranch,
    paths: config.project?.paths,
    commands: config.project?.commands,
    quality: config.delivery?.quality,
    planning: config.planning,
  };
}

/**
 * Build the legacy `{ github, worktreeIsolation, notifications, runners }`
 * bag from the canonical resolved config (the shape that helpers under
 * `lib/orchestration/story-close/**` still consume as `orchestration`).
 *
 * @param {object} config Canonical config returned by `resolveConfig()`.
 * @returns {object} legacy-shape bag
 */
/**
 * Wrapper around `buildDefaultGates` from `lib/close-validation.js` that
 * threads the canonical config through the legacy bag without forcing
 * leaf orchestrators to name the legacy keys directly.
 *
 * @param {object} config Canonical config returned by `resolveConfig()`.
 * @param {{ epicBranch: string, fullScopeCrap?: boolean }} opts
 * @returns {Array<object>} gate array shaped as `buildDefaultGates` returns
 */
export function buildGatesFromConfig(config, opts) {
  return buildDefaultGates({
    agentSettings: buildLegacySettingsBag(config),
    epicBranch: opts.epicBranch,
    fullScopeCrap: opts.fullScopeCrap,
  });
}

export function buildLegacyOrchestrationBag(config) {
  return {
    github: config.github,
    worktreeIsolation: config.delivery?.worktreeIsolation,
    notifications: config.github?.notifications,
    runners: { deliverRunner: config.delivery?.deliverRunner ?? {} },
  };
}
