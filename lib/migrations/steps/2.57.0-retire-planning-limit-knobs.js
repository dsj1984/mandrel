// lib/migrations/steps/2.57.0-retire-planning-limit-knobs.js
/**
 * Strip the retired `planning.*` limit knobs; `planning` is optional, so
 * emptied blocks are pruned.
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
