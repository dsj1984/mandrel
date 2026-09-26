/**
 * coverage-timeout.test.js — `delivery.quality.gates.coverage.timeoutMs`
 * re-admitted as a configurable kill bound (Story #5485).
 *
 * Covers: the AJV bounds (positive integer in [60000, 7200000]), the resolved
 * value through `getQuality`, the 600000 default, and that setting it no
 * longer draws the unknown-key warning.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { COVERAGE_TIMEOUT_BOUNDS } from '../../.agents/scripts/lib/config/gates/coverage.schema.js';
import {
  COVERAGE_GATE_DEFAULTS,
  getQuality,
} from '../../.agents/scripts/lib/config/quality.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-schema.js';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

const PATHS = { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' };

function withCoverage(coverage) {
  return {
    project: { paths: PATHS },
    delivery: { quality: { gates: { coverage } } },
  };
}

describe('coverage.timeoutMs — schema', () => {
  it('accepts a positive integer inside the bounds', () => {
    const validate = getAgentrcValidator();
    for (const timeoutMs of [60_000, 1_800_000, 7_200_000]) {
      assert.equal(
        validate(withCoverage({ timeoutMs })),
        true,
        JSON.stringify(validate.errors),
      );
    }
  });

  it('rejects a value outside the bounds or not an integer, naming the key', () => {
    const validate = getAgentrcValidator();
    for (const timeoutMs of [0, 59_999, 7_200_001, 1.5, '600000']) {
      assert.equal(
        validate(withCoverage({ timeoutMs })),
        false,
        `timeoutMs=${timeoutMs} must be rejected`,
      );
      assert.ok(
        validate.errors.some((e) => e.instancePath.endsWith('/timeoutMs')),
        JSON.stringify(validate.errors),
      );
    }
  });

  it('publishes the bounds the schema enforces', () => {
    assert.deepEqual(
      { ...COVERAGE_TIMEOUT_BOUNDS },
      { min: 60_000, max: 7_200_000 },
    );
  });
});

describe('coverage.timeoutMs — resolver', () => {
  let warnings;
  let originalWarn;

  beforeEach(() => {
    warnings = [];
    originalWarn = Logger.warn;
    Logger.warn = (m) => warnings.push(String(m));
  });

  afterEach(() => {
    Logger.warn = originalWarn;
  });

  it('resolves the configured value', () => {
    const quality = getQuality(withCoverage({ timeoutMs: 1_800_000 }));
    assert.equal(quality.coverage.timeoutMs, 1_800_000);
  });

  it('defaults to 600000 when unset', () => {
    assert.equal(COVERAGE_GATE_DEFAULTS.timeoutMs, 600_000);
    assert.equal(getQuality({}).coverage.timeoutMs, 600_000);
    assert.equal(
      getQuality(withCoverage({ enabled: true })).coverage.timeoutMs,
      600_000,
    );
  });

  it('draws no unknown-key warning', () => {
    getQuality(withCoverage({ timeoutMs: 900_000 }));
    assert.deepEqual(
      warnings.filter((w) => w.includes('timeoutMs')),
      [],
    );
  });
});
