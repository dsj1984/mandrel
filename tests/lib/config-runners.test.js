import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRunners } from '../../.agents/scripts/lib/config/runners.js';
import {
  DEFAULT_CLOSE_RETRY,
  DEFAULT_DECOMPOSER,
} from '../../.agents/scripts/lib/config-schema.js';

describe('getRunners', () => {
  it('returns defaulted shape for null/undefined config', () => {
    for (const input of [null, undefined, {}, { orchestration: {} }]) {
      const r = getRunners(input);
      assert.deepEqual(r.epicRunner, {});
      assert.deepEqual(r.planRunner, {});
      assert.deepEqual(r.concurrency, {});
      assert.equal(r.closeRetry, DEFAULT_CLOSE_RETRY);
      assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
    }
  });

  it('passes through every populated sub-block from orchestration.runners', () => {
    const config = {
      orchestration: {
        runners: {
          epicRunner: { enabled: true, concurrencyCap: 5 },
          planRunner: { enabled: false, pollIntervalSec: 45 },
          concurrency: { waveGate: 2, commitAssertion: 3, progressReporter: 4 },
          closeRetry: { maxAttempts: 5, backoffMs: [100, 200, 400, 800, 1600] },
          decomposer: { concurrencyCap: 7 },
        },
      },
    };
    const r = getRunners(config);
    assert.deepEqual(r.epicRunner, { enabled: true, concurrencyCap: 5 });
    assert.deepEqual(r.planRunner, { enabled: false, pollIntervalSec: 45 });
    assert.deepEqual(r.concurrency, {
      waveGate: 2,
      commitAssertion: 3,
      progressReporter: 4,
    });
    assert.deepEqual(r.closeRetry, {
      maxAttempts: 5,
      backoffMs: [100, 200, 400, 800, 1600],
    });
    assert.deepEqual(r.decomposer, { concurrencyCap: 7 });
  });

  it('falls back to defaults for absent sub-blocks while honouring others', () => {
    const config = {
      orchestration: {
        runners: {
          epicRunner: { enabled: true, concurrencyCap: 2 },
        },
      },
    };
    const r = getRunners(config);
    assert.deepEqual(r.epicRunner, { enabled: true, concurrencyCap: 2 });
    assert.deepEqual(r.planRunner, {});
    assert.deepEqual(r.concurrency, {});
    assert.equal(r.closeRetry, DEFAULT_CLOSE_RETRY);
    assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
  });

  it('accepts a bare orchestration object (no top-level config wrapper)', () => {
    const orchestration = {
      runners: {
        closeRetry: { maxAttempts: 7, backoffMs: [50] },
      },
    };
    const r = getRunners(orchestration);
    assert.deepEqual(r.closeRetry, { maxAttempts: 7, backoffMs: [50] });
    assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
  });

  it('ignores legacy flat sub-blocks under orchestration (atomic cutover)', () => {
    // Story 7 removes the flat shape from the schema — `getRunners` does not
    // read `orchestration.epicRunner` etc. AJV validation rejects such configs
    // before this accessor sees them, but the contract is still that flat
    // reads return defaults, never silently surface stale data.
    const config = {
      orchestration: {
        epicRunner: { enabled: true, concurrencyCap: 99 },
        closeRetry: { maxAttempts: 99 },
      },
    };
    const r = getRunners(config);
    assert.deepEqual(r.epicRunner, {});
    assert.equal(r.closeRetry, DEFAULT_CLOSE_RETRY);
  });

  it('is re-exported from the config-resolver facade', async () => {
    const facade = await import('../../.agents/scripts/lib/config-resolver.js');
    assert.equal(typeof facade.getRunners, 'function');
    const r = facade.getRunners({
      orchestration: {
        runners: { decomposer: { concurrencyCap: 9 } },
      },
    });
    assert.deepEqual(r.decomposer, { concurrencyCap: 9 });
  });
});
