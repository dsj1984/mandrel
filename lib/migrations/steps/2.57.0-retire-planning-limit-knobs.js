// lib/migrations/steps/2.57.0-retire-planning-limit-knobs.js
/**
 * Story #5312 — the planning diet. Strip the ten retired `planning.*` keys
 * from a consumer's config:
 *
 *   - `planning.complexityGate` — the plan-side lite claim and its persist
 *     backstop are gone; nothing reads the switch.
 *   - `planning.riskHeuristics` — the phrase list was empty in every consumer
 *     that resolved it, and the critic trigger that matched it went with the
 *     consolidation critic.
 *   - `planning.failOnSharedEditors`, `planning.requireExplicitCrossStoryDeps`,
 *     `planning.failOnRegistryConflicts`, `planning.failOnLargeFanOut`,
 *     `planning.largeFanOutThreshold`, `planning.crossCuttingRegistries` —
 *     every conflict finding is advisory now, and the registry and fan-out
 *     findings no longer exist.
 *   - `planning.memoryPool.staleAfterDays`, `planning.memoryPool.growthDelta`
 *     — the memory-hygiene advisory keeps only its index-byte arm.
 *
 * The `planning` block carries `additionalProperties: false`, so a config
 * still setting any of them fails validation on upgrade rather than warning.
 * It sweeps **both** config surfaces (`.agentrc.json` and the gitignored
 * `.agentrc.local.json`), because `config-resolver.js` deep-merges the
 * overlay before the AJV gate runs.
 *
 * Pruning: the two `memoryPool` keys prune the `memoryPool` object when it
 * empties and then `planning` itself (`pruneDepth: 2`); the top-level keys
 * prune `planning` (`pruneDepth: 1`). `planning` is optional, so an emptied
 * block is removed rather than left as `{}`. A `memoryPool` that still
 * carries `indexByteCeiling` survives untouched.
 */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

const TOP_LEVEL_KEYS = [
  'complexityGate',
  'riskHeuristics',
  'failOnSharedEditors',
  'requireExplicitCrossStoryDeps',
  'failOnRegistryConflicts',
  'failOnLargeFanOut',
  'largeFanOutThreshold',
  'crossCuttingRegistries',
];

export const retirePlanningLimitKnobs = createRetireAgentrcKeyStep({
  version: '2.57.0',
  description:
    'strip the retired planning.* limit knobs from .agentrc.json — ' +
    'complexityGate, riskHeuristics, the conflict-severity and fan-out ' +
    'knobs, and memoryPool.{staleAfterDays, growthDelta} (Story #5312)',
  keys: [
    ...TOP_LEVEL_KEYS.map((key) => ({
      path: ['planning', key],
      pruneDepth: 1,
    })),
    { path: ['planning', 'memoryPool', 'staleAfterDays'], pruneDepth: 2 },
    { path: ['planning', 'memoryPool', 'growthDelta'], pruneDepth: 2 },
  ],
});
