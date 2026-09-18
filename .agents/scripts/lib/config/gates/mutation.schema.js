/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase } from './shared.js';

export const MUTATION_GATE = {
  type: 'object',
  description:
    'Stryker mutation-score ratchet. Off in practice for most consumers — the baseline kind is registered but no framework path runs Stryker.',
  properties: {
    ...gateBase({
      enabled: true,
      baselinePath: 'baselines/mutation.json',
      tolerance: { kind: 'percent', value: 0 },
      floors: { '*': { score: 60 } },
    }),
  },
  additionalProperties: false,
};
