// tests/delivery-routing-config.test.js
//
// Unit tier: the `delivery.routing` accessor mirrors the framework-defaults
// pattern of `lib/config/ci.js#getCiDelivery`. Stage 6 dropped
// `singleDelivery`; Story #5313 dropped `freshCriticSampleRate`. These tests
// pin role-scoped agents, the ceremony profile, and the retired keys' absence.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DELIVERY_ROUTING_DEFAULTS,
  getDeliveryRouting,
} from '../.agents/scripts/lib/config/delivery-routing.js';

describe('getDeliveryRouting — defaults', () => {
  test('does not expose the retired singleDelivery kill-switch', () => {
    assert.equal('singleDelivery' in getDeliveryRouting({}), false);
    assert.equal('singleDelivery' in DELIVERY_ROUTING_DEFAULTS, false);
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

describe('getDeliveryRouting — freshCriticSampleRate is retired (Story #5313)', () => {
  test('the accessor exposes no sampling rate and the defaults carry none', () => {
    assert.equal('freshCriticSampleRate' in getDeliveryRouting({}), false);
    assert.equal('freshCriticSampleRate' in DELIVERY_ROUTING_DEFAULTS, false);
  });

  test('a leftover rate in the config is ignored, not resolved', () => {
    const routing = getDeliveryRouting({
      delivery: { routing: { freshCriticSampleRate: 0.5 } },
    });
    assert.equal('freshCriticSampleRate' in routing, false);
    assert.equal(routing.ceremonyProfile, 'standard');
  });
});
