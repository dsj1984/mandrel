/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

export const MAINTAINABILITY_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    // Story #2165 — bounded timeout for `npm run maintainability:update`
    // spawned by the baseline-attribution refresh path. Mirrors
    // `coverage.timeoutMs` (Story #2142).
    refreshTimeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};
