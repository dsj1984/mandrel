/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE, SAFE_STRING } from './shared.js';

export const COVERAGE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    coveragePath: { ...SAFE_STRING, minLength: 1 },
    // Story #2136 / Task #2142 — bounded timeout for `npm run test:coverage`.
    // Wired into `runCapture` via `spawnSync({ timeout, killSignal })`. A
    // SIGKILL fired by the timeout is translated to exit code 124 (the GNU
    // `timeout` convention) so close-validation can branch on "hang" vs.
    // "test failed". Default 600000 (10 min) resolved in `config/quality.js`.
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};
