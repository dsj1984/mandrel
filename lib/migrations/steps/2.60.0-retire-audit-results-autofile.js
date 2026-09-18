// lib/migrations/steps/2.60.0-retire-audit-results-autofile.js
/**
 * Story #5366 — strip the retired `delivery.feedbackLoop.auditResultsAutoFile`
 * key from a consumer's config.
 *
 * The audit-results graduator this toggle switched was deleted two releases
 * ago, so the key had no runtime reader left: Story #5341's flip of its
 * default from `true` to `false` changed nothing at all, because nothing read
 * either value. A toggle with no reader is worse than no toggle — it reads as
 * a live control, and a consumer that set it was configuring nothing.
 *
 * `delivery.feedbackLoop` carries `additionalProperties: false`, so a config
 * that still sets the key fails AJV validation outright on upgrade rather than
 * warning. That is what makes this a migration rather than a docs change.
 *
 * Both config surfaces are swept: `config-resolver.js` deep-merges
 * `.agentrc.local.json` over `.agentrc.json` **before** the AJV gate runs, so
 * a key surviving in the gitignored overlay fails exactly as a base one would.
 *
 * Pruning: `pruneDepth: 2` prunes an emptied `feedbackLoop` and then an
 * emptied `delivery`, both of which are optional. The sibling `retroProposals`
 * toggle is deliberately untouched — it has a live reader — so a consumer who
 * set both keeps its block.
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
