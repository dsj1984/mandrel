/* node:coverage ignore file -- AJV schema declaration (data-as-code); flat literal helpers shared by per-gate sub-schemas */

import { SHELL_INJECTION_PATTERN_STRING } from '../../config-schema-shared.js';

/**
 * Shared sub-schema fragments for `delivery.quality.gates.<tier>`.
 *
 * Every gate shares the same four-field base:
 *
 *   - `enabled`      — when `false`, the checker exits 0 with a skip line.
 *   - `baselinePath` — repo-root-relative path to the gate's baseline file.
 *   - `tolerance`    — `{ kind: 'absolute' | 'percent', value: number }`.
 *   - `floors`       — workspace-keyed `{ "*": { ... } }` absolute floor object.
 *
 * Gate-specific extras (targetDirs for crap/MI, routes for lighthouse,
 * bundles for bundle-size, coveragePath for coverage) layer on top via the
 * per-gate schemas in sibling files. Split out of
 * `config-settings-schema.js` (Story #1737) and then split again
 * (Story #2987) to keep each module under the maintainability ceiling —
 * schema literals score low on MI because they're long and flat.
 */

export const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

export const NULLABLE_NONEMPTY_SAFE_STRING = {
  type: ['string', 'null'],
  minLength: 1,
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

export const LIST_OR_EXTENDER_OF_STRINGS = {
  oneOf: [
    { type: 'array', items: { type: 'string' } },
    {
      type: 'object',
      properties: {
        append: { type: 'array', items: { type: 'string' } },
        prepend: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  ],
};

/** Object-shaped tolerance: `{ kind: 'absolute' | 'percent', value: number }`. */
export const TOLERANCE_SCHEMA = {
  type: 'object',
  required: ['kind', 'value'],
  properties: {
    kind: { type: 'string', enum: ['absolute', 'percent'] },
    value: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

/**
 * Workspace-keyed floors object — `"*"` catch-all optional.
 *
 * Each value is a per-component floor object whose keys are the metric
 * names the gate consumes. The metric name keyset is intentionally open
 * (`additionalProperties: { type: 'number' }`) so per-kind rollup keys
 * (e.g. `p95`, `perMethod`, `min`, `p50`, `score`, `errorCount`,
 * `warningCount`) flow through without each per-gate sub-schema having
 * to enumerate them. Story #1892 / Task #1894 affirmed this contract:
 * the open-keyset shape is what unblocks the per-rollup floors that
 * land in S6.
 *
 * Story #2032 / Task #2041: `*` is no longer required. When omitted, the
 * framework-default floor (lines:90 branches:85 functions:90 for
 * coverage, MI ≥ 70, CRAP ≤ 20) is injected by the resolver
 * (`lib/config/quality.js`, Story #2125). Operators may pin a
 * project-wide `*` floor explicitly when they want a value other than
 * the framework default, or declare named non-`*` workspaces for
 * monorepo consumers.
 *
 * The legacy `paths` escape-valve (Story #2029) and its per-row
 * enforcement machinery were removed in Story #2125 after Story #2119
 * verified the per-row path was decorative — the unified gate
 * (`check-baselines.js`, Epic #1943) only enforces project-wide
 * rollup floors.
 */
export const FLOORS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'number' },
  },
};

/**
 * Per-gate `components` map — name → glob list. Defaulted to
 * `{ '*': ['**'] }` at the resolver layer (see
 * `.agents/scripts/lib/baselines/components.js`); the schema only
 * constrains the shape when an operator declares it explicitly.
 *
 * Story #1892 / Task #1894: introduced as the shared seam between the
 * reader and writer so per-component rollups + floors can land
 * independently of any one gate.
 */
export const COMPONENTS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  },
};

export const GATE_BASE = {
  enabled: { type: 'boolean' },
  baselinePath: { ...SAFE_STRING, minLength: 1 },
  tolerance: TOLERANCE_SCHEMA,
  floors: FLOORS_SCHEMA,
  components: COMPONENTS_SCHEMA,
};
