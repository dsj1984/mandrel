// lib/migrations/steps/2.11.0-retire-max-seed-words.js
/**
 * Strip `planning.complexityGate.maxSeedWords`, pruning emptied optional
 * ancestors.
 */

import {
  AGENTRC_BASE_FILENAME,
  createRetireAgentrcKeyStep,
} from '../helpers/retire-agentrc-key.js';

export const retireMaxSeedWords = createRetireAgentrcKeyStep({
  version: '2.11.0',
  description:
    'strip retired planning.complexityGate.maxSeedWords from .agentrc.json ' +
    '(complexity routes on Story shape, never seed word count — Story #4722)',
  filenames: [AGENTRC_BASE_FILENAME],
  keys: [
    { path: ['planning', 'complexityGate', 'maxSeedWords'], pruneDepth: 2 },
  ],
});
