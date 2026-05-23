/**
 * phases/timeout-blocked.js — pure timeout-classification helpers for
 * the story-close phase pipeline (Story #2460, Epic #2453).
 *
 * Holds the spawn-timeout descriptor table, the reason-token map, the
 * config → timeout-ms resolver, and the friction-comment body renderers.
 * The side-effecting emit (label transition + comment upsert + bus emit)
 * lives in the sibling `timeout-blocked-emitter.js` so this file stays
 * pure and easy to test.
 *
 * Public surface (all exported; re-exported by story-close.js for
 * historical test imports):
 *   - SPAWN_TIMEOUT_DESCRIPTORS
 *   - resolveSpawnTimeoutDescriptor(name)
 *   - resolveSpawnTimeoutReason(name)
 *   - resolveSpawnTimeoutMs(name, config)
 *   - renderSpawnTimeoutFrictionBody(input)
 *   - renderCoverageTimeoutFrictionBody(input)
 */

import { getQuality } from '../../../config-resolver.js';

/**
 * Story #2165 — known spawn-timeout dispatch table. Each entry names the
 * spawn whose bounded-timeout watchdog tripped and the `.agentrc.json`
 * config key the operator tunes to raise the budget.
 */
export const SPAWN_TIMEOUT_DESCRIPTORS = Object.freeze({
  'coverage-capture': Object.freeze({
    displayName: 'Coverage capture',
    defaultCmd: 'npm run test:coverage',
    configKey: 'delivery.quality.gates.coverage.timeoutMs',
    summary: 'The `coverage-capture` pre-merge gate',
  }),
  'check-maintainability': Object.freeze({
    displayName: 'Maintainability baseline refresh',
    defaultCmd: 'npm run maintainability:update',
    configKey: 'delivery.quality.gates.maintainability.refreshTimeoutMs',
    summary: 'The `check-maintainability` baseline-refresh path',
  }),
  'check-crap': Object.freeze({
    displayName: 'CRAP baseline refresh',
    defaultCmd: 'npm run crap:update',
    configKey: 'delivery.quality.gates.crap.refreshTimeoutMs',
    summary: 'The `check-crap` baseline-refresh path',
  }),
  'format-autofix': Object.freeze({
    displayName: 'Format autofix',
    defaultCmd: 'npx biome format --write .',
    configKey: 'delivery.quality.formatAutofix.timeoutMs',
    summary: 'The pre-gate `format-autofix` step',
  }),
});

const DEFAULT_TIMEOUT_DESCRIPTOR = Object.freeze({
  displayName: 'Close-time spawn',
  defaultCmd: '<unknown>',
  configKey: 'delivery.quality.<gate>.timeoutMs',
  summary: 'A close-time spawn',
});

export function resolveSpawnTimeoutDescriptor(spawnName) {
  return SPAWN_TIMEOUT_DESCRIPTORS[spawnName] ?? DEFAULT_TIMEOUT_DESCRIPTOR;
}

/**
 * Story #2241 / Task #2247 — map a spawn-timeout name to the canonical
 * `story.blocked.reason` token the lifecycle bus emits.
 */
const SPAWN_TIMEOUT_REASONS = Object.freeze({
  'coverage-capture': 'timeout:coverage-capture',
  'check-maintainability': 'timeout:baseline-refresh',
  'check-crap': 'timeout:baseline-refresh',
  'format-autofix': 'timeout:biome-format',
});

export function resolveSpawnTimeoutReason(spawnName) {
  return (
    SPAWN_TIMEOUT_REASONS[spawnName] ?? `timeout:${spawnName ?? 'unknown'}`
  );
}

/**
 * Story #2165 — resolve the timeout (ms) the upstream watchdog enforced
 * for the named spawn. Best-effort: a missing/invalid resolver returns
 * `null`.
 */
export function resolveSpawnTimeoutMs(spawnName, config) {
  try {
    const quality = getQuality(config);
    switch (spawnName) {
      case 'coverage-capture':
        return quality?.coverage?.timeoutMs ?? null;
      case 'check-maintainability':
        return quality?.maintainability?.refreshTimeoutMs ?? null;
      case 'check-crap':
        return quality?.crap?.refreshTimeoutMs ?? null;
      case 'format-autofix':
        return quality?.formatAutofix?.timeoutMs ?? null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Render the friction-comment body posted on the Story ticket when one of
 * the close-time spawns trips the bounded-timeout watchdog (exit 124).
 */
export function renderSpawnTimeoutFrictionBody({
  storyId,
  epicId,
  timeoutMs,
  spawnName = 'coverage-capture',
  spawnCmd,
}) {
  const descriptor = resolveSpawnTimeoutDescriptor(spawnName);
  const cmd = spawnCmd || descriptor.defaultCmd;
  const seconds = Math.round((timeoutMs ?? 0) / 1000);
  const minutes = Math.round((seconds / 60) * 10) / 10;
  const budget = timeoutMs
    ? `${timeoutMs}ms (~${minutes} min)`
    : 'configured budget';
  return [
    `### ${descriptor.displayName} timed out`,
    '',
    `${descriptor.summary} spawned \`${cmd}\` for Story #${storyId} (Epic #${epicId ?? 'unknown'}) and the bounded watchdog killed the child after ${budget}.`,
    '',
    `**Exit code:** 124 (GNU \`timeout(1)\` convention — surfaced when \`spawnSync\` returns with \`signal: 'SIGKILL'\`).`,
    '',
    `**Next actions:**`,
    `- Re-run \`${cmd}\` locally inside the Story worktree to confirm the hang.`,
    `- If the command is honestly slow, raise \`${descriptor.configKey}\` in \`.agentrc.json\` and re-close.`,
    `- If a deadlock or runaway loop is the cause, isolate the offending input and fix the underlying hang.`,
    '',
    `Story label has been flipped to \`agent::blocked\`. Resume by transitioning back to \`agent::executing\` after the underlying issue is fixed.`,
  ].join('\n');
}

/**
 * Backwards-compatible wrapper for the coverage-capture timeout body
 * (Story #2136 / Task #2143).
 */
export function renderCoverageTimeoutFrictionBody({
  storyId,
  epicId,
  timeoutMs,
}) {
  return renderSpawnTimeoutFrictionBody({
    storyId,
    epicId,
    timeoutMs,
    spawnName: 'coverage-capture',
  });
}
