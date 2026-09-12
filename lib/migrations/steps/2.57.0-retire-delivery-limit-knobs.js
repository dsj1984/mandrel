// lib/migrations/steps/2.57.0-retire-delivery-limit-knobs.js
/**
 * Story #5313 — the delivery diet. Strip the retired `delivery.*` keys from a
 * consumer's config:
 *
 *   - `delivery.routing.freshCriticSampleRate` — the maker-checker sampling
 *     floor is gone; the standard profile routes purely off the derived
 *     change level (high or underivable → fresh critic, low → inline).
 *   - `delivery.codeReview.maxFixScopeFiles` — the auto-fix file-count
 *     ceiling bounded remediation by count rather than by risk.
 *   - `delivery.signals` (`rework.editsPerFile`, `retry.repeatCount`) — the
 *     detector thresholds and `SIGNALS_DEFAULTS` are retired wholesale.
 *   - `delivery.quality.codingGuardrails.cyclomaticMustFix` — the cyclomatic
 *     ratchet keeps its fixed ceiling of 12; `cyclomaticFlag` stays advisory.
 *
 * Every affected block carries `additionalProperties: false`, so a config
 * still setting any of them fails validation on upgrade rather than warning.
 * It sweeps **both** config surfaces (`.agentrc.json` and the gitignored
 * `.agentrc.local.json`), because `config-resolver.js` deep-merges the
 * overlay before the AJV gate runs.
 *
 * Pruning: `delivery.signals` is removed whole (`pruneDepth: 1` prunes an
 * emptied `delivery`); the nested keys prune their emptied ancestors up to
 * `delivery` itself. `delivery` is optional, so an emptied block is removed
 * rather than left as `{}`. A sibling key that survives keeps its block.
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
