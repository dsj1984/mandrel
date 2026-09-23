/**
 * The shared fast-check run parameters (Story #5424): pinned defaults, and
 * `MANDREL_FC_SEED` / `MANDREL_FC_NUM_RUNS` overriding both without editing a
 * test. A malformed override must fail loudly, never fall back silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_NUM_RUNS,
  DEFAULT_SEED,
  resolveRunParameters,
} from './fast-check-config.js';

describe('fast-check-config — resolveRunParameters', () => {
  it('pins the default seed and run count when nothing is set', () => {
    assert.deepEqual(resolveRunParameters({}), {
      seed: DEFAULT_SEED,
      numRuns: DEFAULT_NUM_RUNS,
    });
  });

  it('treats an empty override as unset', () => {
    assert.deepEqual(
      resolveRunParameters({ MANDREL_FC_SEED: ' ', MANDREL_FC_NUM_RUNS: '' }),
      { seed: DEFAULT_SEED, numRuns: DEFAULT_NUM_RUNS },
    );
  });

  it('lets the env override both parameters', () => {
    assert.deepEqual(
      resolveRunParameters({
        MANDREL_FC_SEED: '-7',
        MANDREL_FC_NUM_RUNS: '500',
      }),
      { seed: -7, numRuns: 500 },
    );
  });

  for (const [name, value] of [
    ['MANDREL_FC_SEED', 'abc'],
    ['MANDREL_FC_SEED', '1.5'],
    ['MANDREL_FC_NUM_RUNS', '0'],
    ['MANDREL_FC_NUM_RUNS', 'many'],
  ]) {
    it(`rejects ${name}=${value} instead of falling back`, () => {
      assert.throws(
        () => resolveRunParameters({ [name]: value }),
        new RegExp(`${name}=${value.replace('.', '\\.')}`),
      );
    });
  }
});
