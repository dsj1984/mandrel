/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

export const DUPLICATION_GATE = {
  type: 'object',
  description:
    'Code-duplication (DRY) gate (Story #3664). Shares the gate base and adds the scan-scope extras: the `targetDirs` the duplication scanner walks, the jscpd `formats` it reads there, and `ignoreGlobs` to exclude files from the scan.',
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
        "Directories whose sources — the languages `formats` selects — the duplication (DRY) gate scans for copy-paste clones. Mandrel ships a `src/`-centric default; projects whose executable code lives elsewhere (e.g. this repo's `.agents/scripts/`) override here. The framework default is intentionally not auto-discovered, so an override is the explicit, auditable signal (Story #3664).",
      default: ['src'],
    },
    formats: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description:
        "jscpd format names the duplication (DRY) gate scans under `targetDirs`. The default covers JavaScript, JSX, TypeScript and TSX; jscpd's `javascript` format alone reads only `.js`/`.es`/`.es6`/`.mjs`/`.cjs`. Names are jscpd's own vocabulary and are not restricted here. Widening the set adds rows, so re-seat the baseline with `npm run duplication:reanchor` after changing it.",
      default: ['javascript', 'jsx', 'typescript', 'tsx'],
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
