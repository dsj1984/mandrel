// tests/deliver-route.test.js
//
// Unit tier (Epic #4475, M4-A): the deliver-side reader for the plan-time
// single-delivery seam. `resolveEpicDeliveryRoute` and `computeReadyWidth` are
// pure — inputs in, verdict out, no I/O. These tests pin the full routing
// matrix (single-label / decompose.shape / fan-out / legacy / kill-switch),
// both `computeReadyWidth` input shapes, and — the behavior-preserving proof —
// that a `single` verdict is currently just a route string the router consumes
// via a fall-through stub (the reader itself changes nothing).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  computeReadyWidth,
  DELIVERY_SINGLE_LABEL,
  resolveEpicDeliveryRoute,
} from '../.agents/scripts/lib/orchestration/deliver-route.js';

const singleEnabled = { delivery: { routing: { singleDelivery: true } } };
const killSwitch = { delivery: { routing: { singleDelivery: false } } };

describe('resolveEpicDeliveryRoute — single markers', () => {
  test('delivery::single label (string labels) → single', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: [DELIVERY_SINGLE_LABEL, 'type::epic'] },
      null,
      singleEnabled,
    );
    assert.equal(r.route, 'single');
    assert.equal(r.singleDeliveryEnabled, true);
  });

  test('delivery::single label ({ name } object labels) → single', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: [{ name: 'type::epic' }, { name: DELIVERY_SINGLE_LABEL }] },
      null,
      singleEnabled,
    );
    assert.equal(r.route, 'single');
  });

  test('decompose.shape === "single" (no label) → single', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic'] },
      { decompose: { ticketCount: 0, shape: 'single' } },
      singleEnabled,
    );
    assert.equal(r.route, 'single');
    assert.match(r.reason, /decompose\.shape/);
  });

  test('label + checkpoint both single → single (reason names both)', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: [DELIVERY_SINGLE_LABEL] },
      { decompose: { shape: 'single' } },
      singleEnabled,
    );
    assert.equal(r.route, 'single');
    assert.match(r.reason, /label/);
    assert.match(r.reason, /decompose\.shape/);
  });
});

describe('resolveEpicDeliveryRoute — fan-out fallbacks', () => {
  test('fan-out-shaped checkpoint, no label → fan-out', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic'] },
      { decompose: { ticketCount: 4, shape: 'fan-out' } },
      singleEnabled,
    );
    assert.equal(r.route, 'fan-out');
  });

  test('legacy Epic (no marker, null checkpoint) → fan-out', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic'] },
      null,
      singleEnabled,
    );
    assert.equal(r.route, 'fan-out');
    assert.match(r.reason, /legacy|no single marker/i);
  });

  test('malformed epic / checkpoint degrade to fan-out (never throws)', () => {
    assert.equal(
      resolveEpicDeliveryRoute(undefined, undefined, undefined).route,
      'fan-out',
    );
    assert.equal(resolveEpicDeliveryRoute({}, {}, {}).route, 'fan-out');
  });
});

describe('resolveEpicDeliveryRoute — kill-switch overrides all', () => {
  test('kill-switch forces fan-out even with delivery::single label', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: [DELIVERY_SINGLE_LABEL] },
      { decompose: { shape: 'single' } },
      killSwitch,
    );
    assert.equal(r.route, 'fan-out');
    assert.equal(r.singleDeliveryEnabled, false);
    assert.match(r.reason, /kill-switch/);
  });

  test('kill-switch forces fan-out even with single decompose shape', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: ['type::epic'] },
      { decompose: { shape: 'single' } },
      killSwitch,
    );
    assert.equal(r.route, 'fan-out');
  });

  test('default (no routing config) leaves single enabled', () => {
    const r = resolveEpicDeliveryRoute(
      { labels: [DELIVERY_SINGLE_LABEL] },
      null,
      {},
    );
    assert.equal(r.route, 'single');
    assert.equal(r.singleDeliveryEnabled, true);
  });
});

describe('resolveEpicDeliveryRoute — behavior-preserving proof (M4-A)', () => {
  test('a single-labelled Epic resolves to the single route string, which the router consumes via the fall-through stub (deliver-epic.md fan-out)', () => {
    // The reader emits `single`; the deliver.md router's M4-A stub dispatches
    // that verdict to deliver-epic.md (fan-out) unchanged. The proof that
    // nothing observably changes lives in the router prose + this contract:
    // resolveEpicDeliveryRoute is a pure verdict, it performs no dispatch.
    const r = resolveEpicDeliveryRoute(
      { labels: [DELIVERY_SINGLE_LABEL] },
      null,
      singleEnabled,
    );
    assert.equal(r.route, 'single');
    // No side effects: calling twice yields an identical verdict.
    assert.deepEqual(
      r,
      resolveEpicDeliveryRoute(
        { labels: [DELIVERY_SINGLE_LABEL] },
        null,
        singleEnabled,
      ),
    );
  });
});

describe('computeReadyWidth — Delivery-Slicing rows', () => {
  test('all Independent: No → width 1 (serial chain)', () => {
    assert.equal(
      computeReadyWidth([
        { slice: 'A', independent: false },
        { slice: 'B', independent: false },
        { slice: 'C', independent: false },
      ]),
      1,
    );
  });

  test('a lone independent slice → width 1', () => {
    assert.equal(
      computeReadyWidth([
        { slice: 'A', independent: true },
        { slice: 'B', independent: false },
      ]),
      1,
    );
  });

  test('two or more independent slices → width equals independent count (> 1)', () => {
    assert.equal(
      computeReadyWidth([
        { slice: 'A', independent: true },
        { slice: 'B', independent: true },
        { slice: 'C', independent: false },
      ]),
      2,
    );
    assert.equal(
      computeReadyWidth([
        { independent: true },
        { independent: true },
        { independent: true },
      ]),
      3,
    );
  });
});

describe('computeReadyWidth — wave DAG', () => {
  test('width is the largest wave', () => {
    assert.equal(computeReadyWidth([[1], [2, 3, 4], [5, 6]]), 3);
  });

  test('a serial chain of single-Story waves → width 1', () => {
    assert.equal(computeReadyWidth([[1], [2], [3]]), 1);
  });
});

describe('computeReadyWidth — degenerate inputs', () => {
  test('empty / null / undefined / non-array → width 1', () => {
    assert.equal(computeReadyWidth([]), 1);
    assert.equal(computeReadyWidth(null), 1);
    assert.equal(computeReadyWidth(undefined), 1);
    assert.equal(computeReadyWidth('nope'), 1);
  });
});
