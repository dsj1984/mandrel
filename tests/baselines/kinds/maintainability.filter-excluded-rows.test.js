import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  filterExcludedRows,
  MAINTAINABILITY_EXCLUSIONS,
} from '../../../.agents/scripts/lib/baselines/kinds/maintainability.js';

describe('filterExcludedRows', () => {
  it('passes through rows for files outside the allowlist', () => {
    const rows = [
      { path: '.agents/scripts/lib/orchestration/retro-runner.js', mi: 87.2 },
      { path: 'tests/lib/orchestration/retro-runner.test.js', mi: 91.8 },
    ];
    assert.deepEqual(filterExcludedRows(rows), rows);
  });

  it('drops rows whose path is on the explicit exclusions allowlist', () => {
    const sample = [...MAINTAINABILITY_EXCLUSIONS][0];
    const rows = [
      { path: sample, mi: 0 },
      { path: '.agents/scripts/lib/maintainability-engine.js', mi: 80 },
    ];
    assert.deepEqual(filterExcludedRows(rows), [
      { path: '.agents/scripts/lib/maintainability-engine.js', mi: 80 },
    ]);
  });

  it('drops mi=0 rows defensively even when not on the allowlist', () => {
    const rows = [
      { path: '.agents/scripts/some-future-file.js', mi: 0 },
      { path: '.agents/scripts/scorable.js', mi: 70.5 },
    ];
    assert.deepEqual(filterExcludedRows(rows), [
      { path: '.agents/scripts/scorable.js', mi: 70.5 },
    ]);
  });

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(filterExcludedRows(null), []);
    assert.deepEqual(filterExcludedRows(undefined), []);
    assert.deepEqual(filterExcludedRows('rows'), []);
  });

  it('treats missing mi as not-zero so partial rows pass through', () => {
    const rows = [{ path: '.agents/scripts/partial.js' }];
    assert.deepEqual(filterExcludedRows(rows), rows);
  });
});
