/* node:coverage ignore file -- AJV schema declaration (data-as-code); thin aggregator over per-gate sub-schemas */

import { BUNDLE_SIZE_GATE } from './bundle-size.schema.js';
import { COVERAGE_GATE } from './coverage.schema.js';
import { CRAP_GATE } from './crap.schema.js';
import { DUPLICATION_GATE } from './duplication.schema.js';
import { LIGHTHOUSE_GATE } from './lighthouse.schema.js';
import { LINT_GATE } from './lint.schema.js';
import { MAINTAINABILITY_GATE } from './maintainability.schema.js';
import { MUTATION_GATE } from './mutation.schema.js';

/**
 * Composite `delivery.quality.gates` schema — closed shape.
 *
 * Split from the former `lib/config-gates-schema.js` aggregate
 * (Story #2987) into per-gate sub-schema files under
 * `lib/config/gates/`. Shared fragments (`GATE_BASE`, `SAFE_STRING`,
 * `TOLERANCE_SCHEMA`, `FLOORS_SCHEMA`, `COMPONENTS_SCHEMA`,
 * `LIST_OR_EXTENDER_OF_STRINGS`, `NULLABLE_NONEMPTY_SAFE_STRING`) live
 * in `./shared.js`. Each per-gate file exports one sub-schema literal
 * with the gate-specific extras layered on top of `GATE_BASE`.
 */
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
    duplication: DUPLICATION_GATE,
  },
  additionalProperties: false,
};
