// lib/migrations/steps/2.1.0-retire-verify-concurrency-cap.js
/** Strip `delivery.deliverRunner.verifyConcurrencyCap`. */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireVerifyConcurrencyCap = createRetireAgentrcKeyStep({
  version: '2.1.0',
  description:
    'strip retired delivery.deliverRunner.verifyConcurrencyCap from ' +
    '.agentrc.json and .agentrc.local.json',
  keys: [
    {
      path: ['delivery', 'deliverRunner', 'verifyConcurrencyCap'],
      pruneDepth: 1,
    },
  ],
});
