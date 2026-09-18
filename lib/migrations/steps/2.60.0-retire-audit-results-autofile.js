// lib/migrations/steps/2.60.0-retire-audit-results-autofile.js
/**
 * Strip `delivery.feedbackLoop.auditResultsAutoFile`: it had no reader. The
 * sibling `retroProposals` is live and stays.
 */

import { createRetireAgentrcKeyStep } from '../helpers/retire-agentrc-key.js';

export const retireAuditResultsAutoFile = createRetireAgentrcKeyStep({
  version: '2.60.0',
  description:
    'strip the retired delivery.feedbackLoop.auditResultsAutoFile key from ' +
    '.agentrc.json — its graduator was deleted, so the toggle had no ' +
    'runtime reader (Story #5366)',
  keys: [
    {
      path: ['delivery', 'feedbackLoop', 'auditResultsAutoFile'],
      pruneDepth: 2,
    },
  ],
});
