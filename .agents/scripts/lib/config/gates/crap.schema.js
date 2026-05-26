/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import {
  GATE_BASE,
  LIST_OR_EXTENDER_OF_STRINGS,
  SAFE_STRING,
} from './shared.js';

export const CRAP_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    newMethodCeiling: { type: 'integer', minimum: 1 },
    requireCoverage: { type: 'boolean' },
    friction: {
      type: 'object',
      properties: { markerKey: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    refreshTag: { ...SAFE_STRING, minLength: 1 },
    // Story #2165 — bounded timeout for `npm run crap:update` spawned by the
    // baseline-attribution refresh path. Mirrors `coverage.timeoutMs` (Story
    // #2142): a SIGKILL fired at the budget boundary maps to exit code 124
    // so the close orchestrator can flip the Story to `agent::blocked`.
    refreshTimeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};
