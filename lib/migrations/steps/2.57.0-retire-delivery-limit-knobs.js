// lib/migrations/steps/2.57.0-retire-delivery-limit-knobs.js
/**
 * Strip the retired `delivery.*` limit knobs; `delivery` is optional, so
 * emptied ancestors are pruned up to it.
 */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireDeliveryLimitKnobs = createRetireAgentrcKeyStep({
  version: '2.57.0',
  description:
    'strip the retired delivery.* limit knobs from .agentrc.json — ' +
    'routing.freshCriticSampleRate, codeReview.maxFixScopeFiles, signals, ' +
    'and quality.codingGuardrails.cyclomaticMustFix (Story #5313)',
  keys: [
    { path: ['delivery', 'routing', 'freshCriticSampleRate'], pruneDepth: 2 },
    { path: ['delivery', 'codeReview', 'maxFixScopeFiles'], pruneDepth: 2 },
    { path: ['delivery', 'signals'], pruneDepth: 1 },
    {
      path: ['delivery', 'quality', 'codingGuardrails', 'cyclomaticMustFix'],
      pruneDepth: 3,
    },
  ],
});
