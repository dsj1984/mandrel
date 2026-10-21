/**
 * Property tests for `concurrentMap` (Story #5806).
 *
 * `fc.scheduler()` owns every completion order, so the in-flight ceiling and
 * stop-on-first-error are proven over arbitrary interleavings rather than
 * whatever order wall-clock timers happened to produce on a quiet host. The
 * example tests in `concurrent-map.test.js` stay as readable specimens.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { concurrentMap } from '../../../.agents/scripts/lib/util/concurrent-map.js';
import { fcParams } from '../../helpers/fast-check-config.js';

const double = (item) => item * 2;

/** Items, each paired with whether its mapper call rejects. */
const itemsArb = fc.array(
  fc.record({ value: fc.integer(), fails: fc.boolean() }),
  { maxLength: 20 },
);

/**
 * Run `concurrentMap` with a mapper whose every completion the scheduler
 * releases, recording dispatch, peak in-flight and rejection order.
 */
async function runScheduled(s, items, concurrency) {
  const trace = {
    dispatched: [],
    inFlight: 0,
    peak: 0,
    rejections: [],
    dispatchedAtFirstRejection: null,
  };
  const mapper = (item, idx) => {
    trace.dispatched.push(idx);
    trace.inFlight++;
    trace.peak = Math.max(trace.peak, trace.inFlight);
    return s.schedule(Promise.resolve(), `item ${idx}`).then(() => {
      trace.inFlight--;
      if (!item.fails) return double(item.value);
      const err = new Error(`item ${idx} failed`);
      if (trace.rejections.length === 0) {
        trace.dispatchedAtFirstRejection = trace.dispatched.length;
      }
      trace.rejections.push(err);
      throw err;
    });
  };
  const outcome = concurrentMap(items, mapper, { concurrency }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  return { trace, settled: await s.waitFor(outcome) };
}

describe('concurrentMap — scheduler properties', () => {
  it('all-success runs return mapper(items[i]) at index i under any interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.integer(), { maxLength: 20 }),
        fc.integer({ min: 1, max: 8 }),
        async (s, values, concurrency) => {
          const items = values.map((value) => ({ value, fails: false }));
          const { settled } = await runScheduled(s, items, concurrency);
          assert.equal(settled.ok, true);
          assert.deepEqual(settled.value, values.map(double));
        },
      ),
      fcParams(),
    );
  });

  it('peak in-flight never exceeds `concurrency`', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        itemsArb,
        fc.integer({ min: 1, max: 8 }),
        async (s, items, concurrency) => {
          const { trace } = await runScheduled(s, items, concurrency);
          assert.ok(
            trace.peak <= concurrency,
            `peak ${trace.peak} > concurrency ${concurrency}`,
          );
        },
      ),
      fcParams(),
    );
  });

  it('a concurrency below 1 clamps to serial and still maps every item', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 10 }),
        fc.oneof(
          fc.integer({ min: -3, max: 0 }),
          fc.double({ min: 0, max: 0.99, noNaN: true }),
        ),
        async (s, values, concurrency) => {
          const items = values.map((value) => ({ value, fails: false }));
          const { trace, settled } = await runScheduled(s, items, concurrency);
          assert.equal(trace.peak, 1);
          assert.equal(settled.ok, true);
          assert.deepEqual(settled.value, values.map(double));
        },
      ),
      fcParams(),
    );
  });

  it('after the first rejection nothing new dispatches, and that rejection surfaces', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        itemsArb.filter((items) => items.some((item) => item.fails)),
        fc.integer({ min: 1, max: 8 }),
        async (s, items, concurrency) => {
          const { trace, settled } = await runScheduled(s, items, concurrency);
          assert.equal(settled.ok, false);
          assert.equal(settled.error, trace.rejections[0]);
          assert.equal(
            trace.dispatched.length,
            trace.dispatchedAtFirstRejection,
            `dispatched ${trace.dispatched.join(',')} after the first rejection`,
          );
        },
      ),
      fcParams(),
    );
  });
});
