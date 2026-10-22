/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { gateBase, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

export const DUPLICATION_GATE = {
  type: 'object',
  description:
    'Code-duplication (DRY) gate (Story #3664). Shares the gate base and adds the scan-scope extras: the `targetDirs` the duplication scanner walks and `ignoreGlobs` to exclude files from the scan. The jscpd formats it reads always include the scorable-extension list every other gate scores (JavaScript, JSX, TypeScript, TSX, Story #5738); `additionalFormats` can only extend that list (Story #5849).',
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
        "Directories whose scorable sources (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.mts`, `.cts`), plus the files of any `additionalFormats`, the duplication (DRY) gate scans for copy-paste clones. Mandrel ships a `src/`-centric default; projects whose executable code lives elsewhere (e.g. this repo's `.agents/scripts/`) override here. The framework default is intentionally not auto-discovered, so an override is the explicit, auditable signal (Story #3664).",
      default: ['src'],
    },
    // No `formats`: the scorable jscpd formats derive from `jscpdFormatsFor()`,
    // and the 2.91.0 migration `retire-duplication-formats` moves the old
    // key's other languages into `additionalFormats` before stripping it.
    additionalFormats: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Extra jscpd format names (e.g. `python`, `go`) the duplication gate scans on top of the scorable formats it always reads. Extend-only: the scorable formats cannot be removed, and naming one here is a no-op. An unknown format name fails the scan rather than measuring nothing. The CRAP, MI, coverage and native-review gates still score only the scorable list (Story #5849).',
      default: [],
    },
    ignoreGlobs: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Minimatch glob patterns matched against the canonicalised repo-relative path of each discovered file. Files matching any pattern are excluded from duplication discovery before scanning. Orthogonal to `components` (grouping). Absent or empty preserves the existing behaviour (Story #3664). This is the lever for scanning fewer files.',
      default: [],
    },
  },
  additionalProperties: false,
};
