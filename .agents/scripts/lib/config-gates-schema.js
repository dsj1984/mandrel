/* node:coverage ignore file -- AJV schema declaration (data-as-code); per-gate sub-schemas are flat literals with no business logic to test */

import { SHELL_INJECTION_PATTERN_STRING } from './config-schema-shared.js';

/**
 * Per-gate sub-schemas for `delivery.quality.gates.<tier>` (Story #1737).
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
 * per-gate schemas below. Split out of `config-settings-schema.js` to
 * keep the parent module under the maintainability ceiling — schema
 * literals score low on MI because they're long and flat.
 */

const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
};

const NULLABLE_NONEMPTY_SAFE_STRING = {
  type: ['string', 'null'],
  minLength: 1,
  not: { type: 'string', pattern: SHELL_INJECTION_PATTERN_STRING },
};

const LIST_OR_EXTENDER_OF_STRINGS = {
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
const TOLERANCE_SCHEMA = {
  type: 'object',
  required: ['kind', 'value'],
  properties: {
    kind: { type: 'string', enum: ['absolute', 'percent'] },
    value: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

/**
 * Workspace-keyed floors object — `"*"` catch-all required.
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
 * Story #2029 reserves the additional key `paths` for per-path
 * escape-valve overrides. Each entry under `floors.paths.<repo-path>`
 * carries a mandatory `follow_up` issue/URL reference plus optional
 * relaxed values for coverage axes / maintainability / crap. The
 * runtime loader in `lib/quality-floors.js` treats `paths` as a
 * reserved key (not a workspace) and emits a per-record override Map.
 */
const PATH_OVERRIDE_ENTRY = {
  type: 'object',
  required: ['follow_up'],
  properties: {
    lines: { type: 'number' },
    branches: { type: 'number' },
    functions: { type: 'number' },
    maintainability: { type: 'number' },
    crap: { type: 'number' },
    follow_up: { type: 'string', pattern: '^#\\d+$|^https?://' },
  },
  additionalProperties: false,
};

/**
 * Story #2032 / Task #2041: `*` is no longer required. When omitted, the
 * framework-default floor (e.g. MI ≥ 70 for maintainability) applies
 * universally and `floors.paths` carries the per-file escape valves.
 * Operators may still pin a project-wide `*` floor explicitly when they
 * want a value other than the framework default.
 */
const FLOORS_SCHEMA = {
  type: 'object',
  properties: {
    paths: {
      type: 'object',
      additionalProperties: PATH_OVERRIDE_ENTRY,
    },
  },
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
const COMPONENTS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  },
};

const GATE_BASE = {
  enabled: { type: 'boolean' },
  baselinePath: { ...SAFE_STRING, minLength: 1 },
  tolerance: TOLERANCE_SCHEMA,
  floors: FLOORS_SCHEMA,
  components: COMPONENTS_SCHEMA,
};

const LINT_GATE = {
  type: 'object',
  properties: { ...GATE_BASE },
  additionalProperties: false,
};

const COVERAGE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    coveragePath: { ...SAFE_STRING, minLength: 1 },
  },
  additionalProperties: false,
};

const CRAP_GATE = {
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
  },
  additionalProperties: false,
};

const MAINTAINABILITY_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    targetDirs: LIST_OR_EXTENDER_OF_STRINGS,
  },
  additionalProperties: false,
};

const MUTATION_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    strykerConfigPath: NULLABLE_NONEMPTY_SAFE_STRING,
  },
  additionalProperties: false,
};

const LIGHTHOUSE_ROUTE = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
    formFactor: { type: 'string', enum: ['mobile', 'desktop'] },
  },
  additionalProperties: false,
};

const LIGHTHOUSE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    baseUrl: NULLABLE_NONEMPTY_SAFE_STRING,
    routes: { type: 'array', items: LIGHTHOUSE_ROUTE },
  },
  additionalProperties: false,
};

const BUNDLE_DECLARATION = {
  type: 'object',
  required: ['name', 'path', 'limit'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    limit: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const BUNDLE_SIZE_GATE = {
  type: 'object',
  properties: {
    ...GATE_BASE,
    bundles: { type: 'array', items: BUNDLE_DECLARATION },
  },
  additionalProperties: false,
};

/** Composite `delivery.quality.gates` schema — closed shape. */
export const GATES_SCHEMA = {
  type: 'object',
  properties: {
    lint: LINT_GATE,
    coverage: COVERAGE_GATE,
    crap: CRAP_GATE,
    maintainability: MAINTAINABILITY_GATE,
    mutation: MUTATION_GATE,
    lighthouse: LIGHTHOUSE_GATE,
    'bundle-size': BUNDLE_SIZE_GATE,
  },
  additionalProperties: false,
};
