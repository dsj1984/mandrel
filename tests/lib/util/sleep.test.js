import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultSleep,
  sleepSync,
} from '../../../.agents/scripts/lib/util/sleep.js';

describe('sleep', () => {
  it('defaultSleep resolves after the delay', async () => {
    assert.equal(await defaultSleep(1), undefined);
  });

  it('sleepSync blocks for a positive delay', () => {
    const start = Date.now();
    sleepSync(20);
    assert.ok(Date.now() - start >= 15);
  });

  it('sleepSync returns at once for a non-finite or non-positive delay', () => {
    const start = Date.now();
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      sleepSync(ms);
    }
    assert.ok(Date.now() - start < 1000);
  });
});
