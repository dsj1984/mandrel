/* node:coverage ignore file -- AJV schema declaration (data-as-code); flat literal helpers shared by per-gate sub-schemas */

import { SHELL_INJECTION_PATTERN_STRING } from '../../config-schema-shared.js';

/** Shared sub-schema fragments for `delivery.quality.gates.<tier>`. */

export const SAFE_STRING = {
  type: 'string',
  not: { pattern: SHELL_INJECTION_PATTERN_STRING },
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

export const TOLERANCE_SCHEMA = {
  type: 'object',
  description:
    'How much a rollup may drift from the committed baseline before the gate reports a regression.',
  required: ['kind', 'value'],
  properties: {
    kind: {
      type: 'string',
      enum: ['absolute', 'percent'],
      description:
        'Whether `value` is read as raw metric units (`absolute`) or as a percentage of the baseline (`percent`).',
    },
    value: {
      type: 'number',
      minimum: 0,
      description: 'The tolerance magnitude. 0 means no drift is allowed.',
    },
  },
  additionalProperties: false,
};

/**
 * `"*"` is optional: the resolver injects the framework default when absent.
 */
export const FLOORS_SCHEMA = {
  type: 'object',
  description:
    'Workspace-keyed absolute floors: `{ "<workspace>": { "<metric>": number } }`. `"*"` is the project-wide catch-all; the metric keyset is open so per-rollup keys flow through without each gate enumerating them. Floors are absolute — unlike `tolerance`, they are enforced regardless of the baseline.',
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'number' },
  },
};

export const COMPONENTS_SCHEMA = {
  type: 'object',
  description:
    'Per-gate component map — component name to the glob list whose files roll up under it. Defaults to `{ "*": ["**"] }` at the resolver layer.',
  additionalProperties: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  },
};

/**
 * Shape is shared; each gate supplies its own `default` annotations.
 *
 * @param {{ enabled?: boolean, baselinePath?: string,
 *   tolerance?: object, floors?: object }} [defaults]
 * @returns {object} A fresh fragment.
 */
export function gateBase(defaults = {}) {
  return {
    enabled: {
      type: 'boolean',
      description:
        'When false, the checker exits 0 with a skip line and the gate is reported as `skipped`, never omitted.',
      ...(defaults.enabled === undefined ? {} : { default: defaults.enabled }),
    },
    baselinePath: {
      ...SAFE_STRING,
      minLength: 1,
      description:
        "Repo-root-relative path to the gate's committed baseline artifact.",
      ...(defaults.baselinePath === undefined
        ? {}
        : { default: defaults.baselinePath }),
    },
    tolerance: {
      ...TOLERANCE_SCHEMA,
      ...(defaults.tolerance === undefined
        ? {}
        : { default: defaults.tolerance }),
    },
    floors: {
      ...FLOORS_SCHEMA,
      ...(defaults.floors === undefined ? {} : { default: defaults.floors }),
    },
    components: COMPONENTS_SCHEMA,
  };
}
