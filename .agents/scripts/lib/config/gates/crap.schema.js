/* node:coverage ignore file -- AJV schema declaration (data-as-code) */

import { CRAP_GATE_DEFAULTS } from '../quality.js';
import { INCREMENTAL_COVERAGE_SCHEMA } from './crap-incremental-coverage.schema.js';
import { gateBase, LIST_OR_EXTENDER_OF_STRINGS } from './shared.js';

export const CRAP_GATE = {
  type: 'object',
  description:
    'CRAP (Change Risk Anti-Pattern) ratchet — per-method cyclomatic complexity joined against per-method coverage.',
  properties: {
    ...gateBase({
      enabled: CRAP_GATE_DEFAULTS.enabled,
      baselinePath: CRAP_GATE_DEFAULTS.baselinePath,
      tolerance: CRAP_GATE_DEFAULTS.tolerance,
      floors: CRAP_GATE_DEFAULTS.floors,
    }),
    targetDirs: {
      ...LIST_OR_EXTENDER_OF_STRINGS,
      description:
        "Directories whose JS sources the CRAP gate scores. Mandrel ships a `src/`-centric default; projects whose executable code lives elsewhere (e.g. this repo's `.agents/scripts/`) override here. The framework default is intentionally not auto-discovered, so an override is the explicit, auditable signal.",
      default: [...CRAP_GATE_DEFAULTS.targetDirs],
    },
    newMethodCeiling: {
      type: 'integer',
      minimum: 1,
      description:
        'Hard CRAP ceiling applied to a method the diff introduces. A new method above it fails the gate regardless of the baseline.',
      default: CRAP_GATE_DEFAULTS.newMethodCeiling,
    },
    requireCoverage: {
      type: 'boolean',
      description:
        'When true, the gate refuses to score without a coverage artifact rather than silently reporting complexity-only rows.',
      default: CRAP_GATE_DEFAULTS.requireCoverage,
    },
    // Story #4775 — fail-closed floor on the per-method coverage JOIN.
    minMethodResolutionRate: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Fail-closed floor on the per-method coverage JOIN (Story #4775): the fraction of methods that must resolve a coverage entry, counted only over files that HAVE one, before `update-crap-baseline.js` will persist. A broken join is silent by construction — unresolved methods are simply absent — so the updater refuses rather than writing a thin baseline and logging it as success. Not enforced below 25 joinable methods, where a diff-scoped run’s rate is noise. Default 0.75; a healthy repo resolves ~98%.',
    },
    ignoreGlobs: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'Minimatch glob patterns matched against the canonicalised repo-relative path of each discovered file. Files matching any pattern are excluded from CRAP discovery before scoring. Orthogonal to `components` (grouping) — a file excluded here never appears in any component bucket. Absent or empty preserves the existing IGNORED_DIRS-only behaviour (Story #3217).',
      default: [...CRAP_GATE_DEFAULTS.ignoreGlobs],
    },
    incrementalCoverage: INCREMENTAL_COVERAGE_SCHEMA,
  },
  additionalProperties: false,
};
