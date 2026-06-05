/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { GATE_BASE, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

/**
 * `delivery.quality.gates.duplication` — code-duplication (DRY) gate
 * (Story #3664). Shares the four-field `GATE_BASE` (enabled, baselinePath,
 * tolerance, floors, components) and adds the scan-scope extras: the
 * `targetDirs` the duplication scanner walks, a bounded refresh timeout
 * mirroring crap/MI, and `ignoreGlobs` to exclude files from the scan.
 */
export const DUPLICATION_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
    // Bounded timeout (ms) for the `npm run duplication:update` scanner spawn.
    // Mirrors `crap.refreshTimeoutMs` / `maintainability.refreshTimeoutMs`.
    refreshTimeoutMs: { type: 'integer', minimum: 1 },
    // Glob patterns matched against canonicalised repo-relative paths to
    // exclude files from duplication discovery before scoring. Orthogonal to
    // `components` (grouping). Absent/empty preserves existing behaviour.
    ignoreGlobs: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
};
