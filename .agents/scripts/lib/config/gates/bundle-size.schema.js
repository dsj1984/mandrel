/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE } from './shared.js';

const BUNDLE_DECLARATION = {
  type: 'object',
  required: ['name', 'path', 'limit'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    limit: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

export const BUNDLE_SIZE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    bundles: { type: 'array', items: BUNDLE_DECLARATION },
  },
  additionalProperties: false,
};
