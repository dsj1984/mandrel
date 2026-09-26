/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { COVERAGE_GATE_DEFAULTS } from '../quality.js';
import { gateBase, SAFE_STRING } from './shared.js';

export const COVERAGE_GATE = {
  type: 'object',
  description:
    'Line/branch/function coverage ratchet, read from the Istanbul JSON summary the project test run emits.',
  properties: {
    ...gateBase({
      enabled: COVERAGE_GATE_DEFAULTS.enabled,
      baselinePath: COVERAGE_GATE_DEFAULTS.baselinePath,
      tolerance: COVERAGE_GATE_DEFAULTS.tolerance,
      floors: COVERAGE_GATE_DEFAULTS.floors,
    }),
    coveragePath: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        'Repo-relative path to the Istanbul `coverage-final.json` the capture step writes and the gate reads.',
      default: COVERAGE_GATE_DEFAULTS.coveragePath,
    },
    captureScope: {
      type: 'string',
      enum: ['full', 'affected'],
      description:
        'What coverage-capture runs. `full` (default) runs `npm run test:coverage`. `affected` runs the consumer-owned `npm run test:coverage:affected` with the base ref in `MANDREL_COVERAGE_BASE_REF`, merges its rows over the prior artifact and stamps it `affected`; baseline rows the scoped run did not measure are treated as unmeasured, never removed. Falls back to `full` with a warning when the script is absent. Meant for consumers whose CI already enforces coverage on the full suite.',
      default: COVERAGE_GATE_DEFAULTS.captureScope,
    },
  },
  additionalProperties: false,
};
