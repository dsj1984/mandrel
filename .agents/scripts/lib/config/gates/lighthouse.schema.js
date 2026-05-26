/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE, NULLABLE_NONEMPTY_SAFE_STRING } from './shared.js';

const LIGHTHOUSE_ROUTE = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
    formFactor: { type: 'string', enum: ['mobile', 'desktop'] },
  },
  additionalProperties: false,
};

export const LIGHTHOUSE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    baseUrl: NULLABLE_NONEMPTY_SAFE_STRING,
    routes: { type: 'array', items: LIGHTHOUSE_ROUTE },
  },
  additionalProperties: false,
};
