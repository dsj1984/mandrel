/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

export const DUPLICATION_GATE = {
  type: 'object',
  description:
    'Code-duplication (DRY) gate (Story #3664). Shares the gate base and adds the scan-scope extras: the `targetDirs` the duplication scanner walks and `ignoreGlobs` to exclude files from the scan.',
  properties: {
    ...gateBase({
      enabled: false,
      baselinePath: 'baselines/duplication.json',
      tolerance: { kind: 'absolute', value: 1 },
      floors: { '*': { percentage: 25 } },
    }),
    targetDirs: {
      ...LIST_OR_EXTENDER_OF_STRINGS,
      description:
        "Directories whose JS sources the duplication (DRY) gate scans for copy-paste clones. Mandrel ships a `src/`-centric default; projects whose executable code lives elsewhere (e.g. this repo's `.agents/scripts/`) override here. The framework default is intentionally not auto-discovered, so an override is the explicit, auditable signal (Story #3664).",
      default: ['src'],
    },
    ignoreGlobs: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Minimatch glob patterns matched against the canonicalised repo-relative path of each discovered file. Files matching any pattern are excluded from duplication discovery before scanning. Orthogonal to `components` (grouping). Absent or empty preserves the existing behaviour (Story #3664).',
      default: [],
    },
  },
  additionalProperties: false,
};
