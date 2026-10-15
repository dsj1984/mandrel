/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase } from './shared.js';

export const MUTATION_GATE = {
  type: 'object',
  description:
    'Stryker mutation-score ratchet. Disabled by default: no framework path runs Stryker, so enable it only alongside a consumer-provided Stryker run that writes the mutation report the baseline is scored from.',
  properties: {
    ...gateBase({
      enabled: false,
      baselinePath: 'baselines/mutation.json',
      tolerance: { kind: 'percent', value: 0 },
      floors: { '*': { score: 60 } },
    }),
  },
  additionalProperties: false,
};
