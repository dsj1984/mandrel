// lib/migrations/index.js
/**
 * Version-keyed migration runner. A step is `{ version, description,
 * detect(ctx), apply(ctx) }`; `detect` MUST return false once `apply` has run
 * on the same ctx, which makes a repeat pass a no-op.
 */

import { compareVersions } from '../cli/version-helpers.js';
import { retireMiDropKnobs } from './steps/2.1.0-retire-mi-drop-knobs.js';
import { retireVerifyConcurrencyCap } from './steps/2.1.0-retire-verify-concurrency-cap.js';
import { retireEpicAcTags } from './steps/2.2.0-retire-epic-ac-tags.js';
import { retireMaxSeedWords } from './steps/2.11.0-retire-max-seed-words.js';
import { retireCodebaseSnapshot } from './steps/2.20.0-retire-codebase-snapshot.js';
import { retireLintBaselineCommand } from './steps/2.32.0-retire-lint-baseline-command.js';
import { retireDeliveryLimitKnobs } from './steps/2.57.0-retire-delivery-limit-knobs.js';
import { retirePlanningLimitKnobs } from './steps/2.57.0-retire-planning-limit-knobs.js';
import { retireAuditResultsAutoFile } from './steps/2.60.0-retire-audit-results-autofile.js';
import { baselineMergeQueueShape } from './steps/2.63.0-baseline-merge-queue-shape.js';
import { stripRemovedAgentrcKeys } from './steps/strip-removed-agentrc-keys.js';

/**
 * MUST stay sorted ascending by `version`.
 *
 * @type {Array<{
 *   version: string,
 *   description: string,
 *   detect: (ctx: unknown) => boolean,
 *   apply: (ctx: unknown) => void,
 * }>}
 */
export const migrations = [
  retireMiDropKnobs,
  retireVerifyConcurrencyCap,
  retireEpicAcTags,
  retireMaxSeedWords,
  retireCodebaseSnapshot,
  retireLintBaselineCommand,
  retirePlanningLimitKnobs,
  retireDeliveryLimitKnobs,
  retireAuditResultsAutoFile,
  stripRemovedAgentrcKeys,
  baselineMergeQueueShape,
];

export { compareVersions };

/**
 * `fromVersion < step.version <= toVersion`, ascending. Shared with
 * `mandrel migrate --dry-run` so the preview cannot drift from the run.
 *
 * @param {{ registry?: Array<object>, fromVersion: string, toVersion: string }} params
 * @returns {Array<object>}
 */
export function selectStepsInRange({
  registry = migrations,
  fromVersion,
  toVersion,
}) {
  return registry
    .filter(
      (step) =>
        compareVersions(step.version, fromVersion) > 0 &&
        compareVersions(step.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Apply each in-range step whose `detect` is true.
 *
 * @param {object} params
 * @param {string} params.fromVersion - Exclusive.
 * @param {string} params.toVersion - Inclusive.
 * @param {unknown} params.ctx
 * @param {(message: string) => void} [params.log]
 * @param {Array<{
 *   version: string,
 *   description: string,
 *   detect: (ctx: unknown) => boolean,
 *   apply: (ctx: unknown) => void,
 * }>} [params.registry]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations({
  fromVersion,
  toVersion,
  ctx,
  log = console.log,
  registry = migrations,
} = {}) {
  const inRange = selectStepsInRange({ registry, fromVersion, toVersion });

  const applied = [];
  const skipped = [];

  for (const step of inRange) {
    if (!step.detect(ctx)) {
      skipped.push(step.version);
      continue;
    }
    step.apply(ctx);
    log(`migrated ${step.version}: ${step.description}`);
    applied.push(step.version);
  }

  return { applied, skipped };
}

export default runMigrations;
