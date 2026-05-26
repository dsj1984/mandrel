/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE } from './shared.js';

export const LINT_GATE = {
  type: 'object',
  properties: { ...GATE_BASE },
  additionalProperties: false,
};
