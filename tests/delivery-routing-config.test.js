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

describe('getDeliveryRouting — roleScopedAgents (Epic #4478, M7-B)', () => {
  test('roleScopedAgents defaults to TRUE when unset', () => {
    assert.equal(getDeliveryRouting({}).roleScopedAgents, true);
    assert.equal(getDeliveryRouting(null).roleScopedAgents, true);
    assert.equal(getDeliveryRouting(undefined).roleScopedAgents, true);
    assert.equal(DELIVERY_ROUTING_DEFAULTS.roleScopedAgents, true);
  });

  test('a non-boolean roleScopedAgents falls back to the default', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { roleScopedAgents: 'yes' } } })
        .roleScopedAgents,
      true,
    );
  });

  test('reads false — the kill-switch (falls back to general-purpose)', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { roleScopedAgents: false } } })
        .roleScopedAgents,
      false,
    );
    // Tolerant unwrap across all three shapes, mirroring singleDelivery.
    assert.equal(
      getDeliveryRouting({ routing: { roleScopedAgents: false } })
        .roleScopedAgents,
      false,
    );
    assert.equal(
      getDeliveryRouting({ roleScopedAgents: false }).roleScopedAgents,
      false,
    );
  });
});

describe('getDeliveryRouting — freshCriticSampleRate (M7-B floor)', () => {
  test('defaults to 0.2 when unset', () => {
    assert.equal(getDeliveryRouting({}).freshCriticSampleRate, 0.2);
    assert.equal(DELIVERY_ROUTING_DEFAULTS.freshCriticSampleRate, 0.2);
  });

  test('reads an explicit in-range rate', () => {
    assert.equal(
      getDeliveryRouting({
        delivery: { routing: { freshCriticSampleRate: 0.5 } },
      }).freshCriticSampleRate,
      0.5,
    );
    assert.equal(
      getDeliveryRouting({ routing: { freshCriticSampleRate: 0 } })
        .freshCriticSampleRate,
      0,
    );
  });

  test('clamps out-of-range and coerces non-numbers to the default', () => {
    assert.equal(
      getDeliveryRouting({ routing: { freshCriticSampleRate: -3 } })
        .freshCriticSampleRate,
      0,
    );
    assert.equal(
      getDeliveryRouting({ routing: { freshCriticSampleRate: 42 } })
        .freshCriticSampleRate,
      1,
    );
    assert.equal(
      getDeliveryRouting({ routing: { freshCriticSampleRate: 'lots' } })
        .freshCriticSampleRate,
      0.2,
    );
    assert.equal(
      getDeliveryRouting({ routing: { freshCriticSampleRate: Number.NaN } })
        .freshCriticSampleRate,
      0.2,
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
