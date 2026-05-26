/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE, NULLABLE_NONEMPTY_SAFE_STRING } from './shared.js';

export const MUTATION_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    strykerConfigPath: NULLABLE_NONEMPTY_SAFE_STRING,
  },
  additionalProperties: false,
};
