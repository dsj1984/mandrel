// tests/delivery-routing-config.test.js
//
// Unit tier (Epic #4475, M4-A): the `delivery.routing` accessor mirrors the
// framework-defaults pattern of `lib/config/ci.js#getCiDelivery`. These tests
// pin the default-on kill-switch and the tolerant unwrap of the three config
// shapes callers may hold.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DELIVERY_ROUTING_DEFAULTS,
  getDeliveryRouting,
} from '../.agents/scripts/lib/config/delivery-routing.js';

describe('getDeliveryRouting — defaults', () => {
  test('singleDelivery defaults to true when unset', () => {
    assert.equal(getDeliveryRouting({}).singleDelivery, true);
    assert.equal(getDeliveryRouting(null).singleDelivery, true);
    assert.equal(getDeliveryRouting(undefined).singleDelivery, true);
    assert.equal(DELIVERY_ROUTING_DEFAULTS.singleDelivery, true);
  });

  test('a non-boolean value falls back to the default', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { singleDelivery: 'no' } } })
        .singleDelivery,
      true,
    );
  });
});

describe('getDeliveryRouting — explicit values + shape unwrap', () => {
  test('reads false from the full resolved-config shape (the kill-switch)', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { singleDelivery: false } } })
        .singleDelivery,
      false,
    );
  });

  test('reads the bare delivery bag', () => {
    assert.equal(
      getDeliveryRouting({ routing: { singleDelivery: false } }).singleDelivery,
      false,
    );
  });

  test('reads the bare routing bag', () => {
    assert.equal(
      getDeliveryRouting({ singleDelivery: false }).singleDelivery,
      false,
    );
  });
});
