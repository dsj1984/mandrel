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
    // Story #3217 — glob patterns matched against canonicalised repo-relative
    // paths to exclude files from MI discovery before scoring. Orthogonal to
    // `components` (grouping). Absent/empty preserves existing behaviour.
    ignoreGlobs: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};
