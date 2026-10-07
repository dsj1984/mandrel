/**
 * The adapter registry. Each adapter is `{ id, category, applies(ctx),
 * extract(ctx) }`; adding a surface is one module plus one line here.
 *
 * @module lib/audit-exceptions/adapters
 */

import { ciGates } from './ci-gates.js';
import { codeAllowlists } from './code-allowlists.js';
import { dependencyAudit } from './dependency-audit.js';
import { dependencyPatches } from './dependency-patches.js';
import { dependencyPins } from './dependency-pins.js';
import { dependencyPolicy } from './dependency-policy.js';
import { inlineSuppressions } from './inline-suppressions.js';
import { testSkips } from './test-skips.js';
import { toolConfig } from './tool-config.js';

export const ADAPTERS = Object.freeze([
  inlineSuppressions,
  toolConfig,
  dependencyPins,
  dependencyPatches,
  dependencyPolicy,
  dependencyAudit,
  ciGates,
  testSkips,
  codeAllowlists,
]);
