/* node:coverage ignore file -- AJV schema declaration (data-as-code); thin aggregator over per-gate sub-schemas */

import { BUNDLE_SIZE_GATE } from './bundle-size.schema.js';
import { COVERAGE_GATE } from './coverage.schema.js';
import { CRAP_GATE } from './crap.schema.js';
import { DUPLICATION_GATE } from './duplication.schema.js';
import { MAINTAINABILITY_GATE } from './maintainability.schema.js';
import { MUTATION_GATE } from './mutation.schema.js';

/** Composite `delivery.quality.gates` schema — closed shape. */
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
