import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getLifecycle,
  LIFECYCLE_DEFAULTS,
} from '../../.agents/scripts/lib/config/lifecycle.js';

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.agents/full-agentrc.json', import.meta.url),
);

describe('LIFECYCLE_DEFAULTS', () => {
  it('getLifecycle with no config returns the framework defaults', () => {
    const lc = getLifecycle({});
    assert.deepEqual(lc.timeouts, { ...LIFECYCLE_DEFAULTS.timeouts });
    assert.equal(
      lc.heartbeatWarnSeconds,
      LIFECYCLE_DEFAULTS.heartbeatWarnSeconds,
    );
  });

  it('user-supplied timeout keys overlay the defaults', () => {
    const lc = getLifecycle({
      lifecycle: { timeouts: { 'epic.finalize': 300 } },
    });
    assert.equal(lc.timeouts['epic.finalize'], 300);
    assert.equal(
      lc.timeouts['epic.watch'],
      LIFECYCLE_DEFAULTS.timeouts['epic.watch'],
    );
  });

  it('user-supplied heartbeatWarnSeconds overrides the default', () => {
    const lc = getLifecycle({ lifecycle: { heartbeatWarnSeconds: 120 } });
    assert.equal(lc.heartbeatWarnSeconds, 120);
  });

  it('ignores non-integer heartbeatWarnSeconds and falls back to default', () => {
    const lc = getLifecycle({ lifecycle: { heartbeatWarnSeconds: 'bad' } });
    assert.equal(
      lc.heartbeatWarnSeconds,
      LIFECYCLE_DEFAULTS.heartbeatWarnSeconds,
    );
  });
});

describe('full-agentrc.json ↔ LIFECYCLE_DEFAULTS drift guard', () => {
  const parsed = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));

  it('declares delivery.lifecycle.heartbeatWarnSeconds matching LIFECYCLE_DEFAULTS', () => {
    assert.equal(
      parsed?.delivery?.lifecycle?.heartbeatWarnSeconds,
      LIFECYCLE_DEFAULTS.heartbeatWarnSeconds,
    );
  });

  it('declares delivery.lifecycle.timeouts matching LIFECYCLE_DEFAULTS', () => {
    assert.deepEqual(parsed?.delivery?.lifecycle?.timeouts, {
      ...LIFECYCLE_DEFAULTS.timeouts,
    });
  });
});
