/**
 * Regression test for Story #2573.
 *
 * `.agents/full-agentrc.json` is the exhaustive editor reference that
 * consumers copy-paste from. If any `delivery.quality.gates.<kind>.floors`
 * block declares an axis that does not exist in the kind's v2 rollup
 * envelope, `check-baselines.js` fails closed with EXIT_CONFIG and the
 * example actively misleads. This test loads the shipped config and
 * asserts every floor axis is a real key in the corresponding kind's
 * aggregate output.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as bundleSizeKind from '../.agents/scripts/lib/baselines/kinds/bundle-size.js';
import * as coverageKind from '../.agents/scripts/lib/baselines/kinds/coverage.js';
import * as crapKind from '../.agents/scripts/lib/baselines/kinds/crap.js';
import * as lighthouseKind from '../.agents/scripts/lib/baselines/kinds/lighthouse.js';
import * as lintKind from '../.agents/scripts/lib/baselines/kinds/lint.js';
import * as maintainabilityKind from '../.agents/scripts/lib/baselines/kinds/maintainability.js';
import * as mutationKind from '../.agents/scripts/lib/baselines/kinds/mutation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const KINDS = {
  lint: lintKind,
  coverage: coverageKind,
  crap: crapKind,
  maintainability: maintainabilityKind,
  mutation: mutationKind,
  lighthouse: lighthouseKind,
  'bundle-size': bundleSizeKind,
};

function aggregateAxisKeys(kindModule) {
  const rollup = kindModule.rollup([], []);
  const wildcard = rollup?.['*'];
  assert.ok(
    wildcard && typeof wildcard === 'object',
    `kind ${kindModule.name} rollup must produce a '*' aggregate`,
  );
  return new Set(Object.keys(wildcard));
}

describe('full-agentrc.json floor axes match v2 envelope shapes', () => {
  const raw = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, '.agents/full-agentrc.json'), 'utf8'),
  );
  const gates = raw?.delivery?.quality?.gates ?? {};

  for (const [kindName, kindConfig] of Object.entries(gates)) {
    const kindModule = KINDS[kindName];
    if (!kindModule) continue;
    const floors = kindConfig?.floors ?? {};
    const availableAxes = aggregateAxisKeys(kindModule);

    for (const [component, floor] of Object.entries(floors)) {
      if (!floor || typeof floor !== 'object') continue;
      for (const [axis, target] of Object.entries(floor)) {
        if (typeof target !== 'number' || !Number.isFinite(target)) continue;
        it(`gates.${kindName}.floors['${component}'].${axis} is a real axis`, () => {
          assert.ok(
            availableAxes.has(axis),
            `floor axis '${axis}' not in ${kindName} rollup; ` +
              `available: ${[...availableAxes].join(', ')}`,
          );
        });
      }
    }
  }
});
