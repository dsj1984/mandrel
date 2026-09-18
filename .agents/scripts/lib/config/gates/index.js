/* node:coverage ignore file -- AJV schema declaration (data-as-code); thin aggregator over per-gate sub-schemas */

import { BUNDLE_SIZE_GATE } from './bundle-size.schema.js';
import { COVERAGE_GATE } from './coverage.schema.js';
import { CRAP_GATE } from './crap.schema.js';
import { DUPLICATION_GATE } from './duplication.schema.js';
import { MAINTAINABILITY_GATE } from './maintainability.schema.js';
import { MUTATION_GATE } from './mutation.schema.js';

/**
 * Composite `delivery.quality.gates` schema — closed shape.
 *
 * Split from the former `lib/config-gates-schema.js` aggregate
 * (Story #2987) into per-gate sub-schema files under
 * `lib/config/gates/`. Shared fragments (`gateBase()`, `SAFE_STRING`,
 * `TOLERANCE_SCHEMA`, `FLOORS_SCHEMA`, `COMPONENTS_SCHEMA`,
 * `LIST_OR_EXTENDER_OF_STRINGS`) live
 * in `./shared.js`. Each per-gate file exports one sub-schema literal
 * with the gate-specific extras layered on top of `gateBase()`, passing
 * that gate's own base-field defaults (Story #5007).
 */
export const GATES_SCHEMA = {
  type: 'object',
  description:
    'The six quality gates, each sharing the `{ enabled, baselinePath, tolerance, floors, components }` base.',
  properties: {
    coverage: COVERAGE_GATE,
    crap: CRAP_GATE,
    maintainability: MAINTAINABILITY_GATE,
    mutation: MUTATION_GATE,
    'bundle-size': BUNDLE_SIZE_GATE,
    duplication: DUPLICATION_GATE,
  },
  additionalProperties: false,
};
