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
  },
  additionalProperties: false,
};
