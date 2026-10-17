// lib/migrations/steps/2.91.0-retire-duplication-formats.js
/**
 * Strip `delivery.quality.gates.duplication.formats`: the jscpd formats are
 * now derived from the scorable-extension list every other gate scores, and
 * the gate block is `additionalProperties: false`. An emptied `duplication`
 * block is pruned; its parents keep their other gates.
 */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireDuplicationFormats = createRetireAgentrcKeyStep({
  version: '2.91.0',
  description:
    'strip retired delivery.quality.gates.duplication.formats from ' +
    '.agentrc.json and .agentrc.local.json (the jscpd formats now derive ' +
    'from the scorable-extension list — Story #5738)',
  keys: [
    {
      path: ['delivery', 'quality', 'gates', 'duplication', 'formats'],
      pruneDepth: 1,
    },
  ],
});
